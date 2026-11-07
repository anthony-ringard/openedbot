import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import type { Server, SQL } from "bun";
import { claimRun } from "../../modules/execution/src/application/queue";
import { executeRun } from "../../modules/execution/src/application/runner";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { withDisposablePostgres } from "./disposable-postgres";
import { admitFixtureMessage, assertAdmittedMessageDurable } from "./admitted-message";
import type { Db } from "@openedbot/platform-db";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";

const INTERNAL_TOKEN = `worker-fixture-${crypto.randomUUID()}`;
const GATEWAY_TOKEN = `gateway-fixture-${crypto.randomUUID()}`;
const ORGANIZATION_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const RUNTIME_ID = crypto.randomUUID();
const SECTION_ID = crypto.randomUUID();
const BOT_ID = crypto.randomUUID();
const THREAD_ID = crypto.randomUUID();
let RUN_ID = "";
const SESSION_ID = `session-${crypto.randomUUID()}`;
const USER_INPUT = "Replay identity fixture";
const FINAL_OUTPUT = "Recovered output from the durable event journal.";
const MAX_WAIT_MS = 6_000;
const STATUS_FAILURE = process.env.OPENEDBOT_TEST_118_STATUS_RECOVERY === "failed";
const STATUS_RECOVERY = process.env.OPENEDBOT_TEST_118_STATUS_RECOVERY === "1" || STATUS_FAILURE;
const CLEAN_EOF = process.env.OPENEDBOT_TEST_118_CLEAN_EOF === "1";
let currentPhase = "startup";
let claimProbe: Record<string, unknown> | undefined;

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

type RelayProof = {
  createPosts: number;
  createSessionIds: string[];
  eventRequests: Array<{ hermesRunId: string; since: string | null; lastEventId: string | null }>;
  firstDeltaCommitted: boolean;
  replayStartedAfterCommit: boolean;
  statusPolls: number;
};

