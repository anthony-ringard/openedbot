/**
 * S7 proof: one run is followed end to end in the journals by ONE trace id.
 *
 *   API admission (in process) ─ run.admission                       traceId T
 *   worker (in process, the real claim loop and runner)
 *     ─ worker.run_claimed, run step lines, worker.relay_request,
 *       run.latency                                                   traceId T, span per request
 *   link gateway (child process: apps/link-gateway/src/main.ts)
 *     ─ runtime_link.relay_request                                    traceId T, same spans
 *   connector (child process: the real edge-setup Go client)
 *     ─ `relay POST /v1/runs trace=T span=S`
 *   Hermes (fake, behind a recorder) ─ receives `traceparent` 00-T-S-01
 *
 * on a disposable PostgreSQL, with T = the run id without dashes.
 *
 * OPENEDBOT_TRACE_E2E_LEGACY_REF=<git ref> (e.g. edge-setup/v1.5.0) builds
 * the connector from that published tree instead: the run must still
 * complete, the worker and gateway still journal T, and the old connector
 * drops the header (no trace line, nothing reaches Hermes). Every connector
 * already installed keeps working with this openedbot.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { readWorkerConfig } from "../../apps/worker/src/config";
import { createWorkerService } from "../../apps/worker/src/application/worker-service";
import { createWorkerRelayDialer } from "../../modules/execution/src/application/runtime-client";
import { RUNTIME_LINK_WS_PATH } from "../../modules/runtime-link/src/domain/ws-path";
import { hashCredential } from "../../platform/db/src/credential";
import { captureLogEvents, type LogRecord } from "../../platform/observability/src/log/test-logger";
import { parseTraceparent, traceIdOfRun } from "../../platform/observability/src/trace-context";
import { startFakeHermes } from "../fake-hermes/server";
import { FAKE_HERMES_TOKEN } from "../fake-hermes/defaults";
import { EDGE_SETUP_DIR } from "../edge-setup-dir";
import { withDisposablePostgres } from "./disposable-postgres";

const LEGACY_REF = process.env.OPENEDBOT_TRACE_E2E_LEGACY_REF?.trim() || null;
const ORG = crypto.randomUUID();
const USER = crypto.randomUUID();
const SECTION = crypto.randomUUID();
const BOT = crypto.randomUUID();
const THREAD = crypto.randomUUID();
const RUNTIME = crypto.randomUUID();
const LINK_TOKEN = `trace-link-${crypto.randomUUID()}`;
/**
 * S1b: each process holds only its own secrets, the production layout: the
 * gateway relay + inventory (no events, no run key), the worker events + relay
 * + run key.
 */
const RELAY_TOKEN = `trace-relay-${crypto.randomUUID()}`;
const GATEWAY_SECRETS: Record<string, string> = { RELAY_INTERNAL_TOKEN: RELAY_TOKEN, INVENTORY_INTERNAL_TOKEN: `trace-inventory-${crypto.randomUUID()}` };
const WORKER_SECRETS: Record<string, string> = { EVENTS_INTERNAL_TOKEN: `trace-events-${crypto.randomUUID()}`, RELAY_INTERNAL_TOKEN: RELAY_TOKEN, RUN_KEY_SECRET: `trace-run-key-${crypto.randomUUID()}` };
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitUntil(check: () => Promise<boolean> | boolean, ms: number, failure: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(failure);
}

/** A child process whose stdout lines are kept, for its journal. */
function spawnJournaled(name: string, command: string[], options: { cwd?: string; env: Record<string, string | undefined> }) {
  const lines: string[] = [];
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe" });
  const pump = async (stream: ReadableStream<Uint8Array>, sink: string[] | null) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (sink) sink.push(line); else if (line.trim()) console.error(`[${name}] ${line}`);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer && sink) sink.push(buffer);
  };
  const pumped = Promise.all([pump(child.stdout, lines), pump(child.stderr, null)]);
  return {
    lines,
    child,
    async stop(): Promise<void> {
      child.kill("SIGTERM");
      const exited = await Promise.race([child.exited, Bun.sleep(15_000).then(() => null)]);
      if (exited === null) child.kill("SIGKILL");
      await pumped;
    },
  };
}

function jsonLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.flatMap((line) => {
    if (!line.startsWith("{")) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** The connector test binary, built from this tree or from a published ref. */
async function buildConnector(scratch: string): Promise<string> {
  let tree = EDGE_SETUP_DIR;
  if (LEGACY_REF) {
    const repository = resolve(EDGE_SETUP_DIR, "..");
    const root = join(scratch, "legacy");
    await mkdir(root, { recursive: true });
    const archive = Bun.spawn(["git", "-C", repository, "archive", "--format=tar", LEGACY_REF, "edge-setup"], { stdout: "pipe", stderr: "inherit" });
    const untar = Bun.spawn(["tar", "-x", "-C", root], { stdin: archive.stdout, stderr: "inherit" });
    assert(await archive.exited === 0 && await untar.exited === 0, `git archive ${LEGACY_REF} failed`);
    tree = join(root, "edge-setup");
    // Only the test host is added to the published tree: the connector code is the old one.
    await cp(join(EDGE_SETUP_DIR, "internal/connector/trace_e2e_test.go"), join(tree, "internal/connector/trace_e2e_test.go"));
  }
  const binary = join(scratch, "connector.test");
  const build = Bun.spawn(["go", "test", "-c", "-o", binary, "./internal/connector"], { cwd: tree, stdout: "inherit", stderr: "inherit" });
  assert(await build.exited === 0, `go test -c failed in ${tree}`);
  return binary;
}

const scratch = await mkdtemp(join(tmpdir(), "openedbot-trace-e2e-"));
const hermes = startFakeHermes({ port: 0, delayMs: 5, capacity: 4 });
const hermesRequests: Array<{ method: string; path: string; traceparent: string | null }> = [];
const recorder = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    hermesRequests.push({ method: request.method, path: url.pathname, traceparent: request.headers.get("traceparent") });
    return fetch(`${hermes.url.origin}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    });
  },
});
// Every child process, stopped in `finally` whatever failed.
const children: Array<ReturnType<typeof spawnJournaled>> = [];

try {
  const binary = await buildConnector(scratch);
  await withDisposablePostgres("openedbot170_trace", async ({ owner, url, connect }) => {
    await owner`insert into users (id, email) values (${USER}, 'trace-e2e@example.test')`;
    await owner`insert into organizations (id, slug, name) values (${ORG}, ${`trace-${ORG}`}, 'Trace E2E')`;
    await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
    await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Trace', 0)`;
    await owner`insert into runtimes (id, organization_id, name, reachability, link_token_hash, link_connected_at, link_last_seen_at, is_active, capacity)
      values (${RUNTIME}, ${ORG}, 'Trace connector', 'connector', ${hashCredential(LINK_TOKEN)}, now(), now(), true, 4)`;
    await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${BOT}, ${ORG}, ${SECTION}, 'Neo', 'neo', 0)`;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${THREAD}, ${ORG}, ${BOT}, 'DM', ${`trace-${THREAD}`}, true)`;

    // 1. The real link gateway, its own process and journal (JSON on stdout).
    const linkPort = await freePort();
    const linkUrl = `http://127.0.0.1:${linkPort}`;
    const gateway = spawnJournaled("gateway", ["bun", resolve(import.meta.dir, "../../apps/link-gateway/src/main.ts")], {
      env: {
        ...process.env, OPENEDBOT_ENV: "test", NODE_ENV: "test", OPENEDBOT_LOG_DIR: "off",
        API_DATABASE_URL: url, RUNTIME_LINK_MODE: "separate", RUNTIME_LINK_HOST: "127.0.0.1",
        RUNTIME_LINK_PORT: String(linkPort), RUNTIME_LINK_INTERNAL_URL: linkUrl,
        RUNTIME_LINK_PUBLIC_URL: linkUrl, WORKER_INTERNAL_TOKEN: undefined, INTERNAL_TOKENS_EMIT: undefined, ...GATEWAY_SECRETS,
        RUNTIME_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY, API_INTERNAL_URL: "http://127.0.0.1:9",
      },
    });
    children.push(gateway);
    await waitUntil(() => jsonLines(gateway.lines).some((line) => line.event === "runtime_link.gateway_started"), 20_000,
      "the link gateway did not start");
    // The gateway announces its roles and holds neither the events secret nor the run-key one.
    const started = jsonLines(gateway.lines).find((line) => line.event === "runtime_link.gateway_started") as { internalSecrets?: { roles?: Record<string, string> } } | undefined;
    assert(JSON.stringify(started?.internalSecrets?.roles) === JSON.stringify({ relay: "explicit", inventory: "explicit" }),
      `the gateway must hold relay and inventory only: ${JSON.stringify(started?.internalSecrets)}`);

    // 2. The real connector, linked to that gateway, relaying to the recorded fake Hermes.
    const connector = spawnJournaled("connector", [binary, "-test.run", "^TestTraceE2EHost$", "-test.v", "-test.count=1"], {
      env: {
        ...process.env,
        OPENEDBOT_TRACE_E2E_WS_URL: `ws://127.0.0.1:${linkPort}${RUNTIME_LINK_WS_PATH}`,
        OPENEDBOT_TRACE_E2E_GATEWAY_URL: recorder.url.origin,
        OPENEDBOT_TRACE_E2E_RUNTIME_ID: RUNTIME,
        OPENEDBOT_TRACE_E2E_LINK_TOKEN: LINK_TOKEN,
        OPENEDBOT_TRACE_E2E_BEARER: FAKE_HERMES_TOKEN,
      },
    });
    children.push(connector);
    // Untraced probe (no run context): the link answers once the host is admitted.
    const probe = createWorkerRelayDialer(RUNTIME, { apiInternalUrl: linkUrl, internalSecrets: testInternalSecrets("worker", WORKER_SECRETS), runtimeLinkInternalUrl: linkUrl });
    await waitUntil(async () => (await probe({ method: "GET", path: "/health", headers: {}, body: null }).catch(() => null))?.status === 200,
      30_000, "the connector never linked");
    hermesRequests.length = 0;

    // 3. Admission through the real send route: `run.admission` names T.
    const api = await connect("openedbot_api");
    const auth: AuthContext = { sessionId: "trace-session", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "trace" };
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
    app.route("/", conversationRoutes(api, {} as BlobStore, { billingEnforced: false } as ApiConfig));
    const admission = await captureLogEvents(async () => {
      const response = await app.request(`/${THREAD}/messages`, {
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ input: "Suis ce run de bout en bout." }),
      });
      assert(response.status === 202, `admission returned ${response.status}`);
      return (await response.json() as { runId: string }).runId;
    });
    const runId = admission.result;
    const traceId = traceIdOfRun(runId);
    const admitted = admission.records.find((record) => record.event === "run.admission");
    assert(admitted?.traceId === traceId && traceId === runId.replaceAll("-", ""), `run.admission does not name the run's trace: ${JSON.stringify(admitted)}`);

    // 4. The real worker claim loop and runner, journaled in memory.
    const workerDb = await connect("openedbot_worker");
    const config = readWorkerConfig({
      OPENEDBOT_ENV: "test", WORKER_ID: "trace-e2e-worker", ...WORKER_SECRETS,
      RUNTIME_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY, RUNTIME_LINK_MODE: "separate", RUNTIME_LINK_INTERNAL_URL: linkUrl,
      API_INTERNAL_URL: "http://127.0.0.1:9", BLOB_DRIVER: "file", BLOB_FILE_ROOT: join(scratch, "blobs"), WORKER_POLL_MS: "50",
    });
    const status = async () => (await owner<Array<{ status: string }>>`select status from runs where id = ${runId}`)[0]?.status;
    const worker = await captureLogEvents(async () => {
      const service = createWorkerService(workerDb, config, { jobs: [] });
      const running = service.run();
      try {
        await waitUntil(async () => ["completed", "failed", "cancelled", "unknown"].includes(String(await status())), 45_000,
          "the run never reached a terminal status");
      } finally {
        service.stop("SIGTERM");
        await running;
      }
    });
    assert(await status() === "completed", `run ended ${await status()}`);

    await connector.stop();
    await gateway.stop();

    // 5. The four journals and Hermes.
    const ofRun = worker.records.filter((record) => record.runId === runId);
    const relayed = worker.records.filter((record) => record.event === "worker.relay_request");
    const gatewayLines = jsonLines(gateway.lines).filter((line) => line.event === "runtime_link.relay_request");
    const connectorLines = connector.lines.filter((line) => line.startsWith("connector: relay "));
    const tracedHermes = hermesRequests.filter((request) => request.traceparent !== null);

    assert(ofRun.some((record) => record.event === "worker.run_claimed") && ofRun.some((record) => record.event === "run.latency"),
      "the worker did not journal the claim and the latency of the run");
    assert(ofRun.every((record) => record.traceId === traceId), "a worker line of the run lacks its trace id");
    const tracedWorker = worker.records.filter((record) => record.traceId !== undefined);
    assert(tracedWorker.every((record) => record.traceId === traceId), "a worker line names another trace");
    assert(relayed.length > 0 && relayed.every((record) => record.traceId === traceId), "worker relay lines do not carry the run's trace");
    const workerSpans = new Set(relayed.map((record) => String(record.spanId)));
    assert(gatewayLines.length > 0 && gatewayLines.every((line) => line.traceId === traceId && workerSpans.has(String(line.spanId))),
      `gateway lines do not carry the worker's trace and spans: ${JSON.stringify(gatewayLines)}`);
    const create = (lines: Array<Record<string, unknown> | LogRecord>) => lines.find((line) => line.method === "POST" && line.path === "/v1/runs");
    const createSpan = String(create(relayed)?.spanId);
    assert(create(gatewayLines)?.spanId === createSpan, "the run creation is not the same span in the worker and the gateway");

    if (LEGACY_REF) {
      assert(connectorLines.length === 0, `the legacy connector journaled a trace: ${connectorLines.join(" | ")}`);
      assert(tracedHermes.length === 0, "the legacy connector relayed traceparent to Hermes");
    } else {
      const expected = `connector: relay POST /v1/runs trace=${traceId} span=${createSpan}`;
      assert(connectorLines.includes(expected), `connector journal lacks «${expected}»: ${connectorLines.join(" | ")}`);
      assert(connectorLines.every((line) => line.includes(`trace=${traceId} `)), "a connector relay line names another trace");
      const hermesCreate = hermesRequests.find((request) => request.method === "POST" && request.path === "/v1/runs");
      const sent = parseTraceparent(hermesCreate?.traceparent);
      assert(sent?.traceId === traceId && sent.spanId === createSpan, `Hermes received ${hermesCreate?.traceparent ?? "no traceparent"} on POST /v1/runs`);
    }

    const show = (label: string, value: unknown) => console.log(`${label.padEnd(10)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
    const pick = (record: Record<string, unknown> | undefined) => record && Object.fromEntries(
      ["event", "runId", "method", "path", "status", "traceId", "spanId", "parentSpanId"].filter((key) => key in record).map((key) => [key, record[key]]));
    console.log(`\nrun ${runId}  trace ${traceId}${LEGACY_REF ? `  (legacy connector ${LEGACY_REF})` : ""}`);
    show("api", pick(admitted));
    show("worker", pick(ofRun.find((record) => record.event === "worker.run_claimed")));
    show("worker", pick(create(relayed) as Record<string, unknown>));
    show("gateway", pick(create(gatewayLines)));
    show("connector", connectorLines.find((line) => line.includes("POST /v1/runs")) ?? "(no trace line: the header is dropped)");
    show("hermes", hermesRequests.find((request) => request.method === "POST" && request.path === "/v1/runs"));
    show("worker", pick(ofRun.find((record) => record.event === "run.latency")));
    const refusals = jsonLines(gateway.lines).filter((line) => String(line.event).startsWith("internal_auth.refused"));
    assert(refusals.length === 0, `the gateway refused internal calls: ${JSON.stringify(refusals)}`);
    console.log(`worker events under the trace: ${[...new Set(tracedWorker.map((record) => record.event))].join(", ")}`);
    console.log(`\nrun trace correlation passed: ${tracedWorker.length} traced worker lines, ${relayed.length} relayed requests, ${gatewayLines.length} gateway lines, ${connectorLines.length} connector lines, ${tracedHermes.length}/${hermesRequests.length} Hermes requests traced${LEGACY_REF ? `; ${LEGACY_REF} drops the header and the run still completes` : ""}; internal secrets split per process.`);
  });
} finally {
  await Promise.allSettled(children.map((child) => child.stop()));
  recorder.stop(true);
  hermes.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
