/** The actual API, queue and runner under tenant roles, in an owned disposable database. */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { encryptSecret, secretEncryptionKey } from "../../platform/hermes/src/index";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import { botRoutes } from "../../apps/api/src/routes/roster/bot-routes";
import { claimRun } from "../../modules/execution/src/application/queue";
import { executeRun } from "../../modules/execution/src/application/runner";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { startFakeHermes } from "../fake-hermes/server";
import { FAKE_HERMES_TOKEN } from "../fake-hermes/defaults";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `91020000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1), USER = id(2), SECTION = id(3), RUNTIME = id(4);
const A = id(10), B = id(11), C = id(12), THREAD = id(20);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const hermes = startFakeHermes({ port: 0, delayMs: 5, capacity: 4 });
const scripts: Array<{ output: string; onDispatch?: () => Promise<unknown> }> = [];
const outputs = new Map<string, string>();
const inputs: string[] = [];
const recorder = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.text() : undefined;
    const response = await fetch(`${hermes.url.origin}${url.pathname}${url.search}`, {
      method: request.method, headers: request.headers, body,
    });
    if (request.method === "POST" && url.pathname === "/v1/runs" && response.ok) {
      const run = await response.clone().json() as { run_id: string };
      const script = scripts.shift();
      assert(script, "Unexpected Hermes dispatch");
      inputs.push((JSON.parse(body ?? "{}") as { input: string }).input);
      outputs.set(run.run_id, script.output);
      await script.onDispatch?.();
    }
    if (url.pathname.endsWith("/events") && response.ok) {
      const raw = await response.text();
      const rewritten = raw.replace(/^data: (.+)$/gm, (_line, json: string) => {
        const frame = JSON.parse(json) as { event: string; run_id: string; output?: string; delta?: string };
        const output = outputs.get(frame.run_id);
        if (frame.event === "run.completed") frame.output = output;
        if (frame.event === "message.delta") frame.delta = "";
        return `data: ${JSON.stringify(frame)}`;
      });
      return new Response(rewritten, { headers: response.headers });
    }
    return response;
  },
});

try {
  await withDisposablePostgres("openedbot102_coordination", async ({ owner, connect }) => {
    const api = await connect("openedbot_api"), worker = await connect("openedbot_worker");
    const key = secretEncryptionKey(new Uint8Array(32).fill(102));
    const endpoint = recorder.url.toString().replace(/\/$/, "");
    const bearer = encryptSecret(FAKE_HERMES_TOKEN, key.value);
    await owner`insert into users (id, email) values (${USER}, 'openedbot102@example.test')`;
    await owner`insert into organizations (id, slug, name) values (${ORG}, 'openedbot102', 'OPENEDBOT102')`;
    await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
    await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Coordination', 0)`;
    await owner`insert into runtimes (id, organization_id, name, reachability, endpoint,
        token_ciphertext, token_nonce, token_tag, token_key_id, is_active, capacity, last_health_status, last_probed_at)
      values (${RUNTIME}, ${ORG}, 'Isolated fake Hermes', 'direct', ${endpoint},
        ${bearer.ciphertext}, ${bearer.nonce}, ${bearer.tag}, ${key.id}, true, 4, 'healthy', now() + interval '1 hour')`;
    for (const [bot, slug, position] of [[A, "alpha", 0], [B, "bravo", 1], [C, "charlie", 2]] as const) {
      await owner`insert into bots (id, organization_id, section_id, name, slug, position, autonomy_enabled)
        values (${bot}, ${ORG}, ${SECTION}, ${slug}, ${slug}, ${position}, ${bot === A})`;
      await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
        values (${bot === A ? THREAD : bot === B ? id(21) : id(22)}, ${ORG}, ${bot}, 'DM', ${`openedbot102-${slug}`}, true)`;
    }
    const config: WorkerConfig = {
      workerId: "openedbot102-worker", apiInternalUrl: "http://127.0.0.1:9", internalSecrets: testInternalSecrets("worker", "openedbot102"),
      tokenEncryption: { current: key, previous: [] }, hermesMtls: null,
      hermesEndpointPolicy: { environment: "test", testHttpUrl: endpoint } as WorkerConfig["hermesEndpointPolicy"],
      leaseSeconds: 30, runInactivityMs: 20_000, runTimeoutMs: 30_000, reconciliationTimeoutMs: 10_000,
      billingEnforced: false, cachedInputTokenWeight: 0.1, webAppUrl: "http://127.0.0.1:1420",
    };
    const auth: AuthContext = {
      sessionId: "openedbot102-session", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "openedbot102",
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.onError((error, context) => {
      if (error instanceof HttpError) return context.json({ error: error.code }, error.status as ContentfulStatusCode);
      console.error(`Fixture route failure: ${error.name}: ${error.message}`);
      return context.json({ error: "Fixture route failed" }, 500);
    });
    app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
    app.route("/", conversationRoutes(api, {} as BlobStore, { billingEnforced: false } as ApiConfig));
    app.route("/bots", botRoutes(api, { billingEnforced: false } as ApiConfig));
    const send = async (input = "Perform the bounded task") => {
      const response = await app.request(`/${THREAD}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }),
      });
      assert(response.status === 202, `Admission HTTP ${response.status}`);
      return await response.json() as { runId: string; workflowId: string | null };
    };
    const execute = async (output: string, onDispatch?: () => Promise<unknown>) => {
      scripts.push({ output, onDispatch });
      const run = await claimRun(worker, config);
      assert(run, "Expected a queued step");
      await executeRun(worker, config, run);
      const stored = (await owner`select status, error_code as "errorCode" from runs where id = ${run.id}`)[0];
      assert(stored.status === "completed", `Step failed: ${stored.errorCode}`);
      assert(scripts.length === 0, "The runner did not dispatch the expected step");
      return run.id;
    };
    const workflow = async (workflowId: string) => (await owner`
      select status, autonomy_enabled as enabled, used_steps as steps, used_handoffs as handoffs
        from workflows where id = ${workflowId}`)[0];
    const receipts = (workflowId: string) => owner<Array<{ runId: string; threadId: string; payload: Record<string, unknown> }>>`
      select e.run_id as "runId", e.thread_id as "threadId", e.payload from run_events e
        join runs r on r.id = e.run_id where r.workflow_id = ${workflowId} and e.type = 'system.notice'
       order by e.cursor`;
    const proof: Array<Record<string, unknown>> = [];

    const excessive = await app.request(`/bots/${A}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomy: {
        enabled: true, maxDepth: 999, maxSteps: 999, maxHandoffs: 999, timeoutSeconds: 9999, tokenBudget: 9999999,
      } }),
    });
    assert(excessive.status === 400, `Excessive policy PATCH HTTP ${excessive.status}`);
    const validCeiling = await app.request(`/bots/${A}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomy: {
        enabled: true, maxDepth: 4, maxSteps: 12, maxHandoffs: 8, timeoutSeconds: 3600, tokenBudget: 200000,
      } }),
    });
    assert(validCeiling.status === 200, `Valid policy PATCH HTTP ${validCeiling.status}`);
    const bounded = (await validCeiling.json() as { autonomy: Record<string, number | boolean> }).autonomy;
    assert(bounded.maxDepth === 4 && bounded.maxSteps === 12 && bounded.maxHandoffs === 8
      && bounded.timeoutSeconds === 3600 && bounded.tokenBudget === 200000, "PATCH widened the hard ceilings");
    await owner`update bots set autonomy_max_depth = 3, autonomy_max_steps = 8, autonomy_max_handoffs = 4,
      autonomy_timeout_seconds = 1800, autonomy_token_budget = 120000 where id = ${A}`;
    proof.push({ scenario: "actual-policy-PATCH", hardCeilings: true });

    // One real delegated step, one reserved continuation, all in the original thread.
    const root = await send(); assert(root.workflowId, "Coordination admission needs a workflow");
    assert(await execute("Useful partial work.\n@bravo Verify one fact.") === root.runId, "Wrong root");
    const child = await execute("Verified result.");
    const continuation = await execute("Final synthesis.");
    const chain = await owner<Array<{ id: string; botId: string; threadId: string; kind: string; callerRunId: string | null; resumesRunId: string | null }>>`select id, bot_id as "botId", thread_id as "threadId", step_kind as kind,
      caller_run_id as "callerRunId", resumes_run_id as "resumesRunId" from runs
      where workflow_id = ${root.workflowId} order by step_index`;
    assert(chain.length === 3 && chain[0]?.botId === A && chain[1]?.botId === B && chain[2]?.botId === A,
      "Expected the actual A/B/A chain");
    assert(chain.every((run) => run.threadId === THREAD) && chain[1]?.callerRunId === root.runId
      && chain[2]?.resumesRunId === root.runId, "Child and continuation identity");
    const notes = await receipts(root.workflowId);
    assert(notes.some((note) => note.payload.childRunId === child)
      && notes.some((note) => note.payload.continuationRunId === continuation), "Missing navigable receipts");
    assert(notes.every((note) => note.threadId === THREAD), "Coordination leaked into a forever-chat");
    assert((await workflow(root.workflowId)).status === "completed", "Workflow did not finish");
    proof.push({ scenario: "A/B/A", steps: chain.length, receipts: notes.length, sameThread: true });

    // The operator turns A off AFTER the runtime received its run, not before readContext.
    const switched = await send(); assert(switched.workflowId, "Toggle fixture workflow");
    await execute("Partial result.\n@bravo Do a new task.", () => owner`
      update bots set autonomy_enabled = false where id = ${A}`);
    const switchNotes = await receipts(switched.workflowId);
    assert(switchNotes.some((note) => note.payload.reason === "AUTONOMY_DISABLED"), "Stale flag allowed a child");
    assert(!(await owner`select id from runs where workflow_id = ${switched.workflowId} and step_kind = 'delegated'`).length,
      "A child was created after the toggle was turned off");
    assert((await workflow(switched.workflowId)).enabled === true, "The immutable snapshot was rewritten");
    proof.push({ scenario: "disabled-after-dispatch", refused: true, snapshotPreserved: true });

    // Disabling the caller after descent never discards the already owed continuation.
    await owner`update bots set autonomy_enabled = true where id = ${A}`;
    const unwind = await send(); assert(unwind.workflowId, "Unwind fixture workflow");
    await execute("Partial.\n@bravo Verify.");
    await owner`update bots set autonomy_enabled = false where id = ${A}`;
    await execute("Verified.");
    await execute("Final.");
    assert((await workflow(unwind.workflowId)).status === "completed", "Disabling lost the continuation");
    proof.push({ scenario: "disabled-after-descent", resumed: true });

    // Human mention remains available with the toggle off and maxHandoffs zero.
    await owner`update bots set autonomy_max_handoffs = 0 where id = ${A}`;
    const human = await send("@bravo Verify this for me."); assert(human.workflowId, "Human mention workflow");
    await execute("Verified."); await execute("Synthesis.");
    assert((await workflow(human.workflowId)).status === "completed", "Human mention blocked by toggle");
    proof.push({ scenario: "human-mention-off-zero-handoffs", resumed: true });
    await owner`update bots set autonomy_enabled = true, autonomy_max_handoffs = 4 where id = ${A}`;

    // B cannot delegate to A while A remains in its active caller stack.
    await owner`update bots set autonomy_enabled = true where id = ${B}`;
    const cycle = await send(); assert(cycle.workflowId, "Cycle fixture workflow");
    await execute("Partial.\n@bravo Verify.");
    await execute("@alpha Delegate back.");
    assert((await receipts(cycle.workflowId)).some((note) => note.payload.reason === "CALL_CYCLE"), "Missing cycle refusal");
    assert((await owner`select count(*)::int as n from runs where workflow_id = ${cycle.workflowId}`)[0].n === 2
      && (await workflow(cycle.workflowId)).status === "failed", "The cycle created another run");
    await owner`update bots set autonomy_enabled = false where id = ${B}`;
    proof.push({ scenario: "CALL_CYCLE", notice: true, noNewChild: true, emptyBodyFailed: true });

    const unknown = await send(); assert(unknown.workflowId, "Unlisted-target fixture workflow");
    await execute("@unlisted-bot Task.");
    assert((await receipts(unknown.workflowId)).some((note) => note.payload.reason === "TARGET_INACTIVE"
      && note.payload.targetBotId === null && note.payload.targetSlug === "unlisted-bot"), "Missing unlisted target refusal");
    assert((await workflow(unknown.workflowId)).status === "failed", "Empty unlisted directive became a final answer");
    proof.push({ scenario: "unlisted-target", notice: true, noChild: true, emptyBodyFailed: true });

    for (const reason of ["AUTONOMY_DISABLED", "TARGET_SELF", "TARGET_INACTIVE", "DEPTH_LIMIT", "STEP_LIMIT", "HANDOFF_LIMIT",
      "TOKEN_BUDGET_EXHAUSTED", "WORKFLOW_DEADLINE_EXCEEDED"] as const) {
      const test = await send(); assert(test.workflowId, "Refusal fixture workflow");
      if (reason === "TARGET_INACTIVE") await owner`update bots set archived_at = now() where id = ${B}`;
      if (reason === "DEPTH_LIMIT") await owner`update runs set stack_depth = 4, caller_bot_id = ${C} where id = ${test.runId}`;
      if (reason === "STEP_LIMIT") await owner`update workflows set max_steps = 1 where id = ${test.workflowId}`;
      if (reason === "HANDOFF_LIMIT") await owner`update workflows set max_handoffs = 0 where id = ${test.workflowId}`;
      if (reason === "TOKEN_BUDGET_EXHAUSTED") await owner`update workflows set used_tokens = token_budget where id = ${test.workflowId}`;
      // Expire only after dispatch; admission/claim must not consume this test before completion.
      const expire = reason === "WORKFLOW_DEADLINE_EXCEEDED"
        ? () => owner`update workflows set deadline_at = now() - interval '1 second' where id = ${test.workflowId}`
        : reason === "AUTONOMY_DISABLED" ? () => owner`update bots set autonomy_enabled = false where id = ${A}` : undefined;
      await execute(`${reason === "TARGET_SELF" ? "@alpha" : "@bravo"} Perform task.`, expire);
      const rejection = (await receipts(test.workflowId)).find((note) => note.payload.reason === reason);
      assert(rejection, `Missing refusal ${reason}`);
      const state = await workflow(test.workflowId);
      assert(state.status === "failed", `${reason} with no body must fail, got ${state.status}`);
      assert(!(await owner`select id from runs where workflow_id = ${test.workflowId} and step_kind = 'delegated'`).length,
        `${reason} created an unauthorized child`);
      await owner`update bots set archived_at = null where id = ${B}`;
      await owner`update bots set autonomy_enabled = true where id = ${A}`;
      proof.push({ scenario: reason, notice: true, noChild: true, emptyBodyFailed: true });
    }
    assert(inputs.every((input) => input.includes("[Workflow limits]")), "Step limits must remain in input");
    console.log(JSON.stringify({ event: "openedbot102.postgres-proof", passed: true, proof }));
  });
} finally {
  recorder.stop(true); hermes.stop(true);
}