function sseFrame(sequence: number, event: Record<string, unknown>): string {
  return `id: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function firstDeltaCommitted(db: SQL): Promise<boolean> {
  const rows = await db<Array<{ watermark: number; agentMessages: number }>>`
    select run.last_hermes_sequence as watermark,
           count(event.cursor) filter (where event.type = 'agent.message')::int as "agentMessages"
      from runs run
      left join run_events event on event.organization_id = run.organization_id and event.run_id = run.id
     where run.organization_id = ${ORGANIZATION_ID} and run.id = ${RUN_ID}
     group by run.id
  `;
  return Number(rows[0]?.watermark ?? 0) >= 1 && Number(rows[0]?.agentMessages ?? 0) >= 1;
}

async function waitForFirstDeltaCommit(db: SQL, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      if (await firstDeltaCommitted(db)) return true;
    } catch {
      return false;
    }
    await Bun.sleep(20);
  }
  return false;
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

async function main(): Promise<void> {
  const previousGatewayToken = process.env.FAKE_HERMES_TOKEN;
  process.env.FAKE_HERMES_TOKEN = GATEWAY_TOKEN;

  let fake: Server<undefined> | null = null;
  let relay: Server<undefined> | null = null;
  try {
    currentPhase = "start-fake-hermes";
    const { startFakeHermes } = await import("../fake-hermes/server");
    fake = startFakeHermes({ hostname: "127.0.0.1", port: 0, token: GATEWAY_TOKEN, delayMs: 0 });
    const fakeOrigin = `http://127.0.0.1:${fake.port}`;
    const proof: RelayProof = {
      createPosts: 0,
      createSessionIds: [],
      eventRequests: [],
      firstDeltaCommitted: false,
      replayStartedAfterCommit: false,
      statusPolls: 0,
    };

    await withDisposablePostgres("openedbot118_replay", async ({ owner, connect }) => {
      currentPhase = "open-worker-connections";
      const workerDb = await connect("openedbot_worker");
      const apiDb = await connect("openedbot_api");
      const observer = await connect();
      const streamShutdown = new AbortController();
      const streamTasks = new Set<Promise<void>>();

      try {
      currentPhase = "seed-fixture";
      await owner.begin(async (tx) => {
        await tx`insert into organizations (id, slug, name)
          values (${ORGANIZATION_ID}, ${`replay-${ORGANIZATION_ID}`}, 'Event replay fixture')`;
        await tx`insert into users (id, email) values (${USER_ID}, ${`replay-${USER_ID}@example.test`})`;
        await tx`insert into memberships (organization_id, user_id, role)
          values (${ORGANIZATION_ID}, ${USER_ID}, 'owner')`;
        await tx`insert into sections (id, organization_id, name, position)
          values (${SECTION_ID}, ${ORGANIZATION_ID}, 'Replay fixture', 0)`;
        await tx`insert into bots (id, organization_id, section_id, name, slug, model, reasoning_effort, position)
          values (${BOT_ID}, ${ORGANIZATION_ID}, ${SECTION_ID}, 'Replay bot', 'replay-bot', 'fake/hermes', 'low', 0)`;
        await tx`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
          values (${THREAD_ID}, ${ORGANIZATION_ID}, ${BOT_ID}, 'Replay thread', ${SESSION_ID}, true)`;
        await tx`insert into runtimes (
            id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag,
            link_token_hash, link_connected_at, link_last_seen_at, is_active, selected_provider, selected_model,
            reasoning_effort
          ) values (
            ${RUNTIME_ID}, ${ORGANIZATION_ID}, 'Fresh connector fixture', 'connector', null, null, null, null,
            ${crypto.randomUUID().replaceAll('-', '')}, now(), now(), true, 'fake', 'fake/hermes', 'low'
          )`;
      });

      currentPhase = "admit-user-message";
      const auth = {
        sessionId: crypto.randomUUID(), organizationId: ORGANIZATION_ID, userId: USER_ID,
        role: "owner", kind: "web", credentialHash: crypto.randomUUID(),
      } as AppVariables["auth"];
      const admitted = await admitFixtureMessage(apiDb as unknown as Db, auth, THREAD_ID, USER_INPUT);
      RUN_ID = admitted.runId;
      const messageIdentity = { organizationId: ORGANIZATION_ID, threadId: THREAD_ID, botId: BOT_ID, userId: USER_ID, input: USER_INPUT };
      await assertAdmittedMessageDurable(observer, admitted, messageIdentity);

      currentPhase = "start-relay";
      relay = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/internal/events/publish" && request.method === "POST") {
            if (request.headers.get("authorization") !== `Bearer ${INTERNAL_TOKEN}`) {
              return new Response(null, { status: 401 });
            }
            return new Response(null, { status: 204 });
          }

          const proxyPrefix = `/internal/runtime-links/${RUNTIME_ID}/proxy`;
          if (!url.pathname.startsWith(proxyPrefix)) return new Response(null, { status: 404 });
          if (request.headers.get("authorization") !== `Bearer ${INTERNAL_TOKEN}`) {
            return new Response(null, { status: 401 });
          }

          const gatewayPath = url.pathname.slice(proxyPrefix.length) || "/";
          if (gatewayPath === "/v1/runs" && request.method === "POST") {
            proof.createPosts += 1;
          }

          const eventMatch = /^\/v1\/runs\/([^/]+)\/events$/.exec(gatewayPath);
          if (eventMatch && request.method === "GET") {
            const since = url.searchParams.get("since");
            const lastEventId = request.headers.get("last-event-id");
            const hermesRunId = decodeURIComponent(eventMatch[1]!);
            proof.eventRequests.push({ hermesRunId, since, lastEventId });
            if (proof.eventRequests.length === 1) {
              const first = sseFrame(1, {
                event: "message.delta",
                run_id: hermesRunId,
                timestamp: Date.now() / 1_000,
                delta: "Recovered ",
              });
              let cancelled = false;
              return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(first));
                  const task = (async () => {
                    const committed = await waitForFirstDeltaCommit(observer, AbortSignal.any([request.signal, streamShutdown.signal]));
                    proof.firstDeltaCommitted = committed;
                    if (!committed || cancelled) {
                      try { controller.error(new Error("bounded fixture wait expired")); } catch { /* stream already cancelled */ }
                      return;
                    }
                    try {
                      if (CLEAN_EOF) controller.close();
                      else controller.error(new Error("intentional interruption after committed delta"));
                    }
                    catch { /* consumer already closed the stream */ }
                  })().catch(() => {
                    try { controller.error(new Error("fixture observation failed")); } catch { /* stream already closed */ }
                  });
                  streamTasks.add(task);
                  void task.then(() => { streamTasks.delete(task); });
                },
                cancel() { cancelled = true; },
              }), {
                headers: {
                  "Content-Type": "text/event-stream; charset=utf-8",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                },
              });
            }

            if (!STATUS_RECOVERY && proof.eventRequests.length !== 2) return new Response(null, { status: 500 });
            proof.replayStartedAfterCommit = await firstDeltaCommitted(observer);
            if (!proof.replayStartedAfterCommit || since !== "1" || lastEventId !== "1") {
              return new Response(null, { status: 409 });
            }
            if (STATUS_RECOVERY) return eventResponse("");
            return eventResponse([
              sseFrame(2, {
                event: "message.delta",
                run_id: hermesRunId,
                timestamp: Date.now() / 1_000,
                delta: "from replay.",
              }),
              sseFrame(3, {
                event: "run.completed",
                run_id: hermesRunId,
                timestamp: Date.now() / 1_000,
                output: FINAL_OUTPUT,
                usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
                messages: [{ role: "assistant", content: FINAL_OUTPUT }],
              }),
            ].join(""));
          }

          const statusMatch = /^\/v1\/runs\/([^/]+)$/.exec(gatewayPath);
          if (STATUS_RECOVERY && statusMatch && request.method === "GET") {
            proof.statusPolls += 1;
            return Response.json({ run_id: decodeURIComponent(statusMatch[1]!), status: STATUS_FAILURE ? "failed" : "completed", output: FINAL_OUTPUT,
              usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } });
          }
          let body: ArrayBuffer | undefined;
          if (request.method !== "GET" && request.method !== "HEAD") {
            body = await request.arrayBuffer();
          }
          const headers = new Headers(request.headers);
          headers.set("authorization", `Bearer ${GATEWAY_TOKEN}`);
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
            return Response.json({ ...capabilities, features: { ...features, event_replay: true } }, {
              status: upstream.status,
            });
          }

          if (gatewayPath === "/v1/runs" && request.method === "POST" && upstream.ok) {
            const requestBody = body ? JSON.parse(new TextDecoder().decode(body)) as { session_id?: unknown } : {};
            if (typeof requestBody.session_id === "string") proof.createSessionIds.push(requestBody.session_id);
            const data = await upstream.arrayBuffer();
            return new Response(data, { status: upstream.status, headers: upstream.headers });
          }
          return upstream;
        },
      });

      const relayOrigin = `http://127.0.0.1:${relay.port}`;
      currentPhase = "seed-fake-session";
      const fakeSession = await fetch(`${fakeOrigin}/api/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ id: SESSION_ID, title: "Replay thread" }),
      });
      assert(fakeSession.status === 201, "fake gateway session setup failed");

      const workerConfig = {
        workerId: `worker-${crypto.randomUUID()}`,
        apiInternalUrl: relayOrigin,
        runtimeLinkInternalUrl: relayOrigin,
        internalSecrets: testInternalSecrets("worker", INTERNAL_TOKEN),
        tokenEncryption: {} as WorkerConfig["tokenEncryption"],
        hermesMtls: null,
        hermesEndpointPolicy: {
          environment: "development",
          insecureOrigins: new Set([`127.0.0.1:${fake!.port}`]),
        } as WorkerConfig["hermesEndpointPolicy"],
        leaseSeconds: 30,
        runInactivityMs: 10_000,
        runTimeoutMs: 20_000,
        reconciliationTimeoutMs: 3_000,
        billingEnforced: false,
        cachedInputTokenWeight: 0,
        webAppUrl: "http://127.0.0.1:1420",
      } satisfies WorkerConfig;

      currentPhase = "claim-run";
      const claimed = await claimRun(workerDb, workerConfig);
      if (!claimed) {
        const visible = await workerDb<Array<{ runs: number; runtimes: number }>>`
          select
            (select count(*)::int from runs where id = ${RUN_ID}) as runs,
            (select count(*)::int from runtimes where id = ${RUNTIME_ID}) as runtimes
        `;
        const state = await owner<Array<{
          runStatus: string;
          externalState: string;
          runInDeadline: boolean;
          reachability: string;
          active: boolean;
          linkFresh: boolean;
        }>>`
          select run.status as "runStatus", run.external_state as "externalState",
                 (run.deadline_at is null or run.deadline_at > now()) as "runInDeadline",
                 runtime.reachability, runtime.is_active as active,
                 (runtime.link_last_seen_at > now() - interval '45 seconds') as "linkFresh"
            from runs run join runtimes runtime on runtime.organization_id = run.organization_id
           where run.organization_id = ${ORGANIZATION_ID} and run.id = ${RUN_ID}
        `;
        claimProbe = { visible: visible[0] ?? null, state: state[0] ?? null };
      }
      assert(claimed?.id === RUN_ID && Number(claimed.leaseGeneration) === 1, "real queue claim did not acquire the seeded run");
      const abort = new AbortController();
      let runTimer: ReturnType<typeof setTimeout> | null = null;
      const execution = executeRun(workerDb, workerConfig, claimed, abort.signal);
      try {
        currentPhase = "execute-with-replay";
        await Promise.race([
          execution,
          new Promise<never>((_, reject) => {
            runTimer = setTimeout(() => {
              abort.abort("bounded integration fixture timeout");
              reject(new Error("worker run exceeded its fixture deadline"));
            }, 25_000);
          }),
        ]);
      } finally {
        if (runTimer) clearTimeout(runTimer);
        abort.abort("fixture cleanup");
        await Promise.race([execution.then(() => undefined, () => undefined), Bun.sleep(1_000)]);
      }

      const runs = await observer<Array<{
        status: string;
        hermesRunId: string | null;
        watermark: number;
        eventsComplete: boolean;
        generation: number;
        sessionKey: string | null;
        threadSessionId: string;
        botId: string;
        threadId: string;
      }>>`
        select run.status, run.hermes_run_id as "hermesRunId", run.last_hermes_sequence as watermark, run.events_complete as "eventsComplete",
               run.lease_generation::int as generation, coalesce(run.execution_session_key, thread.hermes_session_id) as "sessionKey",
               thread.hermes_session_id as "threadSessionId", run.bot_id as "botId", run.thread_id as "threadId"
          from runs run join threads thread on thread.organization_id = run.organization_id and thread.id = run.thread_id
         where run.organization_id = ${ORGANIZATION_ID} and run.id = ${RUN_ID}
      `;
      const rows = await observer<Array<{
        runId: string;
        botId: string | null;
        threadId: string;
        turnId: string | null;
        sessionKey: string | null;
        leaseGeneration: number | null;
        sequence: number;
        type: string;
      }>>`
        select run_id as "runId", bot_id as "botId", thread_id as "threadId", turn_id as "turnId",
               session_key as "sessionKey", lease_generation::int as "leaseGeneration", sequence, type
          from run_events
         where organization_id = ${ORGANIZATION_ID} and run_id = ${RUN_ID} and type <> 'message.admitted'
         order by sequence
      `;
      const messages = await observer<Array<{
        role: string;
        threadId: string;
        runId: string | null;
        authorBotId: string | null;
        text: string | null;
      }>>`
        select role, thread_id as "threadId", run_id as "runId", author_bot_id as "authorBotId",
               content #>> '{0,text}' as text
          from messages
         where organization_id = ${ORGANIZATION_ID} and thread_id = ${THREAD_ID} and role = 'assistant'
      `;

      currentPhase = "assert-replay-identities";
      await assertAdmittedMessageDurable(observer, admitted, messageIdentity);
      const run = runs[0];
      assert(run?.status === (STATUS_FAILURE ? "failed" : "completed"), "run did not reach the expected recovered terminal state");
      assert(run.hermesRunId !== null && run.hermesRunId.startsWith("fake_"), "Hermes run identity was not retained");
      assert(run.watermark === (STATUS_RECOVERY ? 1 : 3), "raw event sequence watermark changed during recovery");
      assert(run.eventsComplete === !STATUS_RECOVERY, "status recovery misreported complete native event history");
      assert(run.generation === 1, "run lease generation changed during one worker execution");
      assert(run.sessionKey === SESSION_ID && run.threadSessionId === SESSION_ID, "session identity changed during replay");
      assert(run.botId === BOT_ID && run.threadId === THREAD_ID, "run bot or thread identity changed");
      assert(proof.createPosts === 1, "replay created a second Hermes run");
      assert(proof.createSessionIds.length === 1 && proof.createSessionIds[0] === SESSION_ID, "Hermes create used a different session identity");
      assert(proof.eventRequests.length === (STATUS_RECOVERY ? 4 : 2), "expected a bounded number of replay streams");
      assert(proof.eventRequests[0]?.since === "0" && proof.eventRequests[0]?.lastEventId === "0", "initial replay cursor did not start at zero");
      assert(proof.eventRequests[1]?.since === "1" && proof.eventRequests[1]?.lastEventId === "1", "replay did not resume from the committed cursor");
      assert(proof.eventRequests.every((event) => event.hermesRunId === run.hermesRunId), "event replay switched Hermes run identity");
      assert(proof.firstDeltaCommitted && proof.replayStartedAfterCommit, "stream interruption/replay was not fenced by the committed first delta");
      assert(rows.length === (STATUS_RECOVERY ? 2 : 3) && rows.map((row) => row.sequence).join(",") === (STATUS_RECOVERY ? "1,2" : "1,2,3"), "replayed event rows are missing or duplicated");
      assert(STATUS_RECOVERY ? proof.statusPolls === 1 && rows.filter((row) => row.type === "agent.message").length === 1 : proof.statusPolls === 0,
        "status recovery appended a duplicate answer or used an unexpected polling path");
      assert(rows.every((row) => row.runId === RUN_ID && row.botId === BOT_ID && row.threadId === THREAD_ID), "run event identity columns changed");
      assert(rows.every((row) => row.turnId === RUN_ID && row.sessionKey === SESSION_ID && row.leaseGeneration === 1), "turn/session/lease identity columns changed");
      assert(messages.length === (STATUS_FAILURE ? 0 : 1), "replay created duplicate or missing assistant messages");
      if (!STATUS_FAILURE) {
        assert(messages[0]?.role === "assistant" && messages[0]?.runId === RUN_ID && messages[0]?.threadId === THREAD_ID && messages[0]?.authorBotId === BOT_ID, "assistant message identity changed");
        assert(messages[0]?.text === FINAL_OUTPUT, "assistant message does not contain the replayed final output");
      }
      assert(rows.filter((row) => row.type === (STATUS_FAILURE ? "run.error" : "run.completed")).length === 1,
        "recovery terminal event was missing or duplicated");

      console.info(JSON.stringify({
        test: "run-identity-replay",
        passed: true,
        recoveryMode: STATUS_FAILURE ? "partial_text_then_failed_status" : STATUS_RECOVERY ? "partial_text_then_status" : CLEAN_EOF ? "clean_eof_replay" : "event_replay",
        createPosts: proof.createPosts,
        eventStreams: proof.eventRequests.length,
        statusPolls: proof.statusPolls,
        replaySince: 1,
        committedEventRows: rows.length,
        assistantMessages: messages.length,
        admittedUserMessages: 1,
        admissionHttpStatus: 202,
        durableAdmissionReceipts: 1,
        userMessageDurableAcrossReplay: true,
        watermark: run.watermark,
        eventsComplete: run.eventsComplete,
        stableRunBotThreadSessionTurnLease: true,
      }));
      } finally {
        streamShutdown.abort("fixture streams closed");
        relay?.stop(true);
        relay = null;
        // Observation tasks settle before the helper closes their SQL client.
        await Promise.allSettled(streamTasks);
      }
    });
  } finally {
    (relay as Server<undefined> | null)?.stop(true);
    fake?.stop(true);
    if (previousGatewayToken === undefined) delete process.env.FAKE_HERMES_TOKEN;
    else process.env.FAKE_HERMES_TOKEN = previousGatewayToken;
  }
}

try {
  await main();
} catch (error) {
  const errorClass = error instanceof Error ? error.name : "UnknownError";
  const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const cause = details.cause && typeof details.cause === "object" ? details.cause as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : "";
  const safeFailure = new Set([
    "fixture admission did not return 202",
    "fixture admission did not return matching message and plain run identities",
    "admitted user message was lost, duplicated or changed",
    "admission receipt was lost, duplicated or changed",
    "real queue claim did not acquire the seeded run",
    "run did not reach the expected recovered terminal state",
    "recovery terminal event was missing or duplicated",
    "Hermes run identity was not retained",
    "raw event sequence watermark changed during recovery",
    "status recovery misreported complete native event history",
    "status recovery appended a duplicate answer or used an unexpected polling path",
    "run lease generation changed during one worker execution",
    "session identity changed during replay",
    "run bot or thread identity changed",
    "replay created a second Hermes run",
    "Hermes create used a different session identity",
    "expected a bounded number of replay streams",
    "initial replay cursor did not start at zero",
    "replay did not resume from the committed cursor",
    "stream interruption/replay was not fenced by the committed first delta",
    "replayed event rows are missing or duplicated",
    "run event identity columns changed",
    "turn/session/lease identity columns changed",
    "replay created duplicate or missing assistant messages",
    "assistant message identity changed",
    "assistant message does not contain the replayed final output",
  ]);
  const safeName = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(message);
    return match?.[1] && /^[A-Za-z_][A-Za-z0-9_]*$/.test(match[1]) ? match[1] : undefined;
  };
  const messageKind = message.includes("violates check constraint") ? "check-constraint"
    : message.includes("violates foreign key constraint") ? "foreign-key-constraint"
      : message.includes("violates unique constraint") ? "unique-constraint"
        : message.includes("null value in column") ? "not-null-constraint"
          : message.includes("does not exist") ? "missing-database-object"
            : message.includes("already exists") ? "duplicate-database-object"
              : "other-database-error";
  console.error(JSON.stringify({
    test: "run-identity-replay",
    passed: false,
    phase: currentPhase,
    errorClass,
    failure: safeFailure.has(message) ? message : undefined,
    claimProbe: currentPhase === "claim-run" ? claimProbe : undefined,
    databaseCode: typeof details.code === "string" ? details.code : undefined,
    nativeDatabaseCode: typeof cause.code === "string" ? cause.code : undefined,
    messageKind,
    constraint: typeof details.constraint === "string" ? details.constraint : safeName(/constraint "([A-Za-z_][A-Za-z0-9_]*)"/i),
    table: typeof details.table === "string" ? details.table : safeName(/relation "([A-Za-z_][A-Za-z0-9_]*)"/i),
    column: typeof details.column === "string" ? details.column : safeName(/column "([A-Za-z_][A-Za-z0-9_]*)"/i),
    errorPropertyNames: Object.keys(details).sort(),
    causePropertyNames: Object.keys(cause).sort(),
  }));
  process.exitCode = 1;
}
