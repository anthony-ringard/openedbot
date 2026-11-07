import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { SQL, type Server } from "bun";
import { HermesClient, HermesClientError } from "../../platform/hermes/src";
import { logger } from "../../platform/observability/src/logger";
import { EventHub } from "../../modules/notifications/src/application/event-hub";
import { claimRun } from "../../modules/execution/src/application/queue";
import { forwardNextRunSteer } from "../../modules/execution/src/application/run-steering";
import { failRunsOnDisconnectedRuntimes } from "../../modules/execution/src/application/disconnected-runtime-runs";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import { eventRoutes } from "../../apps/api/src/routes/events/event-routes";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import type { Db } from "@openedbot/platform-db";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { withDisposablePostgres } from "./disposable-postgres";

const ORGANIZATION_ID = crypto.randomUUID();
const OTHER_ORGANIZATION_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const OTHER_USER_ID = crypto.randomUUID();
const SESSION_ROW_ID = crypto.randomUUID();
const OTHER_SESSION_ROW_ID = crypto.randomUUID();
const SESSION_CREDENTIAL_HASH = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
const OTHER_SESSION_CREDENTIAL_HASH = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
const RUNTIME_ID = crypto.randomUUID();
const SECTION_ID = crypto.randomUUID();
const BOT_ID = crypto.randomUUID();
const THREAD_ONE_ID = crypto.randomUUID();
const THREAD_TWO_ID = crypto.randomUUID();
const THREAD_THREE_ID = crypto.randomUUID();
const TARGET_ONE_ID = crypto.randomUUID();
const TARGET_TWO_ID = crypto.randomUUID();
const TARGET_THREE_ID = crypto.randomUUID();
const APPROVAL_THREE_ID = crypto.randomUUID();
const SESSION_ONE_ID = "followup-" + crypto.randomUUID();
const SESSION_TWO_ID = "followup-" + crypto.randomUUID();
const SESSION_THREE_ID = "followup-" + crypto.randomUUID();
const PRIVATE_ONE = "PRIVATE_RECEIPT_SENTINEL_ONE";
const PRIVATE_TWO = "PRIVATE_RECEIPT_SENTINEL_TWO";
const INTERNAL_WORKER_TOKEN = "internal-" + crypto.randomUUID();
const FAKE_GATEWAY_TOKEN = "gateway-" + crypto.randomUUID();
const RUN_WAIT_MS = 5_000;

let currentPhase = "startup";
let phaseStartedAt = Date.now();
function enterPhase(phase: string): void {
  currentPhase = phase;
  phaseStartedAt = Date.now();
}

/**
 * A failure this test wrote itself (a wait that ran out): its message names
 * the condition and carries no data, so the report may print it.
 */
class TestWaitError extends Error {}

type Auth = AppVariables["auth"];
type HonoContext = { set(key: "auth", value: Auth): void };
type HonoApp = {
  use(path: string, handler: (context: HonoContext, next: () => Promise<void>) => Promise<void>): void;
  route(path: string, app: HonoApp): void;
  onError(handler: (error: unknown, context: { json(value: unknown, status?: number): Response }) => Response): void;
  fetch(request: Request): Promise<Response>;
};
type SseFrame = { id: string | null; event: string | null; data: Record<string, unknown> };
type FrameBuffer = { text: string; decoder: TextDecoder };
type Admission = { runId: string; workflowId: string | null; foldedIntoRunId?: string };

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TestWaitError(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(check: () => Promise<boolean> | boolean, milliseconds: number, message: string): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new TestWaitError(message);
}

async function rows<T>(db: SQL, statement: string, values: unknown[] = []): Promise<T[]> {
  return await db.unsafe(statement, values) as T[];
}

async function nextSseFrame(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: FrameBuffer, timeoutMs: number): Promise<SseFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const separator = /\r?\n\r?\n/.exec(buffer.text);
    if (separator?.index !== undefined) {
      const raw = buffer.text.slice(0, separator.index);
      buffer.text = buffer.text.slice(separator.index + separator[0].length);
      let id: string | null = null;
      let event: string | null = null;
      const dataLines: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      return { id, event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("SSE frame timed out");
    const result = await withTimeout(reader.read(), remaining, "SSE frame timed out");
    if (result.done) throw new Error("SSE stream closed unexpectedly");
    buffer.text += buffer.decoder.decode(result.value, { stream: true });
  }
}

function payloadOf(frame: SseFrame): Record<string, unknown> {
  return frame.data.payload && typeof frame.data.payload === "object"
    ? frame.data.payload as Record<string, unknown>
    : {};
}

async function readAdmissionAndSteeringReceipts(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: FrameBuffer,
  runId: string,
  messageIds: Set<string>,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const admitted = new Set<string>();
  const statuses = new Set<string>();
  const deadline = Date.now() + RUN_WAIT_MS;
  while (Date.now() < deadline) {
    const frame = await nextSseFrame(reader, buffer, Math.max(1, deadline - Date.now()));
    const payload = payloadOf(frame);
    if (frame.event === "message.admitted" && frame.data.runId === runId && typeof payload.messageId === "string") {
      if (messageIds.has(payload.messageId)) admitted.add(payload.messageId);
      frames.push(frame);
    }
    if (frame.event === "run.steering" && frame.data.runId === runId && typeof payload.status === "string") {
      statuses.add(payload.status);
      frames.push(frame);
    }
    if (admitted.size === messageIds.size && ["pending", "sending", "confirmed"].every((status) => statuses.has(status))) {
      return frames;
    }
  }
  throw new Error("live SSE did not deliver all follow-up receipts");
}

async function postFollowup(app: HonoApp, threadId: string, text: string): Promise<Admission & { messageId: string }> {
  const response = await app.fetch(new Request("http://fixture/threads/" + threadId + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: text }),
  }));
  if (response.status !== 202) {
    const body = await response.clone().json().catch(() => ({})) as { code?: unknown };
    const code = typeof body.code === "string" && /^[A-Z0-9_]{1,80}$/.test(body.code) ? body.code : "UNKNOWN";
    enterPhase("follow-up-status-" + response.status + "-" + code);
    throw new Error("follow-up admission returned a non-accepted status");
  }
  const body = await response.json() as Admission & { message?: { id?: unknown } };
  assert(typeof body.runId === "string", "follow-up response omitted its run");
  assert(typeof body.message?.id === "string", "follow-up response omitted its message");
  return { ...body, messageId: body.message.id };
}

function auth(organizationId: string, userId: string, sessionId: string, credentialHash: string): Auth {
  return {
    sessionId,
    organizationId,
    userId,
    role: "owner",
    kind: "web",
    credentialHash,
  } as Auth;
}

async function createHermesRun(origin: string, token: string): Promise<string> {
  const response = await fetch(origin + "/v1/runs", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ input: "busy target", instructions: "fixture", session_id: null }),
  });
  assert(response.status === 201, "fake Hermes failed to create active run");
  const body = await response.json() as { run_id?: unknown };
  assert(typeof body.run_id === "string", "fake Hermes omitted active run ID");
  return body.run_id;
}

