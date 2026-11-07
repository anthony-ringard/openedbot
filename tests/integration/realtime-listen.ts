/**
 * S6 (ADR 0001, sections 4.6 and 5): one LISTEN connection per API process.
 *
 *  1. Two API instances (two HTTP servers, two EventHubs, two LISTEN
 *     connections, two pools) on one database: an event the worker commits
 *     reaches the SSE clients of BOTH in under a second, whichever instance
 *     the worker's HTTP hint targets; an event the API writes as well.
 *  2. The LISTEN connections are cut (`pg_terminate_backend`, the TCP gate
 *     held closed): what commits meanwhile is not delivered, then read back
 *     from the durable cursor at the resubscription, without loss or duplicate.
 *  3. LISTEN unavailable at startup: no crash, the failure is logged, the
 *     fallback poll serves, and the link subscribes once the database answers.
 *
 * The fallback poll is one minute in 1 and 2: only LISTEN can meet the bounds.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { SQL } from "bun";
import { Hono } from "hono";
import { connect, createServer, type Server, type Socket } from "node:net";
import { createTestLogger, type LogRecord } from "../../platform/observability/src/logger";
import { withTenant, type Db } from "../../platform/db/src/db";
import { EventHub } from "../../modules/notifications/src/application/event-hub";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { persistEvents } from "../../modules/execution/src/application/runner";
import { flushDeferredWake } from "../../modules/execution/src/application/runner/events";
import { appendRunEventsTx } from "../../modules/execution/src/sql/run-events";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import { eventRoutes, internalEventRoutes } from "../../apps/api/src/routes/events/event-routes";
import { createEventRealtime, replayPollerCount } from "../../apps/api/src/routes/events/replay-pollers";
import { withDisposablePostgres } from "./disposable-postgres";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, label: string, limitMs = 3_000): Promise<void> {
  const deadline = performance.now() + limitMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(5);
  }
}
// LISTEN needs Bun >= 1.4 (`sql.listen`): say so at once rather than on a
// barrier timeout. The probe client never connects (Bun connects lazily).
{
  const probe = new SQL({ url: "postgres://127.0.0.1:1/probe", max: 1 });
  const hasListen = typeof (probe as { listen?: unknown }).listen === "function";
  await probe.close().catch(() => undefined);
  if (!hasListen) throw new Error(`Bun ${Bun.version} has no sql.listen: this proof needs the pinned Bun (packageManager).`);
}
process.on("unhandledRejection", (error) => { console.error("unhandled rejection", error); process.exit(1); });

/** A loopback TCP relay in front of PostgreSQL, on a fixed port, that can refuse connections. */
class TcpGate {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  constructor(private readonly upstream: URL) {}
  async open(): Promise<void> {
    const server = createServer((client) => {
      const upstream = connect(Number(this.upstream.port), this.upstream.hostname);
      this.sockets.add(client); this.sockets.add(upstream);
      client.pipe(upstream); upstream.pipe(client);
      const end = () => { client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream); };
      for (const socket of [client, upstream]) { socket.on("close", end); socket.on("error", end); }
    });
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    this.port = (server.address() as { port: number }).port;
    this.server = server;
  }
  /**
   * Stops accepting; established relays are left to the caller to cut. The
   * listening socket is released at once (`close`'s callback would wait for
   * every relay to end).
   */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    server?.close();
    await sleep(0);
  }
  async destroy(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await this.close();
  }
  url(): string {
    const url = new URL(this.upstream);
    url.hostname = "127.0.0.1"; url.port = String(this.port);
    return url.toString();
  }
}

type Frame = { at: number; id: number | null; event: string; data: Record<string, unknown> };

