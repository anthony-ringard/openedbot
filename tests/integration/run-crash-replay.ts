import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { SQL, type Server } from "bun";
import { EventHub } from "../../modules/notifications/src/application/event-hub";
import { acceptLiveEvent, createLiveDedupe } from "../../apps/console/src/lib/stream/thread-stream-live";
import { eventRoutes, internalEventRoutes } from "../../apps/api/src/routes/events/event-routes";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import type { Db } from "@openedbot/platform-db";
import { claimRun } from "../../modules/execution/src/application/queue";
import { executeRun, isRunEventsLeaseFence } from "../../modules/execution/src/application/runner";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { withDisposablePostgres } from "./disposable-postgres";
import { admitFixtureMessage, assertAdmittedMessageDurable } from "./admitted-message";

const CHILD_REPORT_PREFIX = "OPENEDBOT_TEST_115_CHILD ";
const FAKE_GATEWAY_TOKEN = `gateway-${crypto.randomUUID()}`;
const INTERNAL_WORKER_TOKEN = `internal-${crypto.randomUUID()}`;
const ORGANIZATION_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const SESSION_ROW_ID = crypto.randomUUID();
const SESSION_CREDENTIAL_HASH = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
const RUNTIME_ID = crypto.randomUUID();
const SECTION_ID = crypto.randomUUID();
const BOT_ID = crypto.randomUUID();
const THREAD_ID = crypto.randomUUID();
let RUN_ID = "";
const SESSION_ID = `session-${crypto.randomUUID()}`;
const USER_INPUT = "Crash replay identity fixture";
const FINAL_OUTPUT = "Recovered output after worker restart.";
const MAX_RUN_WAIT_MS = 25_000;
const MAX_SETUP_WAIT_MS = 15_000;
const STATUS_RECOVERY = process.env.OPENEDBOT_TEST_115_STATUS_RECOVERY === "1";

let currentPhase = "startup";

type ChildMode = "first" | "second";
type ChildReport = {
  phase: string;
  result: "claimed" | "completed" | "error";
  generation?: number;
  errorClass?: string;
};
type SseFrame = { id: string | null; event: string | null; data: Record<string, unknown> };
type HonoLikeContext = { set(key: "auth", value: AppVariables["auth"]): void };
type HonoLikeApp = {
  use(path: "*", handler: (context: HonoLikeContext, next: () => Promise<void>) => Promise<void>): void;
  route(path: string, app: HonoLikeApp): void;
  fetch(request: Request): Promise<Response>;
};
type RelayProof = {
  createPosts: number;
  createSessionIds: string[];
  hermesRunId: string | null;
  eventRequests: Array<{ hermesRunId: string; since: string | null; lastEventId: string | null }>;
  statusPolls: number;
  provisionalPublishes: number;
  firstFanoutMatchedRun: boolean;
  firstFanoutHeld: boolean;
  secondWorkerFallbackEnabled: boolean;
};

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, failure: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(failure)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(check: () => Promise<boolean> | boolean, milliseconds: number, failure: string): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error(failure);
}

function sseFrame(sequence: number, event: Record<string, unknown>): string {
  return `id: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`;
}

function eventResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }, timeoutMs: number): Promise<SseFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const separator = buffer.text.search(/\r?\n\r?\n/);
    if (separator >= 0) {
      const frameText = buffer.text.slice(0, separator);
      const separatorLength = buffer.text.slice(separator).startsWith("\r\n\r\n") ? 4 : 2;
      buffer.text = buffer.text.slice(separator + separatorLength);
      const lines = frameText.split(/\r?\n/);
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(data) as Record<string, unknown>; }
      catch { continue; }
      return {
        id: lines.find((line) => line.startsWith("id:"))?.slice(3).trim() ?? null,
        event: lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? null,
        data: payload,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("SSE frame timeout");
    const chunk = await withTimeout(reader.read(), remaining, "SSE frame timeout");
    if (chunk.done) throw new Error("SSE stream closed before the expected frame");
    buffer.text += new TextDecoder().decode(chunk.value, { stream: true });
  }
}

async function readUntilFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { text: string },
  frames: SseFrame[],
  predicate: (frame: SseFrame) => boolean,
  timeoutMs: number,
): Promise<SseFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = await readFrame(reader, buffer, Math.max(1, deadline - Date.now()));
    frames.push(frame);
    if (predicate(frame)) return frame;
  }
}

function asLiveIdentity(frame: SseFrame): Parameters<typeof acceptLiveEvent>[1] {
  const event = frame.data;
  return {
    organizationId: String(event.organizationId ?? ""),
    ...(typeof event.cursor === "number" ? { cursor: event.cursor } : {}),
    runId: String(event.runId ?? ""),
    sequence: Number(event.sequence),
  };
}