async function seedTenant(tx: SQL, organizationId: string, slug: string, userId: string, sessionId: string, credentialHash: string): Promise<void> {
  await rows(tx, "insert into organizations (id, slug, name) values ($1, $2, $3)", [
    organizationId, slug + "-" + organizationId, "Follow-up fixture",
  ]);
  await rows(tx, "insert into users (id, email) values ($1, $2)", [
    userId, "followup-" + userId + "@example.test",
  ]);
  await rows(tx, "insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')", [
    organizationId, userId,
  ]);
  await rows(tx, "insert into sessions (id, organization_id, user_id, kind, session_token_hash, access_token_hash, access_expires_at) values ($1, $2, $3, 'web', $4, $4, now() + interval '1 hour')", [
    sessionId, organizationId, userId, credentialHash,
  ]);
}

async function seedVisibleTargetEvent(tx: SQL, organizationId: string, threadId: string, runId: string): Promise<void> {
  await tx`insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at)
    values (${organizationId}, ${threadId}, ${runId}, 0, 'agent.message',
      ${{ text: "target has already produced output" }}, now())`;
}

async function main(): Promise<void> {
  logger.level = "silent";
  console.info = () => undefined;
  const { startFakeHermes } = await import("../fake-hermes/server");
  let fake: Server<undefined> | null = null;
  let relay: Server<undefined> | null = null;
  const releaseHeldResponse = deferred<void>();
  const heldRequestAccepted = deferred<void>();
  let heldRunId: string | null = null;
  let heldResponse = false;
  const steerPosts = new Map<string, number>();
  const steerTexts = new Map<string, string[]>();

  try {
    enterPhase("start-local-fake-hermes");
    fake = startFakeHermes({ hostname: "127.0.0.1", port: 0, token: FAKE_GATEWAY_TOKEN, delayMs: 0 });
    const fakeOrigin = "http://127.0.0.1:" + fake.port;
    const hermesRunOne = await createHermesRun(fakeOrigin, FAKE_GATEWAY_TOKEN);
    const hermesRunTwo = await createHermesRun(fakeOrigin, FAKE_GATEWAY_TOKEN);
    const hermesRunThree = await createHermesRun(fakeOrigin, FAKE_GATEWAY_TOKEN);

    relay = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const match = /^\/v1\/runs\/([^/]+)\/steer$/.exec(url.pathname);
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        const headers = new Headers(request.headers);
        headers.set("authorization", "Bearer " + FAKE_GATEWAY_TOKEN);
        headers.delete("host");
        if (match && request.method === "POST") {
          const runId = decodeURIComponent(match[1]!);
          steerPosts.set(runId, (steerPosts.get(runId) ?? 0) + 1);
          const input = body ? JSON.parse(new TextDecoder().decode(body)) as { text?: unknown } : {};
          if (typeof input.text === "string") {
            const current = steerTexts.get(runId) ?? [];
            current.push(input.text);
            steerTexts.set(runId, current);
          }
        }
        const upstream = await fetch(fakeOrigin + url.pathname + url.search, {
          method: request.method,
          headers,
          ...(body ? { body } : {}),
          redirect: "manual",
        });
        if (match && request.method === "POST" && heldRunId === decodeURIComponent(match[1]!) && !heldResponse) {
          heldResponse = true;
          heldRequestAccepted.resolve();
          await releaseHeldResponse.promise;
        }
        return upstream;
      },
    });
    const relayOrigin = "http://127.0.0.1:" + relay.port;
    const hermesClient = new HermesClient({
      endpoint: relayOrigin,
      token: "fixture-relay-token",
      policy: { environment: "development", insecureOrigins: new Set([relayOrigin.replace(/^https?:\/\//, "")]) },
      mtls: null,
    });

    await withDisposablePostgres("openedbot117_followup", async ({ owner, connect }) => {
      const apiDb = await connect("openedbot_api");
      const workerDb = await connect("openedbot_worker");
      const hub = new EventHub();
      const workerOneId = "worker-" + crypto.randomUUID();
      const workerTwoId = "worker-" + crypto.randomUUID();
      const apiConfig = {
        billingEnforced: false,
      } as ApiConfig;
      const blobStore = { driver: "file" } as BlobStore;

      enterPhase("seed-disposable-tenants-and-active-runs");
      await owner.begin(async (tx) => {
        enterPhase("seed-primary-tenant");
        await seedTenant(tx as unknown as SQL, ORGANIZATION_ID, "followup", USER_ID, SESSION_ROW_ID, SESSION_CREDENTIAL_HASH);
        enterPhase("seed-isolation-tenant");
        await seedTenant(tx as unknown as SQL, OTHER_ORGANIZATION_ID, "other-followup", OTHER_USER_ID, OTHER_SESSION_ROW_ID, OTHER_SESSION_CREDENTIAL_HASH);
        enterPhase("seed-bot-and-threads");
        await rows(tx as unknown as SQL, "insert into sections (id, organization_id, name, position) values ($1, $2, 'Follow-up', 0)", [
          SECTION_ID, ORGANIZATION_ID,
        ]);
        await rows(tx as unknown as SQL, "insert into bots (id, organization_id, section_id, name, slug, model, reasoning_effort, position) values ($1, $2, $3, 'Follow-up bot', 'followup-bot', 'fake/hermes', 'low', 0)", [
          BOT_ID, ORGANIZATION_ID, SECTION_ID,
        ]);
        await rows(tx as unknown as SQL, "insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default) values ($1, $2, $3, 'Follow-up one', $4, true)", [
          THREAD_ONE_ID, ORGANIZATION_ID, BOT_ID, SESSION_ONE_ID,
        ]);
        await rows(tx as unknown as SQL, "insert into runtimes (id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, link_token_hash, link_connected_at, link_last_seen_at, is_active, capacity, selected_provider, selected_model, reasoning_effort) values ($1, $2, 'Follow-up fixture connector', 'connector', null, null, null, null, $3, now(), now(), true, 4, 'fake', 'fake/hermes', 'low')", [
          RUNTIME_ID, ORGANIZATION_ID, crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
        ]);
        enterPhase("seed-active-target");
        await rows(tx as unknown as SQL, "insert into runs (id, organization_id, thread_id, bot_id, input, status, model, step_index, step_kind, external_state, events_complete, hermes_run_id, execution_session_key, lease_owner, lease_expires_at, lease_generation, attempts, started_at, deadline_at) values ($1, $2, $3, $4, 'active target fixture', 'running', 'fake/hermes', 0, 'root', 'streaming', false, $5, $6, $7, now() + interval '5 minutes', 1, 1, now(), now() + interval '5 minutes')", [
          TARGET_ONE_ID, ORGANIZATION_ID, THREAD_ONE_ID, BOT_ID, hermesRunOne, SESSION_ONE_ID, workerOneId,
        ]);
      });
      enterPhase("seed-active-target-event-query");
      await seedVisibleTargetEvent(owner, ORGANIZATION_ID, THREAD_ONE_ID, TARGET_ONE_ID);
      enterPhase("seed-active-target-event-query-complete");

      enterPhase("mount-test-api-routes");
      const apiRequire = createRequire(resolve(import.meta.dir, "../../apps/api/package.json"));
      const Hono = (apiRequire("hono") as { Hono: new () => HonoApp }).Hono;
      const apiApp = new Hono();
      apiApp.use("*", async (context, next) => {
        context.set("auth", auth(ORGANIZATION_ID, USER_ID, SESSION_ROW_ID, SESSION_CREDENTIAL_HASH));
        await next();
      });
      apiApp.route("/threads", conversationRoutes(apiDb as unknown as Db, blobStore, apiConfig) as unknown as HonoApp);
      apiApp.route("/events", eventRoutes(apiDb as unknown as Db, hub, {
        fallbackPollMs: 15,
        replayWindowMs: 60_000,
        replayWindowEvents: 1_000,
      }) as unknown as HonoApp);
      apiApp.onError((error, context) => {
        const status = error && typeof error === "object" && "status" in error &&
          typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : 500;
        const code = error && typeof error === "object" && "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "FIXTURE_ERROR";
        return context.json({ code }, status);
      });

      const otherApp = new Hono();
      otherApp.use("*", async (context, next) => {
        context.set("auth", auth(OTHER_ORGANIZATION_ID, OTHER_USER_ID, OTHER_SESSION_ROW_ID, OTHER_SESSION_CREDENTIAL_HASH));
        await next();
      });
      otherApp.route("/events", eventRoutes(apiDb as unknown as Db, hub, {
        fallbackPollMs: 15,
        replayWindowMs: 60_000,
        replayWindowEvents: 1_000,
      }) as unknown as HonoApp);
      otherApp.onError((error, context) => {
        const status = error && typeof error === "object" && "status" in error &&
          typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : 500;
        return context.json({ code: status === 500 ? "FIXTURE_ERROR" : "AUTH_ERROR" }, status);
      });

      enterPhase("read-sse-cursors");
      const apiCursorRows = await rows<{ cursor: number }>(owner,
        "select coalesce(max(cursor), 0)::int as cursor from run_events where organization_id = $1",
        [ORGANIZATION_ID]);
      enterPhase("open-same-tenant-sse");
      let apiSseResponse: Response;
      try {
        apiSseResponse = await apiApp.fetch(new Request("http://fixture/events?cursor=" + Number(apiCursorRows[0]?.cursor ?? 0)));
      } catch {
        enterPhase("same-tenant-sse-fetch-threw");
        throw new Error("same-tenant SSE fetch failed");
      }
      enterPhase("same-tenant-sse-status-" + apiSseResponse.status);
      assert(apiSseResponse.status === 200 && apiSseResponse.body, "same-tenant SSE did not open");
      const apiReader = apiSseResponse.body.getReader();
      const apiBuffer: FrameBuffer = { text: "", decoder: new TextDecoder() };
      let otherReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const otherBuffer: FrameBuffer = { text: "", decoder: new TextDecoder() };
      let secondForward: Promise<string> | null = null;

      const baseWorkerConfig = (workerId: string): WorkerConfig => ({
        workerId,
        apiInternalUrl: "http://127.0.0.1",
        runtimeLinkInternalUrl: relayOrigin,
        internalSecrets: testInternalSecrets("worker", INTERNAL_WORKER_TOKEN),
        tokenEncryption: {} as WorkerConfig["tokenEncryption"],
        hermesMtls: null,
        hermesEndpointPolicy: {
          environment: "development",
          insecureOrigins: new Set([relayOrigin.replace(/^https?:\/\//, "")]),
        } as WorkerConfig["hermesEndpointPolicy"],
        leaseSeconds: 15,
        runInactivityMs: 15_000,
        runTimeoutMs: RUN_WAIT_MS,
        reconciliationTimeoutMs: 4_000,
        billingEnforced: false,
        cachedInputTokenWeight: 0,
        webAppUrl: "http://127.0.0.1:1420",
      });

      try {
        await waitUntil(() => hub.subscriberCount() >= 1, RUN_WAIT_MS, "same-tenant SSE subscription did not become active");

        enterPhase("admit-and-fold-follow-ups");
        enterPhase("post-first-follow-up");
        const first = await postFollowup(apiApp, THREAD_ONE_ID, PRIVATE_ONE);
        enterPhase("post-second-follow-up");
        const second = await postFollowup(apiApp, THREAD_ONE_ID, PRIVATE_TWO);
        assert(first.runId === second.runId, "second follow-up created a distinct fallback run");
        assert(second.foldedIntoRunId === first.runId, "second follow-up was not folded into the original source");
        assert(first.workflowId === null && second.workflowId === null, "plain DM follow-ups unexpectedly created a workflow");
        const sourceId = first.runId;
        const firstMessageId = first.messageId;
        const secondMessageId = second.messageId;
        const sourceRows = await rows<{ status: string; workflowId: string | null }>(owner,
          "select status, workflow_id as \"workflowId\" from runs where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, sourceId]);
        assert(sourceRows[0]?.status === "queued" && sourceRows[0].workflowId === first.workflowId, "source fallback was not durably queued");
        const sourceMessages = await rows<{ id: string; content: unknown; runId: string }>(owner,
          "select id, content, run_id as \"runId\" from messages where organization_id = $1 and run_id = $2 and role = 'user' order by sequence, created_at, id",
          [ORGANIZATION_ID, sourceId]);
        assert(sourceMessages.length === 2 && sourceMessages.every((message) => message.runId === sourceId), "follow-up messages were not associated with one source");
        assert(sourceMessages.some((message) => JSON.stringify(message.content).includes(PRIVATE_ONE)), "first private follow-up was not persisted");
        assert(sourceMessages.some((message) => JSON.stringify(message.content).includes(PRIVATE_TWO)), "second private follow-up was not persisted");
        const attemptRows = await rows<{ id: string; status: string; text: string; targetRunId: string }>(owner,
          "select id, status, text, target_run_id as \"targetRunId\" from run_steering_attempts where organization_id = $1 and source_run_id = $2",
          [ORGANIZATION_ID, sourceId]);
        assert(attemptRows.length === 1 && attemptRows[0]?.status === "pending", "follow-ups did not fold into one pending steering attempt");
        assert(attemptRows[0]?.targetRunId === TARGET_ONE_ID, "steering attempt lost its active target");
        assert(attemptRows[0]?.text.includes(PRIVATE_ONE) && attemptRows[0]?.text.includes(PRIVATE_TWO), "pending steering text did not preserve both follow-ups");

        enterPhase("verify-active-target-blocks-claim");
        const workerOne = baseWorkerConfig(workerOneId);
        const blockedClaim = await claimRun(workerDb, workerOne);
        assert(blockedClaim === null, "worker claimed a same-thread fallback while its Hermes target was active");

        enterPhase("deliver-ack-and-verify-receipts");
        enterPhase("read-target-one-lease");
        const targetOneRows = await rows<{ leaseGeneration: number }>(owner,
          "select lease_generation::int as \"leaseGeneration\" from runs where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, TARGET_ONE_ID]);
        const targetOneContext = {
          id: TARGET_ONE_ID,
          organizationId: ORGANIZATION_ID,
          threadId: THREAD_ONE_ID,
          leaseGeneration: Number(targetOneRows[0]?.leaseGeneration),
        };
        enterPhase("forward-target-one");
        const accepted = await forwardNextRunSteer(
          workerDb, hermesClient, { workerId: workerOneId, leaseSeconds: workerOne.leaseSeconds },
          targetOneContext, hermesRunOne, new AbortController().signal,
        );
        enterPhase("forward-target-one-result-" + accepted);
        assert(accepted === "confirmed", "fake Hermes ACK was not durably confirmed");
        assert(steerPosts.get(hermesRunOne) === 1, "first active target did not receive exactly one steer");
        enterPhase("read-confirmed-source");
        const confirmedRows = await rows<{ status: string; completionKind: string | null; workflowId: string | null }>(owner,
          "select run.status, run.completion_kind as \"completionKind\", run.workflow_id as \"workflowId\" from runs run where run.organization_id = $1 and run.id = $2",
          [ORGANIZATION_ID, sourceId]);
        assert(confirmedRows[0]?.status === "cancelled" && confirmedRows[0]?.completionKind === "steered_into_active", "ACK did not settle the exact source as steered");
        assert(confirmedRows[0]?.workflowId === null, "plain DM ACK unexpectedly created a workflow");

        const receiptRows = await rows<{ sequence: number; type: string; payload: Record<string, unknown> }>(owner,
          "select sequence, type, payload from run_events where organization_id = $1 and run_id = $2 order by sequence",
          [ORGANIZATION_ID, sourceId]);
        const receiptTypes = receiptRows.map((event) => event.type);
        assert(receiptRows.length === 5, "unexpected number of durable follow-up receipts");
        assert(receiptTypes.join(",") === "message.admitted,run.steering,message.admitted,run.steering,run.steering", "durable follow-up receipts were out of order");
        const steeringStatuses = receiptRows.filter((event) => event.type === "run.steering")
          .map((event) => event.payload.status);
        assert(steeringStatuses.join(",") === "pending,sending,confirmed", "steering receipt state transitions were not ordered");
        assert(receiptRows.every((event, index) => Number(event.sequence) === index), "receipt sequence was not contiguous");
        assert(receiptRows.every((event) => {
          const encoded = JSON.stringify(event.payload);
          return !encoded.includes(PRIVATE_ONE) && !encoded.includes(PRIVATE_TWO);
        }), "private follow-up text leaked into a receipt");
        const liveFrames = await readAdmissionAndSteeringReceipts(
          apiReader, apiBuffer, sourceId, new Set([firstMessageId, secondMessageId]),
        );
        assert(liveFrames.length === 5, "same-tenant live SSE omitted or duplicated receipts");
        assert(liveFrames.every((frame) => frame.data.botId === BOT_ID && frame.data.turnId === sourceId
          && frame.data.sessionKey === SESSION_ONE_ID && frame.data.leaseGeneration === 0
          && Number(frame.id) === frame.data.cursor), "receipt identity did not follow its source run");

        enterPhase("verify-sse-replay-and-tenant-isolation");
        const replayResponse = await apiApp.fetch(new Request("http://fixture/events?cursor=" + Number(apiCursorRows[0]?.cursor ?? 0)));
        assert(replayResponse.status === 200 && replayResponse.body, "same-tenant replay stream did not open");
        const replayReader = replayResponse.body.getReader();
        const replayBuffer: FrameBuffer = { text: "", decoder: new TextDecoder() };
        try {
          const replayFrames = await readAdmissionAndSteeringReceipts(
            replayReader, replayBuffer, sourceId, new Set([firstMessageId, secondMessageId]),
          );
          assert(replayFrames.length === 5, "same-tenant SSE replay omitted or duplicated receipts");
          assert(JSON.stringify(replayFrames.map((frame) => frame.data)) === JSON.stringify(liveFrames.map((frame) => frame.data)),
            "live and replay follow-up envelopes diverged");
        } finally {
          await replayReader.cancel().catch(() => undefined);
        }
        await apiReader.cancel().catch(() => undefined);
        const otherCursorRows = await rows<{ cursor: number }>(owner,
          "select coalesce(max(cursor), 0)::int as cursor from run_events where organization_id = $1",
          [OTHER_ORGANIZATION_ID]);
        enterPhase("open-other-tenant-replay");
        const otherSseResponse = await otherApp.fetch(new Request("http://fixture/events?cursor=" + Number(otherCursorRows[0]?.cursor ?? 0)));
        assert(otherSseResponse.status === 200 && otherSseResponse.body, "other-tenant SSE did not open");
        otherReader = otherSseResponse.body.getReader();
        let otherTenantSilent = false;
        try {
          await nextSseFrame(otherReader, otherBuffer, 250);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "SSE frame timed out") throw error;
          otherTenantSilent = true;
        }
        assert(otherTenantSilent, "other-tenant SSE emitted an unexpected frame");

        enterPhase("recover-expired-post-dispatch-steer");
        enterPhase("terminalize-first-target");
        await rows(owner, "update runs set status = 'completed', external_state = 'settled', events_complete = true, lease_owner = null, lease_expires_at = null, ended_at = now(), updated_at = now() where organization_id = $1 and id = $2", [
          ORGANIZATION_ID, TARGET_ONE_ID,
        ]);
        enterPhase("seed-second-target");
        await owner.begin(async (tx) => {
          await rows(tx as unknown as SQL, "insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default) values ($1, $2, $3, 'Follow-up two', $4, false)", [
            THREAD_TWO_ID, ORGANIZATION_ID, BOT_ID, SESSION_TWO_ID,
          ]);
          await rows(tx as unknown as SQL, "insert into runs (id, organization_id, thread_id, bot_id, input, status, model, step_index, step_kind, external_state, events_complete, hermes_run_id, execution_session_key, lease_owner, lease_expires_at, lease_generation, attempts, started_at, deadline_at) values ($1, $2, $3, $4, 'active target fixture', 'running', 'fake/hermes', 0, 'root', 'streaming', false, $5, $6, $7, now() + interval '5 minutes', 1, 1, now(), now() + interval '5 minutes')", [
            TARGET_TWO_ID, ORGANIZATION_ID, THREAD_TWO_ID, BOT_ID, hermesRunTwo, SESSION_TWO_ID, workerTwoId,
          ]);
        });
        enterPhase("seed-second-target-event");
        await seedVisibleTargetEvent(owner, ORGANIZATION_ID, THREAD_TWO_ID, TARGET_TWO_ID);
        enterPhase("post-second-target-follow-up");
        const secondAdmission = await postFollowup(apiApp, THREAD_TWO_ID, "follow-up for recovery fixture");
        const sourceTwoId = secondAdmission.runId;
        enterPhase("read-second-attempt");
        const attemptTwoRows = await rows<{ id: string }>(owner,
          "select id from run_steering_attempts where organization_id = $1 and source_run_id = $2",
          [ORGANIZATION_ID, sourceTwoId]);
        const attemptTwoId = attemptTwoRows[0]?.id;
        assert(typeof attemptTwoId === "string", "second source omitted its steering attempt");
        enterPhase("read-second-target-lease");
        const targetTwoRows = await rows<{ leaseGeneration: number }>(owner,
          "select lease_generation::int as \"leaseGeneration\" from runs where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, TARGET_TWO_ID]);
        const targetTwoContext = {
          id: TARGET_TWO_ID,
          organizationId: ORGANIZATION_ID,
          threadId: THREAD_TWO_ID,
          leaseGeneration: Number(targetTwoRows[0]?.leaseGeneration),
        };
        const workerTwo = baseWorkerConfig(workerTwoId);
        const beforeDispatchClient = {
          async steerRun(): Promise<number> {
            throw new HermesClientError("before dispatch fixture", 503, "HERMES_UNREACHABLE", {
              requestDelivery: "not_sent",
            });
          },
        } as unknown as HermesClient;
        enterPhase("verify-pre-dispatch-failure");
        const beforeDispatch = await forwardNextRunSteer(
          workerDb, beforeDispatchClient, { workerId: workerTwoId, leaseSeconds: workerTwo.leaseSeconds },
          targetTwoContext, hermesRunTwo, new AbortController().signal,
        );
        assert(beforeDispatch === "retry", "pre-dispatch failure did not safely return to pending");
        const priorSteerPosts = steerPosts.get(hermesRunTwo) ?? 0;
        assert(priorSteerPosts === 0, "pre-dispatch failure reached fake Hermes");
        const pendingAfterNotSent = await rows<{ status: string }>(owner,
          "select status from run_steering_attempts where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, attemptTwoId]);
        assert(pendingAfterNotSent[0]?.status === "pending", "pre-dispatch retry was not pending");
        enterPhase("wait-not-sent-backoff");
        // PostgreSQL decides, as claimRunSteer will: `available_at` carries
        // microseconds, and a JavaScript Date truncated to the millisecond
        // could call the backoff expired while the claim's now() still sees
        // it pending, so the forward returned "none" and nothing reached
        // fake Hermes.
        await waitUntil(async () => {
          const available = await rows<{ ready: boolean }>(owner,
            "select available_at <= now() as ready from run_steering_attempts where organization_id = $1 and id = $2",
            [ORGANIZATION_ID, attemptTwoId]);
          return available[0]?.ready === true;
        }, RUN_WAIT_MS, "pre-dispatch backoff did not expire");

        heldRunId = hermesRunTwo;
        enterPhase("start-post-dispatch-steer");
        secondForward = forwardNextRunSteer(
          workerDb, hermesClient, { workerId: workerTwoId, leaseSeconds: workerTwo.leaseSeconds },
          targetTwoContext, hermesRunTwo, new AbortController().signal,
        );
        enterPhase("wait-post-dispatch-acceptance");
        // The held steer either reaches fake Hermes or the forward settles
        // without sending it; the second case fails now, named, instead of
        // running out the wait.
        await withTimeout(Promise.race([
          heldRequestAccepted.promise,
          secondForward.then((outcome) => {
            throw new TestWaitError(`forward settled as ${outcome} before the held steer reached fake Hermes`);
          }),
        ]), RUN_WAIT_MS, "fake Hermes did not accept the held steer");
        enterPhase("expire-sending-attempt");
        await rows(owner, "update run_steering_attempts set forwarding_lease_expires_at = now() - interval '1 second' where organization_id = $1 and id = $2 and status = 'sending'", [
          ORGANIZATION_ID, attemptTwoId,
        ]);
        enterPhase("recover-expired-attempt");
        const blockedWhileAmbiguous = await claimRun(workerDb, workerTwo);
        assert(blockedWhileAmbiguous === null, "expired sending attempt allowed the source to bypass its active target");
        const recoveredRows = await rows<{ status: string; attempts: number }>(owner,
          "select status, attempts from run_steering_attempts where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, attemptTwoId]);
        assert(recoveredRows[0]?.status === "ambiguous", "expired sending attempt was not recovered as ambiguous");
        enterPhase("verify-no-ambiguous-retry");
        const noDuplicate = await forwardNextRunSteer(
          workerDb, hermesClient, { workerId: workerTwoId, leaseSeconds: workerTwo.leaseSeconds },
          targetTwoContext, hermesRunTwo, new AbortController().signal,
        );
        assert(noDuplicate === "none", "ambiguous send was incorrectly retried");
        assert(steerPosts.get(hermesRunTwo) === priorSteerPosts + 1, "fake Hermes received a duplicate steer after recovery");
        releaseHeldResponse.resolve();
        const lateAck = await withTimeout(secondForward, RUN_WAIT_MS, "held steer response did not release");
        secondForward = null;
        assert(lateAck === "ambiguous", "late ACK bypassed the expired attempt fence");

        enterPhase("expire-target-and-reconnect-runtime");
        await rows(owner, "update runs set status = 'completed', external_state = 'settled', events_complete = true, lease_owner = null, lease_expires_at = null, ended_at = now(), updated_at = now() where organization_id = $1 and id = $2", [
          ORGANIZATION_ID, TARGET_TWO_ID,
        ]);
        await rows(owner, "update runtimes set link_last_seen_at = now() - interval '2 minutes' where organization_id = $1 and id = $2", [
          ORGANIZATION_ID, RUNTIME_ID,
        ]);
        const disconnectedClaim = await claimRun(workerDb, workerTwo);
        assert(disconnectedClaim === null, "worker claimed fallback through a disconnected runtime");
        const expiredRows = await rows<{ status: string; errorCode: string | null }>(owner,
          "select status, error_code as \"errorCode\" from run_steering_attempts where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, attemptTwoId]);
        assert(expiredRows[0]?.status === "expired" && expiredRows[0]?.errorCode === "STEER_UNACKED_FALLBACK",
          "terminal target did not release its ambiguous steer to exact FIFO fallback");
        await rows(owner, "update runtimes set link_last_seen_at = now(), link_connected_at = now() where organization_id = $1 and id = $2", [
          ORGANIZATION_ID, RUNTIME_ID,
        ]);
        const releasedClaim = await claimRun(workerDb, workerTwo);
        assert(releasedClaim?.id === sourceTwoId, "terminal target did not release the exact source run");

        enterPhase("seed-approval-stop-target");
        await owner.begin(async (tx) => {
          await rows(tx as unknown as SQL, "insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default) values ($1, $2, $3, 'Follow-up approval stop', $4, false)", [
            THREAD_THREE_ID, ORGANIZATION_ID, BOT_ID, SESSION_THREE_ID,
          ]);
          await rows(tx as unknown as SQL, "insert into runs (id, organization_id, thread_id, bot_id, input, status, model, step_index, step_kind, external_state, events_complete, hermes_run_id, execution_session_key, lease_owner, lease_expires_at, lease_generation, attempts, started_at, deadline_at) values ($1, $2, $3, $4, 'approval stop target fixture', 'awaiting_approval', 'fake/hermes', 0, 'root', 'streaming', false, $5, $6, $7, now() + interval '5 minutes', 1, 1, now(), now() + interval '5 minutes')", [
            TARGET_THREE_ID, ORGANIZATION_ID, THREAD_THREE_ID, BOT_ID, hermesRunThree, SESSION_THREE_ID, workerOneId,
          ]);
          await rows(tx as unknown as SQL, "insert into approval_requests (id, organization_id, thread_id, run_id, choices, expires_at, gate_ordinal, status, forward_state) values ($1, $2, $3, $4, $5::jsonb, now() + interval '5 minutes', 0, 'pending', 'pending')", [
            APPROVAL_THREE_ID, ORGANIZATION_ID, THREAD_THREE_ID, TARGET_THREE_ID, JSON.stringify(["once", "deny"]),
          ]);
        });
        const approvalAdmission = await postFollowup(apiApp, THREAD_THREE_ID, "follow-up during approval");
        const sourceThreeId = approvalAdmission.runId;
        const attemptThreeRows = await rows<{ id: string }>(owner,
          "select id from run_steering_attempts where organization_id = $1 and source_run_id = $2",
          [ORGANIZATION_ID, sourceThreeId]);
        const attemptThreeId = attemptThreeRows[0]?.id;
        assert(typeof attemptThreeId === "string", "approval-stop source omitted its steering attempt");
        const targetThreeContext = {
          id: TARGET_THREE_ID,
          organizationId: ORGANIZATION_ID,
          threadId: THREAD_THREE_ID,
          leaseGeneration: 1,
        };
        const noApprovalSteer = await forwardNextRunSteer(
          workerDb, hermesClient, { workerId: workerOneId, leaseSeconds: workerOne.leaseSeconds },
          targetThreeContext, hermesRunThree, new AbortController().signal,
        );
        assert(noApprovalSteer === "none" && steerPosts.get(hermesRunThree) === undefined,
          "worker steered a target awaiting approval");
        enterPhase("request-approval-thread-stop");
        let stopResponse: Response;
        try {
          stopResponse = await apiApp.fetch(new Request("http://fixture/threads/" + THREAD_THREE_ID + "/stop", {
            method: "POST",
          }));
        } catch {
          enterPhase("approval-thread-stop-fetch-threw");
          throw new Error("approval thread stop request failed");
        }
        enterPhase("approval-thread-stop-status-" + stopResponse.status);
        assert(stopResponse.status === 204, "thread stop did not persist");
        enterPhase("verify-thread-stop-runs");
        const stoppedRunRows = await rows<{ id: string; status: string; workflowId: string | null }>(owner,
          "select id, status, workflow_id as \"workflowId\" from runs where organization_id = $1 and thread_id = $2 order by id",
          [ORGANIZATION_ID, THREAD_THREE_ID]);
        const stoppedTargetRun = stoppedRunRows.find((run) => run.id === TARGET_THREE_ID);
        const stoppedSourceRun = stoppedRunRows.find((run) => run.id === sourceThreeId);
        assert(stoppedTargetRun?.status === "awaiting_approval", "thread stop terminalized the remote target before Hermes acknowledged it");
        assert(stoppedSourceRun?.status === "cancelled" && stoppedSourceRun.workflowId === null,
          "thread stop left its queued plain-DM follow-up source claimable");
        const requestedStopRows = await rows<{ status: string; remoteStopState: string | null }>(owner,
          "select status, remote_stop_state as \"remoteStopState\" from runs where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, TARGET_THREE_ID]);
        assert(requestedStopRows[0]?.status === "awaiting_approval" && requestedStopRows[0]?.remoteStopState === "requested",
          "thread stop did not keep the known Hermes target fenced pending acknowledgment");
        enterPhase("verify-thread-stop-gate");
        const gateAfterStop = await rows<{ status: string; forwardState: string; ordinal: number }>(owner,
          "select status, forward_state as \"forwardState\", gate_ordinal as ordinal from approval_requests where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, APPROVAL_THREE_ID]);
        enterPhase("approval-gate-" + (gateAfterStop[0]?.status ?? "missing") + "-" +
          (gateAfterStop[0]?.forwardState ?? "missing") + "-" + Number(gateAfterStop[0]?.ordinal ?? -1));
        assert(gateAfterStop[0]?.status === "expired" && gateAfterStop[0]?.forwardState === "expired" &&
          Number(gateAfterStop[0]?.ordinal) === 0, "thread stop did not expire its concrete approval gate");
        enterPhase("verify-no-thread-stop-steer");
        const noStoppedTargetSteer = await forwardNextRunSteer(
          workerDb, hermesClient, { workerId: workerOneId, leaseSeconds: workerOne.leaseSeconds },
          targetThreeContext, hermesRunThree, new AbortController().signal,
        );
        assert(noStoppedTargetSteer === "none" && steerPosts.get(hermesRunThree) === undefined,
          "thread-stopped approval target received a steer after stop was requested");
        enterPhase("verify-cancelled-source-unclaimable-before-terminal");
        const noSourceBeforeTerminal = await claimRun(workerDb, workerOne);
        assert(noSourceBeforeTerminal === null, "thread stop left its cancelled follow-up source claimable before target acknowledgment");
        const attemptBeforeTerminal = await rows<{ status: string; errorCode: string | null }>(owner,
          "select status, error_code as \"errorCode\" from run_steering_attempts where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, attemptThreeId]);
        assert(attemptBeforeTerminal[0]?.status === "expired" && attemptBeforeTerminal[0]?.errorCode === "STEER_FALLBACK_NOT_QUEUED",
          "thread stop did not expire the pending steer after cancelling its source");
        enterPhase("verify-stop-remains-requested-before-hermes-ack");
        const targetBeforeHermesAck = await rows<{ status: string; remoteStopState: string | null }>(owner,
          "select status, remote_stop_state as \"remoteStopState\" from runs where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, TARGET_THREE_ID]);
        assert(targetBeforeHermesAck[0]?.status === "awaiting_approval" && targetBeforeHermesAck[0]?.remoteStopState === "requested",
          "thread stop target changed before Hermes acknowledged cancellation");
        enterPhase("fake-hermes-stop");
        await hermesClient.stopRun(hermesRunThree, new AbortController().signal);
        const stoppedHermesRun = await hermesClient.getRunStatus(hermesRunThree, new AbortController().signal);
        assert(stoppedHermesRun.status === "cancelled", "fake Hermes did not confirm the thread-stop terminal state");
        enterPhase("terminalize-thread-stop-target-after-hermes-ack");
        await rows(owner, "update runs set status = 'cancelled', external_state = 'settled', events_complete = true, remote_stop_state = 'confirmed', lease_owner = null, lease_expires_at = null, ended_at = now(), updated_at = now() where organization_id = $1 and id = $2", [
          ORGANIZATION_ID, TARGET_THREE_ID,
        ]);
        enterPhase("verify-cancelled-source-unclaimable-after-terminal");
        const noSourceAfterTerminal = await claimRun(workerDb, workerOne);
        assert(noSourceAfterTerminal === null, "thread stop made its cancelled follow-up source claimable after target acknowledgment");
        const releasedSourceState = await rows<{ status: string; workflowId: string | null }>(owner,
          "select status, workflow_id as \"workflowId\" from runs where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, sourceThreeId]);
        const terminalTargetState = await rows<{ status: string; remoteStopState: string | null }>(owner,
          "select status, remote_stop_state as \"remoteStopState\" from runs where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, TARGET_THREE_ID]);
        const finalAttemptState = await rows<{ status: string; errorCode: string | null }>(owner,
          "select status, error_code as \"errorCode\" from run_steering_attempts where organization_id = $1 and id = $2",
          [ORGANIZATION_ID, attemptThreeId]);
        enterPhase("approval-thread-stop-" + (noSourceAfterTerminal === null ? "unclaimable" : "claimable") +
          "-" + (releasedSourceState[0]?.status ?? "missing") +
          "-" + (releasedSourceState[0]?.workflowId ? "workflow" : "no-workflow") +
          "-" + (terminalTargetState[0]?.status ?? "missing") +
          "-" + (terminalTargetState[0]?.remoteStopState ?? "no-stop") +
          "-" + (finalAttemptState[0]?.status ?? "missing") +
          "-" + (finalAttemptState[0]?.errorCode ?? "no-error"));
        assert(releasedSourceState[0]?.status === "cancelled" && releasedSourceState[0]?.workflowId === null,
          "thread stop did not keep its queued plain-DM source cancelled");
        assert(terminalTargetState[0]?.status === "cancelled" && terminalTargetState[0]?.remoteStopState === "confirmed",
          "worker acknowledgment did not terminalize the requested target");
        assert(finalAttemptState[0]?.status === "expired" && finalAttemptState[0]?.errorCode === "STEER_FALLBACK_NOT_QUEUED",
          "thread stop did not keep its cancelled source detached from the pending steer");

        enterPhase("verify-terminal-target-races-recovery-snapshot");
        const raceThread = crypto.randomUUID();
        const raceTarget = crypto.randomUUID();
        const raceSource = crypto.randomUUID();
        await owner.begin(async (tx) => {
          await tx`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
            values (${raceThread}, ${ORGANIZATION_ID}, ${BOT_ID}, 'Recovery race', ${"session-" + raceThread}, false)`;
          await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, external_state,
              hermes_run_id, lease_owner, lease_expires_at, lease_generation, attempts)
            values (${raceTarget}, ${ORGANIZATION_ID}, ${raceThread}, ${BOT_ID}, 'Race target', 'running',
              'streaming', 'race-target-fixture', ${workerTwoId}, now() + interval '5 minutes', 1, 1)`;
          await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status)
            values (${raceSource}, ${ORGANIZATION_ID}, ${raceThread}, ${BOT_ID}, 'Race source', 'queued')`;
          await tx`insert into run_steering_attempts (id, organization_id, thread_id, target_run_id, source_run_id, text)
            values (${crypto.randomUUID()}, ${ORGANIZATION_ID}, ${raceThread}, ${raceTarget}, ${raceSource}, 'Race source')`;
        });
        let targetFinishedAfterRecovery = false;
        const originalBegin = workerDb.begin.bind(workerDb);
        const raceDb = new Proxy(workerDb, {
          get(target, property) {
            if (property !== 'begin') return Reflect.get(target, property);
            return (work: (tx: SQL) => Promise<unknown>) => originalBegin(async (transaction) => {
              const raceTx = new Proxy(transaction as unknown as SQL, {
                apply(targetQuery, thisArg, args) {
                  const query = Reflect.apply(targetQuery, thisArg, args);
                  const parts = args[0];
                  if (!targetFinishedAfterRecovery && Array.isArray(parts) && 'raw' in parts
                    && parts.join(' ').includes('WORKER_LEASE_EXPIRED')) {
                    targetFinishedAfterRecovery = true;
                    return (async () => {
                      await owner`update runs set status = 'completed', external_state = 'settled', events_complete = true,
                        lease_owner = null, lease_expires_at = null where id = ${raceTarget}`;
                      return await query;
                    })();
                  }
                  return query;
                },
              });
              return work(raceTx);
            });
          },
        });
        const racedClaim = await claimRun(raceDb, workerTwo);
        assert(targetFinishedAfterRecovery && racedClaim === null,
          'source started before its attempt settled after a concurrent target terminal');
        const afterRecoveryClaim = await claimRun(workerDb, workerTwo);
        assert(afterRecoveryClaim?.id === raceSource, 'next recovery did not release the exact raced source');
        const raceEvents = await owner<Array<{ type: string; status: string }>>`
          select type, payload->>'status' as status from run_events where run_id = ${raceSource}
        `;
        assert(raceEvents.length === 1 && raceEvents[0]?.type === 'run.steering' && raceEvents[0].status === 'expired',
          'raced source was claimed without its durable terminal receipt');

        enterPhase("verify-retry-cap-and-disconnect-timeout");
        const retryThread = crypto.randomUUID();
        const freshThread = crypto.randomUUID();
        const controlThread = crypto.randomUUID();
        const retryTarget = crypto.randomUUID();
        const retrySource = crypto.randomUUID();
        const freshSource = crypto.randomUUID();
        const controlSource = crypto.randomUUID();
        const retryAttempt = crypto.randomUUID();
        await owner.begin(async (tx) => {
          for (const id of [retryThread, freshThread, controlThread]) await tx`
            insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
            values (${id}, ${ORGANIZATION_ID}, ${BOT_ID}, 'Timeout fixture', ${"session-" + id}, false)
          `;
          await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, external_state,
              hermes_run_id, lease_owner, lease_expires_at, lease_generation, attempts, created_at)
            values (${retryTarget}, ${ORGANIZATION_ID}, ${retryThread}, ${BOT_ID}, 'Target fixture', 'running',
              'streaming', 'retry-target-fixture', ${workerTwoId}, now() + interval '5 minutes', 1, 1, now() - interval '3 minutes')`;
          await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, created_at, deadline_at)
            values (${retrySource}, ${ORGANIZATION_ID}, ${retryThread}, ${BOT_ID}, 'Retry fixture', 'queued',
              now() - interval '2 minutes', now() + interval '5 minutes'),
              (${freshSource}, ${ORGANIZATION_ID}, ${freshThread}, ${BOT_ID}, 'Fresh fixture', 'queued',
              now(), now() + interval '5 minutes')`;
          await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, next_attempt_at, deadline_at)
            values (${controlSource}, ${ORGANIZATION_ID}, ${controlThread}, ${BOT_ID}, 'Fresh control', 'queued',
              now() + interval '2 minutes', now() + interval '5 minutes')`;
          await tx`insert into run_steering_attempts (id, organization_id, thread_id, target_run_id, source_run_id, text)
            values (${retryAttempt}, ${ORGANIZATION_ID}, ${retryThread}, ${retryTarget}, ${retrySource}, 'Retry fixture')`;
        });
        for (let attemptIndex = 0; attemptIndex < 3; attemptIndex++) {
          await owner`update run_steering_attempts set available_at = now() where id = ${retryAttempt}`;
          const outcome = await forwardNextRunSteer(workerDb, beforeDispatchClient,
            { workerId: workerTwoId, leaseSeconds: workerTwo.leaseSeconds },
            { id: retryTarget, organizationId: ORGANIZATION_ID, threadId: retryThread, leaseGeneration: 1 },
            'retry-target-fixture', new AbortController().signal);
          assert(outcome === 'retry', 'proven not-sent delivery was not classified safely');
        }
        const boundedAttempts = await owner<Array<{ status: string; attempts: number; code: string }>>`
          select status, attempts, error_code as code from run_steering_attempts where id = ${retryAttempt}
        `;
        assert(boundedAttempts[0]?.status === 'expired' && boundedAttempts[0].attempts === 3
          && boundedAttempts[0].code === 'STEER_ATTEMPTS_EXHAUSTED', 'steering retries did not stop at three attempts');
        const fourthTry = await forwardNextRunSteer(workerDb, beforeDispatchClient,
          { workerId: workerTwoId, leaseSeconds: workerTwo.leaseSeconds },
          { id: retryTarget, organizationId: ORGANIZATION_ID, threadId: retryThread, leaseGeneration: 1 },
          'retry-target-fixture', new AbortController().signal);
        assert(fourthTry === 'none', 'expired steering attempt was retried');
        const differentThreadClaim = await claimRun(workerDb, workerTwo);
        assert(differentThreadClaim?.id === freshSource,
          'non-steerable source bypassed its active target despite free runtime capacity');
        await owner`update runtimes set last_health_status = 'disconnected', link_last_seen_at = now() - interval '2 minutes'
          where id = ${RUNTIME_ID}`;
        const timedOut = await failRunsOnDisconnectedRuntimes(workerDb, 60_000);
        const timeoutRows = await owner<Array<{ id: string; status: string; code: string | null }>>`
          select id, status, error_code as code from runs where id in ${owner([retrySource, freshSource, controlSource, retryTarget])}
        `;
        assert(timedOut === 1 && timeoutRows.find((run) => run.id === retrySource)?.status === 'failed'
          && timeoutRows.find((run) => run.id === retrySource)?.code === 'RUNTIME_DISCONNECTED',
          'disconnected runtime did not terminalize the exact expired queued source');
        assert(timeoutRows.find((run) => run.id === freshSource)?.status === 'starting'
          && timeoutRows.find((run) => run.id === controlSource)?.status === 'queued'
          && timeoutRows.find((run) => run.id === retryTarget)?.status === 'running',
          'disconnect timeout changed a fresh message or a run already in flight');
        const timeoutEvents = await owner<Array<{ type: string; code: string }>>`
          select type, payload->>'errorCode' as code from run_events where run_id = ${retrySource} and type = 'run.error'
        `;
        assert(timeoutEvents.length === 1 && timeoutEvents[0]?.code === 'RUNTIME_DISCONNECTED',
          'disconnect timeout did not journal its terminal state once');

        console.log(JSON.stringify({
          ok: true,
          sameSourceFolded: first.runId === second.runId,
          sourceMessages: sourceMessages.length,
          durableReceipts: receiptRows.length,
          receiptStatesOrdered: steeringStatuses.join(","),
          liveSseReceipts: liveFrames.length,
          replayReceipts: 5,
          privateTextExcluded: true,
          otherTenantSilent: true,
          activeTargetBlockedClaim: blockedClaim === null,
          preDispatchNoPost: true,
          expiredSendRecoveredAmbiguous: recoveredRows[0]?.status === "ambiguous",
          secondAttemptPosts: Math.max(0, (steerPosts.get(hermesRunTwo) ?? 0) - priorSteerPosts),
          terminalTargetReleasedExactSource: releasedClaim?.id === sourceTwoId,
          threadStopCancelledQueuedSource: stoppedSourceRun?.status === "cancelled",
          threadStopSourceUnclaimableBeforeTerminal: noSourceBeforeTerminal === null,
          threadStopTargetRemainedRequestedUntilHermesAck:
            targetBeforeHermesAck[0]?.status === "awaiting_approval" && targetBeforeHermesAck[0]?.remoteStopState === "requested",
          threadStopHermesTerminalObserved: stoppedHermesRun.status === "cancelled",
          threadStopGateExpired: gateAfterStop[0]?.status === "expired" && gateAfterStop[0]?.forwardState === "expired",
          threadStopTargetConfirmedAfterHermesAck: terminalTargetState[0]?.remoteStopState === "confirmed",
          threadStopSourceUnclaimableAfterTerminal: noSourceAfterTerminal === null,
          threadStopSteerExpired: finalAttemptState[0]?.status === "expired",
          retriesBoundedToThree: true,
          nonSteerableThreadBlockedWithFreeCapacity: true,
          concurrentTerminalWaitedForReceipt: true,
          disconnectedTimeoutExactSource: true,
          freshAndInFlightPreserved: true,
        }));
      } finally {
        releaseHeldResponse.resolve();
        if (secondForward) await withTimeout(secondForward.catch(() => "ambiguous"), RUN_WAIT_MS, "second forward did not settle during cleanup").catch(() => undefined);
        await Promise.allSettled([
          apiReader.cancel(),
          ...(otherReader ? [otherReader.cancel()] : []),
        ]);
      }
    });
  } finally {
    releaseHeldResponse.resolve();
    if (relay) await relay.stop(true);
    if (fake) await fake.stop(true);
  }
}

main().catch((error: unknown) => {
  const errorClass = error instanceof Error ? error.name : "UnknownError";
  let cause = error;
  let errorCode: string | null = null;
  let errorErrno: string | number | null = null;
  let constraint: string | null = null;
  for (let depth = 0; depth < 4 && cause && typeof cause === "object"; depth += 1) {
    if ("code" in cause && typeof (cause as { code?: unknown }).code === "string" &&
      /^[A-Za-z0-9_]{1,16}$/.test((cause as { code: string }).code)) {
      errorCode = (cause as { code: string }).code;
    }
    if ("errno" in cause && (typeof (cause as { errno?: unknown }).errno === "string" ||
      typeof (cause as { errno?: unknown }).errno === "number")) {
      errorErrno = (cause as { errno: string | number }).errno;
    }
    if ("constraint" in cause && typeof (cause as { constraint?: unknown }).constraint === "string" &&
      /^[a-z0-9_]{1,100}$/.test((cause as { constraint: string }).constraint)) {
      constraint = (cause as { constraint: string }).constraint;
    }
    if (errorCode || errorErrno || constraint) break;
    cause = "cause" in cause ? (cause as { cause?: unknown }).cause : null;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const errorKeys = error && typeof error === "object" ? Object.getOwnPropertyNames(error).sort() : [];
  const failureKind = message.includes("foreign key") ? "foreign_key"
    : message.includes("unique constraint") ? "unique_constraint"
      : message.includes("check constraint") ? "check_constraint"
        : message.includes("not-null constraint") ? "not_null_constraint"
          : message.includes("does not exist") ? "missing_schema_object"
            : message.includes("permission denied") ? "permission_denied"
              : message.includes("syntax error") ? "syntax_error"
                : message.includes("assertion") ? "assertion"
                  : message.includes("transaction") ? "transaction"
                    : message.includes("parameter") || message.includes("argument") ? "query_binding"
                      : message.includes("closed") ? "closed_resource"
                        : "unclassified";
  const messageFlags = {
    mentionsRunEvents: message.includes("run_events"),
    mentionsConstraint: message.includes("constraint"),
    mentionsRelation: message.includes("relation"),
    mentionsCursor: message.includes("cursor"),
    mentionsJson: message.includes("json"),
    mentionsBind: message.includes("bind") || message.includes("parameter"),
    mentionsTransaction: message.includes("transaction"),
    mentionsSyntax: message.includes("syntax"),
  };
  const waitMessage = error instanceof TestWaitError ? error.message : null;
  const phaseElapsedMs = Date.now() - phaseStartedAt;
  console.error(JSON.stringify({ ok: false, phase: currentPhase, phaseElapsedMs, waitMessage, errorClass, errorCode, errorErrno, constraint, failureKind, errorKeys, messageFlags }));
  process.exitCode = 1;
});