/** Reads an SSE response in the background; every data frame is kept with its arrival time. */
function collect(response: Response) {
  assert(response.status === 200 && response.body, `SSE status ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let text = "";
  const done = (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
      text += decoder.decode(chunk.value, { stream: true });
      for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n")) {
        const lines = text.slice(0, end).split("\n");
        text = text.slice(end + 2);
        const field = (name: string) => lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
        const data = field("data");
        if (data === undefined) continue;
        const id = field("id");
        frames.push({ at: performance.now(), id: id === undefined ? null : Number(id), event: field("event") ?? "", data: JSON.parse(data) });
      }
    }
  })();
  return { frames, close: async () => { await reader.cancel().catch(() => undefined); await done; } };
}

type Instance = Awaited<ReturnType<typeof startInstance>>;

async function startInstance(options: {
  name: string; apiDb: Db; listenUrl: string; fallbackPollMs: number; internalToken: string; organizationId: string;
}) {
  const hub = new EventHub();
  const { logger, records } = createTestLogger();
  const link = createEventRealtime(options.apiDb, options.listenUrl, hub, { livenessMs: 150, retryMs: 50, maxRetryMs: 200, log: logger });
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("/api/*", async (context, next) => {
    context.set("auth", { organizationId: options.organizationId } as AppVariables["auth"]);
    await next();
  });
  app.route("/api/events", eventRoutes(options.apiDb, hub, {
    // Two: a connection that carried a frame live advances its cursor at the
    // commit (half the window), not at the heartbeat, so A's delivery is visible.
    fallbackPollMs: options.fallbackPollMs, replayWindowMs: 3_600_000, replayWindowEvents: 2,
  }));
  app.route("/internal/events", internalEventRoutes(options.apiDb, testInternalSecrets("api", options.internalToken),
    hub, undefined, () => !link.connected()));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch });
  link.start();
  const streams: Array<ReturnType<typeof collect>> = [];
  return {
    name: options.name, hub, link, records, url: server.url.toString().replace(/\/$/u, ""),
    async open(cursor = 0) {
      const stream = collect(await fetch(`${this.url}/api/events?cursor=${cursor}`, { headers: { Accept: "text/event-stream" } }));
      streams.push(stream);
      // The ordered read is acquired once the connection's own replay is over.
      await until(() => replayPollerCount(hub) === 1, `${options.name} SSE poller`);
      return stream;
    },
    async stop() {
      for (const stream of streams) await stream.close();
      await link.stop();
      server.stop(true);
    },
  };
}

const logged = (records: LogRecord[], event: string, extra: Record<string, unknown> = {}) =>
  records.some((record) => record.event === event && Object.entries(extra).every(([key, value]) => record[key] === value));

await withDisposablePostgres("openedbot600_realtime", async ({ owner, url, connect: open }) => {
  const trigger = await owner<Array<{ enabled: string }>>`select tgenabled as enabled from pg_trigger where tgname = 'run_events_notify'`;
  assert(trigger[0]?.enabled === "O", "The 0005 run_events_notify trigger must exist and be enabled.");
  const organizationId = crypto.randomUUID();
  const [sectionId, botId, threadId, runId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const workerId = `openedbot600-${crypto.randomUUID()}`;
  const sessionId = `openedbot600-session-${crypto.randomUUID()}`;
  const leaseGeneration = 4;
  await owner`insert into organizations (id, slug, name) values (${organizationId}, ${`rt-${organizationId.slice(0, 8)}`}, 'Realtime')`;
  await owner`insert into sections (id, organization_id, name, position) values (${sectionId}, ${organizationId}, 'Realtime', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${botId}, ${organizationId}, ${sectionId}, 'Realtime', 'realtime', 0)`;
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${threadId}, ${organizationId}, ${botId}, 'Realtime', ${sessionId}, true)`;
  await owner`insert into runs (
      id, organization_id, thread_id, bot_id, input, status, started_at, heartbeat_at,
      lease_owner, lease_expires_at, lease_generation, external_state, step_index, step_kind, execution_session_key
    ) values (
      ${runId}, ${organizationId}, ${threadId}, ${botId}, 'realtime', 'running', now(), now(),
      ${workerId}, now() + interval '5 minutes', ${leaseGeneration}, 'streaming', 0, 'root', ${sessionId}
    )`;
  const workerDb = await open("openedbot_worker");
  await workerDb`select set_config('app.organization_id', ${organizationId}, false)`;
  const internalToken = `integration-${crypto.randomUUID()}`;
  const target = { organizationId, threadId, runId, leaseGeneration };
  /** The worker's own write path, with no HTTP hint at all. */
  const workerAppend = async (count: number, label: string) => workerDb.begin(async (tx) =>
    appendRunEventsTx(tx as unknown as SQL, Array.from({ length: count }, (_, index) => ({
      ...target, type: "system.notice", payload: { label: `${label}-${index}` },
    }))));
  const durable = (stream: ReturnType<typeof collect>, from: number) =>
    stream.frames.filter((frame) => frame.id !== null && frame.id > from);

  const gate = new TcpGate(new URL(url));
  await gate.open();
  const instances: Instance[] = [];
  try {
    // 1. Two replicas.
    const a = await startInstance({ name: "a", apiDb: await open("openedbot_api") as unknown as Db, listenUrl: gate.url(),
      fallbackPollMs: 60_000, internalToken, organizationId });
    const b = await startInstance({ name: "b", apiDb: await open("openedbot_api") as unknown as Db, listenUrl: gate.url(),
      fallbackPollMs: 60_000, internalToken, organizationId });
    instances.push(a, b);
    await until(() => a.link.connected() && b.link.connected(), "both LISTEN links");
    const listeners = await owner<Array<{ pid: number }>>`select pid from pg_stat_activity
      where datname = current_database() and query like 'LISTEN%' and position('openedbot_events' in query) > 0`;
    assert(listeners.length === 2, `One LISTEN connection per instance, got ${listeners.length}.`);
    const streamA = await a.open();
    const streamB = await b.open();

    // 1a. A streamed delta: pre-commit to A only (the worker's single URL), committed for everyone.
    const context = {
      id: runId, organizationId, threadId, botId, sessionId, leaseGeneration, workflowId: null, workflowRootRunId: null,
      stepKind: "root", groupTurnPosition: null, groupId: null, groupState: null, originRunId: null,
    };
    const workerConfig = { workerId, apiInternalUrl: a.url, internalSecrets: testInternalSecrets("worker", internalToken)} as WorkerConfig;
    const deltaStart = performance.now();
    await persistEvents(workerDb, workerConfig, context as never, 1, [
      { sequence: 1, type: "agent.message", payload: { delta: "bonjour" }, occurredAt: new Date() },
    ] as never[]);
    const deltaCommitted = performance.now();
    const [deltaRow] = await owner<Array<{ cursor: string }>>`select cursor::text from run_events where run_id = ${runId} and sequence = 1`;
    const deltaCursor = Number(deltaRow!.cursor);
    await until(() => durable(streamB, 0).length >= 1 && durable(streamA, 0).length >= 1, "1a: committed delta on A and B", 1_000);
    const deltaOnB = durable(streamB, 0)[0]!;
    const deltaOnA = durable(streamA, 0)[0]!;
    assert(deltaOnB.id === deltaCursor && deltaOnB.event === "agent.message", "B receives the committed delta itself.");
    assert(deltaOnA.id === deltaCursor && deltaOnA.event === "stream.cursor", "A, which carried it live, only advances its cursor.");
    assert(streamA.frames.some((frame) => frame.id === null && frame.event === "agent.message"), "A got the pre-commit frame.");
    assert(!streamB.frames.some((frame) => frame.id === null), "B never sees the pre-commit HTTP frame: its delta comes from LISTEN.");
    await flushDeferredWake(workerConfig, runId);

    // 1b. An API-side write (cancellation, message version…): no HTTP hint exists at all.
    const apiDb = await open("openedbot_api") as unknown as Db;
    const apiStart = performance.now();
    const [apiEvent] = await withTenant(apiDb, organizationId, (tx) => appendRunEventsTx(tx as unknown as SQL, [
      { ...target, type: "system.notice", payload: { origin: "api" } },
    ]));
    const apiCommitted = performance.now();
    await until(() => durable(streamA, deltaCursor).length >= 1 && durable(streamB, deltaCursor).length >= 1, "1b: API write on A and B", 1_000);
    for (const stream of [streamA, streamB]) assert(durable(stream, deltaCursor)[0]!.id === apiEvent!.cursor, "API write delivered");
    const latency = {
      deltaOnAMs: Math.round(deltaOnA.at - deltaCommitted), deltaOnBMs: Math.round(deltaOnB.at - deltaCommitted),
      deltaFromWriteStartOnBMs: Math.round(deltaOnB.at - deltaStart),
      apiWriteOnAMs: Math.round(durable(streamA, deltaCursor)[0]!.at - apiCommitted),
      apiWriteOnBMs: Math.round(durable(streamB, deltaCursor)[0]!.at - apiCommitted),
      apiWriteFromStartMs: Math.round(Math.max(...[streamA, streamB].map((s) => durable(s, deltaCursor)[0]!.at)) - apiStart),
    };
    console.info(JSON.stringify({ event: "openedbot600.two_replicas.passed", ...latency }));

    // 2. Cut both LISTEN connections and keep them down while the worker commits.
    const before = Number(apiEvent!.cursor);
    const resubscriptions = [a, b].map((instance) => instance.link.status().resubscriptions);
    await gate.close();
    const killed = await owner<Array<{ done: boolean }>>`select pg_terminate_backend(pid) as done from pg_stat_activity
      where datname = current_database() and query like 'LISTEN%' and position('openedbot_events' in query) > 0`;
    assert(killed.length === 2 && killed.every((row) => row.done), "Both LISTEN backends of this database are cut.");
    const written = await workerAppend(3, "during-cut");
    const cursors = written.map((event) => event.cursor!);
    await until(() => !a.link.connected() && !b.link.connected(), "the liveness ping notices the cut", 1_000);
    await sleep(300);
    for (const stream of [streamA, streamB]) assert(durable(stream, before).length === 0, "Nothing reaches a client while LISTEN is down.");
    const reopened = performance.now();
    await gate.open();
    await until(() => a.link.status().resubscriptions > resubscriptions[0]! && b.link.status().resubscriptions > resubscriptions[1]!,
      "both links resubscribe", 5_000);
    await until(() => durable(streamA, before).length >= 3 && durable(streamB, before).length >= 3, "catch-up from the durable cursor", 1_000);
    const caughtUpMs = Math.round(Math.max(...[streamA, streamB].map((s) => durable(s, before)[2]!.at)) - reopened);
    await sleep(300);
    for (const stream of [streamA, streamB]) {
      const ids = durable(stream, before).map((frame) => frame.id);
      assert(ids.join(",") === cursors.join(","), `Catch-up delivers each event once, in order: ${ids.join(",")} vs ${cursors.join(",")}`);
    }
    for (const instance of [a, b]) {
      assert(logged(instance.records, "api.events_listener_stalled"), `${instance.name} logs the unconfirmed link.`);
      assert(logged(instance.records, "api.events_listener_ready", { resubscribed: true }), `${instance.name} logs the resubscription.`);
    }
    const [after] = await workerAppend(1, "after-cut");
    await until(() => durable(streamA, cursors[2]!).length === 1 && durable(streamB, cursors[2]!).length === 1, "live again after resubscription", 1_000);
    assert(durable(streamB, cursors[2]!)[0]!.id === after!.cursor, "Live delivery resumes after resubscription.");
    console.info(JSON.stringify({ event: "openedbot600.listen_cut.passed", caughtUpMs, events: cursors.length,
      resubscriptions: [a, b].map((instance) => instance.link.status().resubscriptions),
      lagMs: [a, b].map((instance) => instance.link.status().lagMs) }));

    // 3. LISTEN unavailable at startup: the database behind this gate does not answer yet.
    const cold = new TcpGate(new URL(url));
    await cold.open();
    await cold.close();
    const c = await startInstance({ name: "c", apiDb: await open("openedbot_api") as unknown as Db, listenUrl: cold.url(),
      fallbackPollMs: 300, internalToken, organizationId });
    instances.push(c);
    try {
      await until(() => c.link.status().failures >= 2, "startup failures are retried", 2_000);
      assert(c.link.status().state === "unavailable" && !c.link.connected(), "The link reports itself unavailable.");
      assert(logged(c.records, "api.events_listener_failed", { fallback: "poll" }), "The fallback is logged.");
      const streamC = await c.open(after!.cursor!);
      const polledStart = performance.now();
      const [polled] = await workerAppend(1, "poll-only");
      await until(() => durable(streamC, after!.cursor!).length === 1, "the fallback poll serves without LISTEN", 2_000);
      assert(durable(streamC, after!.cursor!)[0]!.id === polled!.cursor, "Polled delivery is the durable event.");
      const polledMs = Math.round(durable(streamC, after!.cursor!)[0]!.at - polledStart);
      await cold.open();
      await until(() => c.link.connected(), "the link subscribes once the database answers", 3_000);
      assert(c.link.status().subscriptions === 1 && c.link.status().resubscriptions === 0, "A first subscription, not a resubscription.");
      assert(logged(c.records, "api.events_listener_ready", { resubscribed: false }), "The recovery is logged.");
      console.info(JSON.stringify({ event: "openedbot600.listen_unavailable.passed", failures: c.link.status().failures, polledMs }));
    } finally {
      await cold.destroy();
    }
  } finally {
    for (const instance of instances) await instance.stop();
    await gate.destroy();
  }
});