async function drainChildStream(stream: ReadableStream<Uint8Array> | null, captureReports: boolean): Promise<ChildReport[]> {
  if (!stream) return [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const reports: ChildReport[] = [];
  let buffered = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    buffered += decoder.decode(part.value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (captureReports && line.startsWith(CHILD_REPORT_PREFIX)) {
        try {
          const value = JSON.parse(line.slice(CHILD_REPORT_PREFIX.length)) as ChildReport;
          reports.push({
            phase: String(value.phase),
            result: value.result === "error" || value.result === "claimed" ? value.result : "completed",
            ...(typeof value.generation === "number" ? { generation: value.generation } : {}),
            ...(typeof value.errorClass === "string" ? { errorClass: value.errorClass } : {}),
          });
        } catch { /* ignore all non-status output, including worker diagnostics */ }
      }
      newline = buffered.indexOf("\n");
    }
    if (buffered.length > 8_192) buffered = buffered.slice(-2_048);
  }
  return reports;
}

function reportChild(value: ChildReport): void {
  process.stdout.write(`${CHILD_REPORT_PREFIX}${JSON.stringify(value)}\n`);
}

function childErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return ["Error", "TypeError", "PostgresError", "AbortError"].includes(error.name) ? error.name : "OtherError";
}

async function runChild(_mode: ChildMode): Promise<void> {
  let phase = "read-private-environment";
  let db: SQL | null = null;
  try {
    const databaseUrl = process.env.OPENEDBOT_TEST_115_DATABASE_URL;
    const apiInternalUrl = process.env.OPENEDBOT_TEST_115_API_INTERNAL_URL;
    const runtimeLinkUrl = process.env.OPENEDBOT_TEST_115_RUNTIME_LINK_URL;
    const internalToken = process.env.OPENEDBOT_TEST_115_INTERNAL_TOKEN;
    const workerId = process.env.OPENEDBOT_TEST_115_WORKER_ID;
    if (!databaseUrl || !apiInternalUrl || !runtimeLinkUrl || !internalToken || !workerId) {
      throw new Error("private child configuration unavailable");
    }
    phase = "connect-worker-database";
    db = new SQL({ url: databaseUrl, max: 1 });
    await db.unsafe("set role openedbot_worker");
    const workerConfig = {
      workerId,
      apiInternalUrl,
      runtimeLinkInternalUrl: runtimeLinkUrl,
      internalSecrets: testInternalSecrets("worker", internalToken),
      tokenEncryption: {} as WorkerConfig["tokenEncryption"],
      hermesMtls: null,
      hermesEndpointPolicy: {
        environment: "development",
        insecureOrigins: new Set([runtimeLinkUrl.replace(/^https?:\/\//, "")]),
      } as WorkerConfig["hermesEndpointPolicy"],
      leaseSeconds: 60,
      runInactivityMs: 15_000,
      runTimeoutMs: MAX_RUN_WAIT_MS,
      reconciliationTimeoutMs: 4_000,
      billingEnforced: false,
      cachedInputTokenWeight: 0,
      webAppUrl: "http://127.0.0.1:1420",
    } satisfies WorkerConfig;

    phase = "claim-run";
    const claimed = await claimRun(db, workerConfig);
    if (!claimed || claimed.id !== process.env.OPENEDBOT_TEST_115_RUN_ID) throw new Error("seeded run was not claimed");
    if (typeof claimed.leaseGeneration !== "number") throw new Error("claim lease generation was not normalized");
    reportChild({ phase: "claim-run", result: "claimed", generation: Number(claimed.leaseGeneration) });
    phase = "execute-run";
    await executeRun(db, workerConfig, claimed);
    reportChild({ phase: "execute-run", result: "completed", generation: Number(claimed.leaseGeneration) });
  } catch (error) {
    reportChild({ phase, result: "error", errorClass: childErrorClass(error) });
    process.exitCode = 1;
  } finally {
    await db?.close().catch(() => undefined);
  }
}

function spawnWorker(mode: ChildMode, values: Record<string, string>): {
  child: ReturnType<typeof Bun.spawn>;
  reports: Promise<ChildReport[]>;
} {
  const inherited = process.env;
  const env: Record<string, string> = {
    PATH: inherited.PATH ?? "",
    HOME: inherited.HOME ?? "/tmp",
    TMPDIR: inherited.TMPDIR ?? "/tmp",
    LANG: inherited.LANG ?? "C.UTF-8",
    OPENEDBOT_TEST_115_CHILD_MODE: mode,
    ...values,
  };
  const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), "--child", mode], {
    cwd: resolve(import.meta.dir, "../.."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutReports = drainChildStream(child.stdout, true);
  void drainChildStream(child.stderr, false);
  return { child, reports: stdoutReports };
}

async function parentMain(): Promise<void> {
  const previousGatewayToken = process.env.FAKE_HERMES_TOKEN;
  process.env.FAKE_HERMES_TOKEN = FAKE_GATEWAY_TOKEN;
  let fake: Server<undefined> | null = null;
  try {
    const { startFakeHermes } = await import("../fake-hermes/server");
    fake = startFakeHermes({ hostname: "127.0.0.1", port: 0, token: FAKE_GATEWAY_TOKEN, delayMs: 0 });
    const fakeOrigin = `http://127.0.0.1:${fake.port}`;
    const proof: RelayProof = {
      createPosts: 0,
      createSessionIds: [],
      hermesRunId: null,
      eventRequests: [],
      statusPolls: 0,
      provisionalPublishes: 0,
      firstFanoutMatchedRun: false,
      firstFanoutHeld: false,
      secondWorkerFallbackEnabled: false,
    };

    await withDisposablePostgres("openedbot115_crash", async ({ owner, url, connect }) => {
      const apiDb = await connect("openedbot_api");
      const observer = await connect();
      const workerOneId = `worker-${crypto.randomUUID()}`;
      const workerTwoId = `worker-${crypto.randomUUID()}`;
      const firstPublishObserved = deferred<void>();
      const releaseFirstPublish = deferred<void>();
      const secondPublishObserved = deferred<void>();
      const releaseSecondPublish = deferred<void>();
      const apiPublishFinished = deferred<void>();
      let apiServer: Server<undefined> | null = null;
      let relayServer: Server<undefined> | null = null;
      let sseAbort: AbortController | null = null;
      let sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let childOne: ReturnType<typeof Bun.spawn> | null = null;
      let childTwo: ReturnType<typeof Bun.spawn> | null = null;
      let childOneReports: Promise<ChildReport[]> | null = null;
      let childTwoReports: Promise<ChildReport[]> | null = null;
      let hostFrames: string[] = [];
      let hostJournalRunId: string | null = null;
      const hub = new EventHub();
      const eventBuffer = { text: "" };
      const sseFrames: SseFrame[] = [];
      const dedupe = createLiveDedupe();

      try {
        currentPhase = "seed-tenant-and-runtime";
        await owner.begin(async (tx) => {
          await tx`insert into organizations (id, slug, name)
            values (${ORGANIZATION_ID}, ${`crash-replay-${ORGANIZATION_ID}`}, 'Crash replay fixture')`;
          await tx`insert into users (id, email) values (${USER_ID}, ${`crash-replay-${USER_ID}@example.test`})`;
          await tx`insert into memberships (organization_id, user_id, role)
            values (${ORGANIZATION_ID}, ${USER_ID}, 'owner')`;
          await tx`insert into sessions (
              id, organization_id, user_id, kind, session_token_hash, access_token_hash, access_expires_at
            ) values (
              ${SESSION_ROW_ID}, ${ORGANIZATION_ID}, ${USER_ID}, 'web', ${SESSION_CREDENTIAL_HASH},
              ${SESSION_CREDENTIAL_HASH}, now() + interval '1 hour'
            )`;
          await tx`insert into sections (id, organization_id, name, position)
            values (${SECTION_ID}, ${ORGANIZATION_ID}, 'Crash replay', 0)`;
          await tx`insert into bots (id, organization_id, section_id, name, slug, model, reasoning_effort, position)
            values (${BOT_ID}, ${ORGANIZATION_ID}, ${SECTION_ID}, 'Crash replay bot', 'crash-replay-bot', 'fake/hermes', 'low', 0)`;
          await tx`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
            values (${THREAD_ID}, ${ORGANIZATION_ID}, ${BOT_ID}, 'Crash replay thread', ${SESSION_ID}, true)`;
          await tx`insert into runtimes (
              id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag,
              link_token_hash, link_connected_at, link_last_seen_at, is_active, selected_provider, selected_model,
              reasoning_effort
            ) values (
              ${RUNTIME_ID}, ${ORGANIZATION_ID}, 'Fresh crash replay connector', 'connector', null, null, null, null,
              ${crypto.randomUUID().replaceAll('-', '').padEnd(64, '0')}, now(), now(), true, 'fake', 'fake/hermes', 'low'
            )`;
        });

        currentPhase = "seed-fake-session";
        const fakeSession = await fetch(`${fakeOrigin}/api/sessions`, {
          method: "POST",
          headers: { authorization: `Bearer ${FAKE_GATEWAY_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ id: SESSION_ID, title: "Crash replay thread" }),
        });
        assert(fakeSession.status === 201, "fake gateway session setup failed");

        const auth = {
          sessionId: SESSION_ROW_ID,
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          role: "owner",
          kind: "web",
          credentialHash: SESSION_CREDENTIAL_HASH,
        } as AppVariables["auth"];
        currentPhase = "admit-user-message";
        const admitted = await admitFixtureMessage(apiDb as unknown as Db, auth, THREAD_ID, USER_INPUT);
        RUN_ID = admitted.runId;
        const messageIdentity = { organizationId: ORGANIZATION_ID, threadId: THREAD_ID, botId: BOT_ID, userId: USER_ID, input: USER_INPUT };
        await assertAdmittedMessageDurable(observer, admitted, messageIdentity);
        const apiRequire = createRequire(resolve(import.meta.dir, "../../apps/api/package.json"));
        const Hono = (apiRequire("hono") as { Hono: new () => HonoLikeApp }).Hono;
        const apiApp = new Hono();
        apiApp.use("*", async (context, next) => {
          context.set("auth", auth);
          await next();
        });
        apiApp.route("/internal/events", internalEventRoutes(
          apiDb as unknown as Db,
          testInternalSecrets("api", INTERNAL_WORKER_TOKEN),
          hub,
        ) as unknown as HonoLikeApp);
        apiApp.route("/", eventRoutes(apiDb as unknown as Db, hub, {
          fallbackPollMs: 30_000,
          replayWindowMs: 60_000,
          replayWindowEvents: 1_000,
        }) as unknown as HonoLikeApp);

        currentPhase = "start-real-api-and-relay";
        apiServer = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url);
            const publishCandidate = url.pathname === "/internal/events/publish" && request.method === "POST"
              ? await request.clone().json().catch(() => null) as Record<string, unknown> | null
              : null;
            const response = await apiApp.fetch(request);
            if (response.status === 204 && publishCandidate?.type === "agent.message"
              && publishCandidate.cursor == null && publishCandidate.runId === RUN_ID
              && !proof.firstFanoutHeld) {
              proof.provisionalPublishes += 1;
              proof.firstFanoutHeld = true;
              proof.firstFanoutMatchedRun = Number(publishCandidate.sequence) === 1
                && Number(publishCandidate.leaseGeneration) === 1;
              firstPublishObserved.resolve();
              await releaseFirstPublish.promise;
              apiPublishFinished.resolve();
            } else if (response.status === 204 && publishCandidate?.type === "agent.message"
              && publishCandidate.cursor == null) {
              proof.provisionalPublishes += 1;
              if (publishCandidate.runId === RUN_ID && Number(publishCandidate.leaseGeneration) === 2) {
                secondPublishObserved.resolve();
                await releaseSecondPublish.promise;
              }
            }
            return response;
          },
        });
        const apiOrigin = `http://127.0.0.1:${apiServer.port}`;

        relayServer = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url);
            const prefix = `/internal/runtime-links/${RUNTIME_ID}/proxy`;
            if (!url.pathname.startsWith(prefix)) return new Response(null, { status: 404 });
            if (request.headers.get("authorization") !== `Bearer ${INTERNAL_WORKER_TOKEN}`) {
              return new Response(null, { status: 401 });
            }
            const gatewayPath = url.pathname.slice(prefix.length) || "/";
            const eventMatch = /^\/v1\/runs\/([^/]+)\/events$/.exec(gatewayPath);
            if (eventMatch && request.method === "GET") {
              const hermesRunId = decodeURIComponent(eventMatch[1]!);
              proof.eventRequests.push({
                hermesRunId,
                since: url.searchParams.get("since"),
                lastEventId: request.headers.get("last-event-id"),
              });
              if (!hostJournalRunId) hostJournalRunId = hermesRunId;
              if (hermesRunId !== hostJournalRunId || hermesRunId !== proof.hermesRunId) {
                return new Response(null, { status: 409 });
              }
              if (proof.eventRequests.length === 1) {
                hostFrames = [
                  sseFrame(1, {
                    event: "message.delta", run_id: hermesRunId, timestamp: 1_791_113_000,
                    delta: "Recovered ",
                  }),
                  sseFrame(2, {
                    event: "message.delta", run_id: hermesRunId, timestamp: 1_791_113_001,
                    delta: "after crash.",
                  }),
                  sseFrame(3, {
                    event: "run.completed", run_id: hermesRunId, timestamp: 1_791_113_002,
                    output: FINAL_OUTPUT,
                    usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
                    messages: [{ role: "assistant", content: FINAL_OUTPUT }],
                  }),
                ];
                return new Response(new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode(hostFrames[0]!));
                  },
                }), {
                  headers: {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                  },
                });
              }
              if (proof.eventRequests.length !== 2 || url.searchParams.get("since") !== "0"
                || request.headers.get("last-event-id") !== "0") {
                return new Response(null, { status: 409 });
              }
              return eventResponse(hostFrames.join(""));
            }

            const statusMatch = /^\/v1\/runs\/([^/]+)$/.exec(gatewayPath);
            if (statusMatch && request.method === "GET" && proof.secondWorkerFallbackEnabled) {
              proof.statusPolls += 1;
              return Response.json({
                run_id: decodeURIComponent(statusMatch[1]!),
                status: "completed",
                output: FINAL_OUTPUT,
                usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
              });
            }

            let body: ArrayBuffer | undefined;
            let runInput: Record<string, unknown> | null = null;
            if (request.method !== "GET" && request.method !== "HEAD") {
              body = await request.arrayBuffer();
              if (gatewayPath === "/v1/runs" && request.method === "POST") {
                runInput = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
              }
            }
            const headers = new Headers(request.headers);
            headers.set("authorization", `Bearer ${FAKE_GATEWAY_TOKEN}`);
            headers.delete("host");
            const upstream = await fetch(`${fakeOrigin}${gatewayPath}${url.search}`, {
              method: request.method,
              headers,
              ...(body ? { body } : {}),
              redirect: "manual",
            });
            if (gatewayPath === "/v1/capabilities" && request.method === "GET" && upstream.ok) {
              const capabilities = await upstream.json() as Record<string, unknown>;
              const features = capabilities.features && typeof capabilities.features === "object"
                ? capabilities.features as Record<string, unknown>
                : {};
              return Response.json({ ...capabilities, features: { ...features, event_replay: !(STATUS_RECOVERY && proof.secondWorkerFallbackEnabled) } }, {
                status: upstream.status,
              });
            }
            if (gatewayPath === "/v1/runs" && request.method === "POST") {
              proof.createPosts += 1;
              if (typeof runInput?.session_id === "string") proof.createSessionIds.push(runInput.session_id);
              const created = await upstream.json().catch(() => ({})) as Record<string, unknown>;
              if (typeof created.run_id === "string") proof.hermesRunId = created.run_id;
              return Response.json(created, { status: upstream.status });
            }
            return upstream;
          },
        });
        const relayOrigin = `http://127.0.0.1:${relayServer.port}`;

        currentPhase = "open-real-api-sse";
        sseAbort = new AbortController();
        const sseResponse = await fetch(`${apiOrigin}/?cursor=0`, { signal: sseAbort.signal });
        assert(sseResponse.status === 200 && sseResponse.body, "real API SSE route did not open");
        sseReader = sseResponse.body.getReader();
        await waitUntil(() => hub.subscriberCount() > 0, MAX_SETUP_WAIT_MS, "real API SSE did not subscribe to EventHub");

        const childValues = (workerId: string): Record<string, string> => ({
          OPENEDBOT_TEST_115_DATABASE_URL: url,
          OPENEDBOT_TEST_115_API_INTERNAL_URL: apiOrigin,
          OPENEDBOT_TEST_115_RUNTIME_LINK_URL: relayOrigin,
          OPENEDBOT_TEST_115_INTERNAL_TOKEN: INTERNAL_WORKER_TOKEN,
          OPENEDBOT_TEST_115_WORKER_ID: workerId,
          OPENEDBOT_TEST_115_RUN_ID: RUN_ID,
        });

        currentPhase = "start-first-worker";
        const first = spawnWorker("first", childValues(workerOneId));
        childOne = first.child;
        childOneReports = first.reports;
        await withTimeout(firstPublishObserved.promise, MAX_SETUP_WAIT_MS, "first worker did not reach provisional API fanout");
        assert(proof.firstFanoutMatchedRun, "provisional fanout did not carry the expected run and lease identity");
        const firstLive = await readUntilFrame(
          sseReader,
          eventBuffer,
          sseFrames,
          (frame) => frame.data.type === "agent.message" && frame.data.runId === RUN_ID && Number(frame.data.sequence) === 1,
          MAX_SETUP_WAIT_MS,
        );
        assert(firstLive.id === null && firstLive.data.cursor == null, "first fanout unexpectedly had a durable SSE cursor");
        const admissionCursor = Math.max(0, ...sseFrames.map((frame) => Number(frame.data.cursor ?? 0)));
        const liveDecision = acceptLiveEvent(dedupe, asLiveIdentity(firstLive), ORGANIZATION_ID, admissionCursor);
        assert(liveDecision.deliver && liveDecision.streamCursor === admissionCursor, "first cursorless event was not deliverable after the admission receipt");

        currentPhase = "verify-precommit-state";
        await assertAdmittedMessageDurable(observer, admitted, messageIdentity);
        const beforeCrash = await observer<Array<{
          status: string;
          hermesRunId: string | null;
          watermark: number;
          generation: number;
          leaseOwner: string | null;
          runEvents: number;
        }>>`
          select run.status, run.hermes_run_id as "hermesRunId", run.last_hermes_sequence as watermark,
                 run.lease_generation::int as generation, run.lease_owner as "leaseOwner",
                 (select count(*)::int from run_events event
                   where event.organization_id = run.organization_id and event.run_id = run.id
                     and event.type <> 'message.admitted') as "runEvents"
            from runs run where run.organization_id = ${ORGANIZATION_ID} and run.id = ${RUN_ID}
        `;
        assert(beforeCrash[0]?.status === "running" && beforeCrash[0].leaseOwner === workerOneId, "first worker did not own the live run");
        assert(beforeCrash[0]?.hermesRunId !== null && beforeCrash[0]?.hermesRunId === proof.hermesRunId, "Hermes ID was not committed before the first event");
        assert(beforeCrash[0]?.watermark === 0 && beforeCrash[0]?.runEvents === 0, "the first event was committed before the crash gate");

        currentPhase = "kill-first-worker-before-commit";
        childOne.kill("SIGKILL");
        const firstExit = await withTimeout(childOne.exited, 5_000, "SIGKILL did not stop the first worker promptly");
        assert(typeof firstExit === "number", "first child did not report process exit");
        releaseFirstPublish.resolve();
        await withTimeout(apiPublishFinished.promise, 5_000, "held API publish response did not clean up");
        await childOneReports;
        childOne = null;

        currentPhase = "expire-and-reclaim-lease";
        await owner`update runs set lease_expires_at = now() - interval '1 second'
          where organization_id = ${ORGANIZATION_ID} and id = ${RUN_ID} and lease_generation = 1`;
        proof.secondWorkerFallbackEnabled = true;
        const second = spawnWorker("second", childValues(workerTwoId));
        childTwo = second.child;
        childTwoReports = second.reports;

        await waitUntil(async () => {
          const rows = await observer<Array<{ status: string; leaseOwner: string | null; generation: number; hermesRunId: string | null; watermark: number }>>`
            select status, lease_owner as "leaseOwner", lease_generation::int as generation,
                   hermes_run_id as "hermesRunId", last_hermes_sequence as watermark
              from runs where organization_id = ${ORGANIZATION_ID} and id = ${RUN_ID}
          `;
          return rows[0]?.leaseOwner === workerTwoId && rows[0]?.generation === 2;
        }, MAX_SETUP_WAIT_MS, "second worker did not acquire the expired run with a new generation");
        await withTimeout(secondPublishObserved.promise, MAX_SETUP_WAIT_MS, "second worker did not reach the active lease gate");

        currentPhase = "verify-stale-lease-rejection";
        const activeLease = await observer<Array<{ status: string; generation: number }>>`
          select status, lease_generation::int as generation from runs
           where organization_id = ${ORGANIZATION_ID} and id = ${RUN_ID}
        `;
        assert(activeLease[0]?.status === "running" && activeLease[0]?.generation === 2,
          "stale lease check did not run against an active second generation");
        const staleText = "Stale worker fixture delta.";
        let staleFanouts = 0;
        const unsubscribeStale = hub.subscribe(ORGANIZATION_ID, (event) => {
          if (event.type === "agent.message" && event.payload.text === staleText) staleFanouts += 1;
        });
        try {
          const stalePublish = await fetch(`${apiOrigin}/internal/events/publish`, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${INTERNAL_WORKER_TOKEN}` },
            body: JSON.stringify({ organizationId: ORGANIZATION_ID, threadId: THREAD_ID, runId: RUN_ID,
              botId: BOT_ID, turnId: RUN_ID, sessionKey: SESSION_ID, leaseGeneration: 1, sequence: 1,
              type: "agent.message", payload: { text: staleText }, occurredAt: new Date().toISOString() }),
          });
          assert(stalePublish.status === 204 && staleFanouts === 0, "API published a provisional delta from a stale lease");
        } finally { unsubscribeStale(); }
        const staleWorkerDb = await connect("openedbot_worker");
        let staleWriteRejected = false;
        try {
          await staleWorkerDb`insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at, lease_generation)
            values (${ORGANIZATION_ID}, ${THREAD_ID}, ${RUN_ID}, 99, 'agent.message', ${{ text: staleText }}, now(), 1)`;
        } catch (error) {
          staleWriteRejected = isRunEventsLeaseFence(error);
          if (!staleWriteRejected && error && typeof error === "object") {
            const fields = error as Record<string, unknown>;
            const safeField = (key: string) => typeof fields[key] === "string" && /^[A-Za-z0-9_]{1,64}$/.test(fields[key] as string) ? fields[key] : undefined;
            console.info(JSON.stringify({ test: "stale-lease-diagnostic", errorKeys: Object.keys(fields), code: safeField("code"), errno: safeField("errno"), constraint: safeField("constraint") }));
          }
        }
        assert(staleWriteRejected, "PostgreSQL stale lease rejection was not proven");
        releaseSecondPublish.resolve();

        currentPhase = "replay-from-zero-on-second-worker";
        await waitUntil(() => proof.eventRequests.length >= 2 || proof.statusPolls > 0,
          MAX_RUN_WAIT_MS, "second worker neither replayed the host journal nor used bounded status fallback");
        const secondExit = await withTimeout(childTwo.exited, MAX_RUN_WAIT_MS, "second worker did not finish the replay run");
        assert(secondExit === 0, "second worker exited unsuccessfully");
        const reports = await childTwoReports;
        assert(reports.some((entry) => entry.phase === "execute-run" && entry.result === "completed" && entry.generation === 2), "second child did not report a completed generation-two run");
        childTwo = null;

        currentPhase = "verify-durable-replay";
        await assertAdmittedMessageDurable(observer, admitted, messageIdentity);
        const finalRuns = await observer<Array<{
          status: string;
          hermesRunId: string | null;
          watermark: number;
          generation: number;
          externalState: string;
          eventsComplete: boolean;
          sessionKey: string | null;
        }>>`
          select run.status, run.hermes_run_id as "hermesRunId", run.last_hermes_sequence as watermark,
                 run.lease_generation::int as generation, run.external_state as "externalState",
                 run.events_complete as "eventsComplete", coalesce(run.execution_session_key, thread.hermes_session_id) as "sessionKey"
            from runs run join threads thread on thread.organization_id = run.organization_id and thread.id = run.thread_id
           where run.organization_id = ${ORGANIZATION_ID} and run.id = ${RUN_ID}
        `;
        const events = await observer<Array<{
          sequence: number;
          type: string;
          runId: string;
          botId: string | null;
          threadId: string;
          turnId: string | null;
          sessionKey: string | null;
          leaseGeneration: number | null;
        }>>`
          select sequence, type, run_id as "runId", bot_id as "botId", thread_id as "threadId",
                 turn_id as "turnId", session_key as "sessionKey", lease_generation::int as "leaseGeneration"
            from run_events where organization_id = ${ORGANIZATION_ID} and run_id = ${RUN_ID}
              and type <> 'message.admitted' order by sequence
        `;
        const messages = await observer<Array<{ role: string; runId: string | null; authorBotId: string | null; text: string | null }>>`
          select role, run_id as "runId", author_bot_id as "authorBotId", content #>> '{0,text}' as text
            from messages where organization_id = ${ORGANIZATION_ID} and thread_id = ${THREAD_ID} and role = 'assistant'
        `;
        const run = finalRuns[0];
        assert(run?.status === "completed" && run.externalState === "settled", "replayed run did not reach its terminal state");
        assert(run.hermesRunId === proof.hermesRunId && run.hermesRunId !== null, "worker restart changed the Hermes run ID");
        assert(run.watermark === (STATUS_RECOVERY ? 0 : 3) && run.eventsComplete === !STATUS_RECOVERY, "recovery misreported its retained event coverage");
        assert(run.generation === 2 && run.sessionKey === SESSION_ID, "run lease or session identity changed across restart");
        assert(proof.createPosts === 1 && proof.createSessionIds.length === 1 && proof.createSessionIds[0] === SESSION_ID,
          "worker restart issued a second Hermes create or changed session");
        assert(proof.eventRequests.length === (STATUS_RECOVERY ? 1 : 2) && proof.eventRequests.every((request) => request.hermesRunId === run.hermesRunId),
          "expected initial and replay requests for the same Hermes run");
        assert(proof.eventRequests[0]?.since === "0" && (STATUS_RECOVERY || proof.eventRequests[1]?.since === "0"
          && proof.eventRequests[1]?.lastEventId === "0"), "new worker did not replay the first retained frame from cursor zero");
        assert(STATUS_RECOVERY ? proof.statusPolls === 1 : proof.statusPolls === 0, "recovery used an unexpected status polling path");
        assert(events.length === (STATUS_RECOVERY ? 2 : 3) && events.map((event) => event.sequence).join(",") === (STATUS_RECOVERY ? "1,2" : "1,2,3"),
          "durable replay rows are missing, out of order, or duplicated");
        assert(events.filter((event) => event.type === "run.completed").length === 1, "terminal event was not unique");
        assert(events.every((event) => event.runId === RUN_ID && event.botId === BOT_ID && event.threadId === THREAD_ID
          && event.turnId === RUN_ID && event.sessionKey === SESSION_ID && event.leaseGeneration === 2),
        "durable event identity did not follow the reclaimed run lease");
        assert(messages.length === 1 && messages[0]?.runId === RUN_ID && messages[0]?.authorBotId === BOT_ID
          && messages[0]?.text === FINAL_OUTPUT, "replay produced a missing or duplicate assistant terminal message");
        currentPhase = "verify-real-sse-dedupe";
        const replayedLive = await readUntilFrame(
          sseReader!, eventBuffer, sseFrames,
          (frame) => frame.data.type === "agent.message" && frame.data.runId === RUN_ID
            && Number(frame.data.sequence) === 1 && frame.data.cursor == null,
          MAX_SETUP_WAIT_MS,
        );
        const replayedLiveDecision = acceptLiveEvent(dedupe, asLiveIdentity(replayedLive), ORGANIZATION_ID, liveDecision.streamCursor);
        assert(!replayedLiveDecision.deliver, "real SSE delivered the cursorless replay twice as a new bubble");
        const replayedLiveIndex = sseFrames.lastIndexOf(replayedLive);
        // run.completed never leaves before its commit, so it arrives as a
        // full committed frame. The committed row of the replayed message, on
        // the contrary, already left live on this connection: the stream
        // reduces it to a cursor advance, never a second copy.
        const terminalFrame = await readUntilFrame(
          sseReader!, eventBuffer, sseFrames,
          (frame) => frame.data.type === "run.completed" && frame.data.runId === RUN_ID,
          MAX_SETUP_WAIT_MS,
        );
        assert(terminalFrame.data.cursor != null, "real API SSE did not expose the committed terminal cursor");
        assert(!sseFrames.slice(replayedLiveIndex + 1).some((frame) => frame.data.type === "agent.message"
          && frame.data.runId === RUN_ID && Number(frame.data.sequence) === 1),
        "real SSE sent a committed copy of the message it already carried live");
        const terminalDecision = acceptLiveEvent(dedupe, asLiveIdentity(terminalFrame), ORGANIZATION_ID, replayedLiveDecision.streamCursor);
        assert(terminalDecision.deliver && terminalDecision.streamCursor === Number(terminalFrame.data.cursor),
          "the committed terminal frame did not advance the console cursor");
        assert(sseFrames.filter((frame) => frame.data.type === "run.completed" && frame.data.runId === RUN_ID).length === 1,
          "real API SSE delivered duplicate terminal events");

        console.info(JSON.stringify({
          test: "run-crash-replay",
          passed: true,
          workers: 2,
          recoveryMode: STATUS_RECOVERY ? "status_polling" : "event_replay",
          sigkillBeforeCommit: true,
          firstLeaseGeneration: beforeCrash[0]!.generation,
          secondLeaseGeneration: run.generation,
          createPosts: proof.createPosts,
          eventRequests: proof.eventRequests.length,
          statusPolls: proof.statusPolls,
          replaySince: 0,
          durableRunEvents: events.length,
          assistantMessages: messages.length,
          admittedUserMessages: 1,
          admissionHttpStatus: 202,
          durableAdmissionReceipts: 1,
          userMessageDurableAcrossCrash: true,
          watermark: run.watermark,
          eventsComplete: run.eventsComplete,
          sseProvisionalDeduped: true,
          uniqueTerminalSseEvent: true,
          staleProvisionalFanoutRejected: true,
          staleDurableWriteRejected: true,
        }));
      } finally {
        releaseSecondPublish.resolve();
        if (childTwo) {
          childTwo.kill("SIGKILL");
          await withTimeout(childTwo.exited, 5_000, "second worker did not stop during cleanup").catch(() => undefined);
          await childTwoReports?.catch(() => undefined);
        }
        if (childOne) {
          childOne.kill("SIGKILL");
          await withTimeout(childOne.exited, 5_000, "first worker did not stop during cleanup").catch(() => undefined);
          await childOneReports?.catch(() => undefined);
        }
        releaseFirstPublish.resolve();
        if (sseReader) await sseReader.cancel().catch(() => undefined);
        sseAbort?.abort("fixture cleanup");
        await waitUntil(() => hub.subscriberCount() === 0, 2_000, "SSE subscriber remained after cleanup").catch(() => undefined);
        relayServer?.stop(true);
        apiServer?.stop(true);
      }
    });
  } finally {
    fake?.stop(true);
    if (previousGatewayToken === undefined) delete process.env.FAKE_HERMES_TOKEN;
    else process.env.FAKE_HERMES_TOKEN = previousGatewayToken;
  }
}

const childMode = process.argv[2] === "--child" ? process.argv[3] : null;
if (childMode === "first" || childMode === "second") {
  await runChild(childMode);
} else {
  try {
    await parentMain();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safeFailures = new Set([
      "fixture admission did not return 202",
      "fixture admission did not return matching message and plain run identities",
      "admitted user message was lost, duplicated or changed",
      "admission receipt was lost, duplicated or changed",
      "fake gateway session setup failed",
      "real API SSE route did not open",
      "real API SSE did not subscribe to EventHub",
      "first worker did not reach provisional API fanout",
      "provisional fanout did not carry the expected run and lease identity",
      "first fanout unexpectedly had a durable SSE cursor",
      "first cursorless event was not deliverable after the admission receipt",
      "first worker did not own the live run",
      "Hermes ID was not committed before the first event",
      "the first event was committed before the crash gate",
      "SIGKILL did not stop the first worker promptly",
      "held API publish response did not clean up",
      "second worker did not acquire the expired run with a new generation",
      "second worker did not reach the active lease gate",
      "stale lease check did not run against an active second generation",
      "API published a provisional delta from a stale lease",
      "PostgreSQL stale lease rejection was not proven",
      "second worker neither replayed the host journal nor used bounded status fallback",
      "second worker did not finish the replay run",
      "second worker exited unsuccessfully",
      "second child did not report a completed generation-two run",
      "replayed run did not reach its terminal state",
      "worker restart changed the Hermes run ID",
      "recovery misreported its retained event coverage",
      "run lease or session identity changed across restart",
      "worker restart issued a second Hermes create or changed session",
      "expected initial and replay requests for the same Hermes run",
      "new worker did not replay the first retained frame from cursor zero",
      "recovery used an unexpected status polling path",
      "durable replay rows are missing, out of order, or duplicated",
      "terminal event was not unique",
      "durable event identity did not follow the reclaimed run lease",
      "replay produced a missing or duplicate assistant terminal message",
      "first host event stream was not cancelled with the killed worker",
      "real SSE delivered the cursorless replay twice as a new bubble",
      "durable replay was not deduplicated against its provisional live frame",
      "real API SSE did not expose the committed terminal cursor",
      "real API SSE delivered duplicate terminal events",
    ]);
    console.error(JSON.stringify({
      test: "run-crash-replay",
      passed: false,
      phase: currentPhase,
      errorClass: childErrorClass(error),
      failure: safeFailures.has(message) ? message : undefined,
    }));
    process.exitCode = 1;
  }
}
