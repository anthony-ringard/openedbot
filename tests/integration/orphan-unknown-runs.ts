/**
 * S2a characterized, S2b fixes (ADR 0001, section 5; defect D1 of
 * docs/architecture/0002-invariants-des-runs.md): a run in `unknown` outside
 * the root-DM review of 0091 (no initiator, not a root, or inserted directly
 * in `unknown`). Either a review path exists, or the case is proven impossible.
 *
 * What this proves, against a disposable PostgreSQL, the real producers (the
 * S2b creation commands), the real claim, the real lease reaper
 * (`sweepExpiredRuns`) and the real review routes:
 *
 *  1. Inserted directly in `unknown`: impossible in production. The only
 *     `insert into runs` is the creation primitive (`run-writes-contract.ts`),
 *     which refuses any status but `queued` or `relaying` (unit tests). The
 *     database itself still accepts it (the review trigger is `before update
 *     of status`), so a direct insert in `unknown` gets no workflow.
 *  2. Root DM of a member: keeps its initiator and gets its review workflow.
 *  3. Every other run without a workflow that becomes `unknown` now gets one
 *     too (0175): a persona draft (current path), the inbound run of a legacy
 *     handoff (its producer is only reached from legacy DM runs, so it is
 *     called directly), a DM whose initiator was nulled (an agency operator's
 *     deleted account, simulated) and a legacy room turn (a `group` review).
 *     The review routes settle them: abandon frees the thread, the runtime
 *     slot and the bot; a retry is refused for a service run, a legacy
 *     inbound handoff (it could not deliver to its courier) and a room.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import { encryptSecret, secretEncryptionKey } from "../../platform/hermes/src/index.ts";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import { runRoutes } from "../../apps/api/src/routes/conversation/run-routes";
import { workflowRoutes } from "../../apps/api/src/routes/execution/workflow-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { claimRun, sweepExpiredRuns } from "../../modules/execution/src/application/queue";
import { greetNewBotTx } from "../../modules/execution/src/application/run-creation";
import { createHandoffTx } from "../../modules/execution/src/application/runner/handoff";
import { chainLegacyRoomTurnTx } from "../../modules/execution/src/application/runner/workflow-steps";
import type { RunContext } from "../../modules/execution/src/application/runner/types";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { queuePersonaDraft } from "../../modules/roster/src/application/persona-drafts";
import { botRuns } from "../../modules/execution/src/application/bot-runs";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const USER = id(2);
const RUNTIME = id(3);
const SECTION = id(4);
const GROUP = id(5);
const bots = { neo: id(101), trinity: id(102), morpheus: id(103), tank: id(104) };
const threads = { neo: id(201), trinity: id(202), morpheus: id(203), tank: id(204), direct: id(205), room: id(206) };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await withDisposablePostgres("openedbot2_s2b_unknown", async ({ owner, connect }) => {
  const api = await connect("openedbot_api");
  const worker = await connect("openedbot_worker");
  const key = secretEncryptionKey(new Uint8Array(32).fill(7));
  const bearer = encryptSecret("s2a-unused", key.value);
  await owner`insert into users (id, email) values (${USER}, 's2a-unknown@example.test')`;
  await owner`insert into organizations (id, slug, name) values (${ORG}, 's2a-unknown', 's2a-unknown')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'S2a', 0)`;
  // Never called: the worker crashes during the create, before any request.
  await owner`insert into runtimes (
      id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
      is_active, capacity, last_health_status, last_probed_at
    ) values (
      ${RUNTIME}, ${ORG}, 'Hermes', 'direct', 'http://127.0.0.1:9', ${bearer.ciphertext}, ${bearer.nonce},
      ${bearer.tag}, ${key.id}, true, 2, 'healthy', now() + interval '1 hour'
    )`;
  let position = 0;
  for (const [name, botId] of Object.entries(bots)) {
    await owner`insert into bots (id, organization_id, section_id, name, slug, position)
      values (${botId}, ${ORG}, ${SECTION}, ${name}, ${name}, ${position++})`;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${threads[name as keyof typeof threads]}, ${ORG}, ${botId}, 'DM', ${`s2a-${name}`}, true)`;
  }
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${threads.direct}, ${ORG}, ${bots.tank}, 'Direct', 's2a-direct', false)`;
  await owner`insert into bot_groups (id, organization_id, section_id, name, position)
    values (${GROUP}, ${ORG}, ${SECTION}, 'Salon', 0)`;
  await owner`insert into threads (id, organization_id, group_id, title, hermes_session_id)
    values (${threads.room}, ${ORG}, ${GROUP}, 'Salon', 's2a-room')`;

  const config: WorkerConfig = {
    workerId: "s2a-worker",
    apiInternalUrl: "http://127.0.0.1:9",
    internalSecrets: testInternalSecrets("worker", "s2a"),
    tokenEncryption: { current: key, previous: [] },
    hermesMtls: null,
    hermesEndpointPolicy: { environment: "test", testHttpUrl: "http://127.0.0.1:9" } as WorkerConfig["hermesEndpointPolicy"],
    leaseSeconds: 30,
    runInactivityMs: 20_000,
    runTimeoutMs: 30_000,
    reconciliationTimeoutMs: 10_000,
    billingEnforced: false,
    cachedInputTokenWeight: 0.1,
    webAppUrl: "http://127.0.0.1:1420",
  };

  const auth: AuthContext = {
    sessionId: "s2a-session", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "s2a",
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 409)
    : context.json({ code: "INTERNAL", message: String(error) }, 500));
  app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  app.route("/threads", conversationRoutes(api, {} as BlobStore, { billingEnforced: false } as ApiConfig));
  app.route("/runs", runRoutes(api));
  app.route("/workflows", workflowRoutes(api));
  const post = async (path: string, json?: unknown) => {
    const response = await app.request(path, {
      method: "POST",
      ...(json === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }),
    });
    const body = response.status === 204 ? null : await response.json() as { code?: string };
    return { status: response.status, code: body?.code ?? null };
  };

  type RunRow = {
    status: string; workflowId: string | null; stepKind: string | null; initiator: string | null;
    externalState: string; errorCode: string | null; reviewWorkflows: number;
    reviewKind: string | null; reviewStatus: string | null; reviewInitiator: string | null;
  };
  const runRow = async (runId: string) => (await owner<RunRow[]>`
    select runs.status, runs.workflow_id as "workflowId", runs.step_kind as "stepKind",
           runs.initiator_user_id as "initiator", runs.external_state as "externalState", runs.error_code as "errorCode",
           (select count(*)::int from workflows w where w.root_run_id = runs.id) as "reviewWorkflows",
           review.kind as "reviewKind", review.status as "reviewStatus", review.initiator_user_id as "reviewInitiator"
      from runs left join workflows review on review.id = runs.workflow_id
     where runs.id = ${runId}`)[0]!;
  // The review path of an orphan of S2a: one `unknown` workflow rooted at the run.
  const assertReviewed = (row: RunRow, kind: "dm" | "group", label: string) => {
    assert(row.status === "unknown" && row.errorCode === "HERMES_CREATE_OUTCOME_UNKNOWN",
      `${label} did not become unknown: ${JSON.stringify(row)}`);
    assert(row.workflowId !== null && row.reviewWorkflows === 1 && row.reviewStatus === "unknown" && row.reviewKind === kind,
      `${label} in unknown has no ${kind} review workflow: ${JSON.stringify(row)}`);
  };

  // The worker claims the run, posts `external_state = 'creating'` before the
  // Hermes create (provider-recovery.ts), then dies: its lease expires with no
  // Hermes id. The real reaper turns it `unknown` (HERMES_CREATE_OUTCOME_UNKNOWN).
  const loseLeaseDuringCreate = async (runId: string) => {
    const claimed = await claimRun(worker, config);
    assert(claimed?.id === runId, `expected to claim ${runId}, claimed ${claimed?.id ?? "nothing"}`);
    await worker`update runs set external_state = 'creating', events_complete = false,
        lease_expires_at = now() - interval '1 second', updated_at = now()
       where id = ${runId} and lease_owner = ${config.workerId} and status = 'starting'`;
    await sweepExpiredRuns(worker, config);
    return runRow(runId);
  };

  const proof: Array<Record<string, unknown>> = [];

  // 1b. The database does not refuse a direct insert in `unknown`, and the
  // review trigger (before update of status) does not see it.
  const direct = id(301);
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, step_index, step_kind,
      initiator_user_id, external_state)
    values (${direct}, ${ORG}, ${threads.direct}, ${bots.tank}, 'direct', 'unknown', 0, 'root', ${USER}, 'ambiguous')`;
  const directRow = await runRow(direct);
  assert(directRow.status === "unknown" && directRow.workflowId === null && directRow.reviewWorkflows === 0,
    `a direct insert in unknown unexpectedly got a workflow: ${JSON.stringify(directRow)}`);
  proof.push({ case: "insert direct en unknown (SQL brut)", ...directRow, production: "impossible (primitive + garde)" });
  await owner`delete from runs where id = ${direct}`;

  // 2. Root DM: the real producer sets the initiator, the account erasure
  // cannot null it while a membership row exists, and the trigger opens the
  // review workflow.
  const greeting = await worker.begin((tx) => greetNewBotTx(tx, {
    organizationId: ORG, threadId: threads.morpheus, botId: bots.morpheus, initiatorUserId: USER, input: "hello",
  }));
  await owner`update memberships set revoked_at = now() where organization_id = ${ORG} and user_id = ${USER}`;
  const erased = (await owner<Array<{ outcome: string }>>`select erase_account_user(${USER}) as outcome`)[0]!.outcome;
  assert(erased === "pseudonymized", `a user with a membership row was ${erased}, not pseudonymized`);
  await owner`update memberships set revoked_at = null where organization_id = ${ORG} and user_id = ${USER}`;
  const greetingRow = await loseLeaseDuringCreate(greeting);
  assert(greetingRow.initiator === USER, `the root DM lost its initiator: ${JSON.stringify(greetingRow)}`);
  assert(greetingRow.status === "unknown" && greetingRow.workflowId !== null && greetingRow.reviewWorkflows === 1,
    `the root DM in unknown got no review workflow: ${JSON.stringify(greetingRow)}`);
  proof.push({ case: "DM racine (accueil), initiateur gardé", ...greetingRow, review: "workflow dm (0091, 0175)" });
  // Settle it the way the review does (abandon), so it holds no capacity.
  await owner`update runs set status = 'failed', updated_at = now() where id = ${greeting}`;

  // 3a. Inbound handoff: created by the real courier transaction, called
  // directly because only a legacy DM run (no `step_kind`) reaches it.
  const handoffContext = {
    id: id(302), organizationId: ORG, threadId: threads.neo, botId: bots.neo, botName: "neo", botSlug: "neo",
  } as unknown as RunContext;
  await worker.begin((tx) => createHandoffTx(tx, handoffContext, {
    botId: bots.trinity, slug: "trinity", name: "trinity", threadId: threads.trinity, message: "please check",
  }));
  const pair = (await owner<Array<{ inbound: string; courier: string }>>`
    select inbound.id as inbound, courier.id as courier from runs inbound
      join runs courier on courier.id = inbound.origin_run_id
     where inbound.thread_id = ${threads.trinity}`)[0]!;
  const inboundRow = await loseLeaseDuringCreate(pair.inbound);
  assert(inboundRow.stepKind === null && inboundRow.initiator === null, "the inbound handoff shape changed");
  assertReviewed(inboundRow, "dm", "the inbound handoff");
  assert(inboundRow.reviewInitiator === null, "the inbound review invented an initiator");
  // The stop and cancel routes still send the operator to the review, which now exists.
  const stopTarget = await post(`/threads/${threads.trinity}/stop`);
  const cancelInbound = await post(`/runs/${pair.inbound}/cancel`);
  assert(stopTarget.status === 409 && stopTarget.code === "WORKFLOW_REVIEW_REQUIRED",
    `the target thread stop answered ${JSON.stringify(stopTarget)}`);
  assert(cancelInbound.status === 409 && cancelInbound.code === "WORKFLOW_REVIEW_REQUIRED",
    `the inbound run cancel answered ${JSON.stringify(cancelInbound)}`);
  // A replay could not deliver to the courier: the review settles it by abandon.
  const inboundRetry = await post(`/workflows/${inboundRow.workflowId}/retry`, { confirmDuplicateRisk: true });
  assert(inboundRetry.status === 409 && inboundRetry.code === "WORKFLOW_HANDOFF_RETRY_UNSUPPORTED",
    `the inbound handoff retry answered ${JSON.stringify(inboundRetry)}`);
  // The origin thread is held by the courier, which the operator can still stop.
  const courierBefore = (await runRow(pair.courier)).status;
  const stopOrigin = await post(`/threads/${threads.neo}/stop`);
  const courierAfter = (await runRow(pair.courier)).status;
  assert(courierBefore === "relaying" && stopOrigin.status === 204 && courierAfter === "cancelled",
    `the courier was not freed by the origin stop: ${courierBefore} -> ${JSON.stringify(stopOrigin)} -> ${courierAfter}`);
  assert((await runRow(pair.inbound)).status === "unknown", "stopping the origin thread settled the inbound run");
  proof.push({ case: "handoff entrant (step_kind null)", ...inboundRow, review: "workflow dm 0175, initiateur nul ; relance refusée" });

  // 3b. Persona draft: queued by the real roster command.
  const draft = await queuePersonaDraft(api, botRuns, ORG, bots.neo);
  assert(draft.runId, "the persona draft was not queued");
  const draftRow = await loseLeaseDuringCreate(draft.runId);
  assert(draftRow.stepKind === "persona_draft", `the persona draft shape changed: ${JSON.stringify(draftRow)}`);
  assertReviewed(draftRow, "dm", "the persona draft");
  let refused: string | null = null;
  try { await queuePersonaDraft(api, botRuns, ORG, bots.neo); } catch (error) {
    refused = error instanceof HttpError ? error.code : String(error);
  }
  assert(refused === "BOT_BUSY", `a new persona draft was accepted while the first one awaits review: ${refused}`);
  // A service run is not replayed as a workflow: it is relaunched from the bot.
  const draftRetry = await post(`/workflows/${draftRow.workflowId}/retry`, { confirmDuplicateRisk: true });
  assert(draftRetry.status === 409 && draftRetry.code === "WORKFLOW_SERVICE_RETRY_UNSUPPORTED",
    `the persona draft retry answered ${JSON.stringify(draftRetry)}`);
  assert((await runRow(draft.runId)).status === "unknown", "a refused retry touched the persona draft");
  proof.push({ case: "brouillon de persona", ...draftRow, review: "workflow dm 0175 ; relance refusée" });

  // 3c. Until reviewed, both hold their thread and a slot of the capacity (2).
  const blocked = await worker.begin((tx) => greetNewBotTx(tx, {
    organizationId: ORG, threadId: threads.trinity, botId: bots.trinity, initiatorUserId: USER, input: "next",
  }));
  const unrelated = await worker.begin((tx) => greetNewBotTx(tx, {
    organizationId: ORG, threadId: threads.tank, botId: bots.tank, initiatorUserId: USER, input: "other",
  }));
  assert(await claimRun(worker, config) === null, "a run was claimed while two runs in review hold the capacity of 2");

  // The review settles them: abandon frees the bot, the thread and the slots.
  const abandonInbound = await post(`/workflows/${inboundRow.workflowId}/abandon`);
  const abandonDraft = await post(`/workflows/${draftRow.workflowId}/abandon`);
  assert(abandonInbound.status === 204 && abandonDraft.status === 204,
    `the abandons answered ${JSON.stringify([abandonInbound, abandonDraft])}`);
  const settled = [await runRow(pair.inbound), await runRow(draft.runId)];
  assert(settled.every((row) => row.status === "failed" && row.errorCode === "EXTERNAL_OUTCOME_ABANDONED" && row.reviewStatus === "failed"),
    `the abandoned runs were not settled: ${JSON.stringify(settled)}`);
  const claimedAfter = new Set([(await claimRun(worker, config))?.id, (await claimRun(worker, config))?.id]);
  assert(claimedAfter.has(blocked) && claimedAfter.has(unrelated),
    `after the review, the turn behind the orphan and the unrelated one should run, got ${[...claimedAfter].join(", ")}`);
  const redraft = await queuePersonaDraft(api, botRuns, ORG, bots.neo);
  assert(redraft.runId, "a new persona draft is still refused after the review");
  await owner`update runs set status = 'completed', external_state = 'settled', lease_owner = null,
      lease_expires_at = null, ended_at = now(), updated_at = now() where id in ${owner([blocked, unrelated, redraft.runId])}`;
  proof.push({ case: "effets après abandon", status: "failed", review: "fil, place de capacité et bot libérés" });

  // 4. A root DM whose initiator was nulled (an agency operator's deleted
  // account: `runs_initiator_user_fkey` sets it null). Simulated directly.
  const agency = await worker.begin((tx) => greetNewBotTx(tx, {
    organizationId: ORG, threadId: threads.direct, botId: bots.tank, initiatorUserId: USER, input: "agency",
  }));
  await owner`update runs set initiator_user_id = null where id = ${agency}`;
  const agencyRow = await loseLeaseDuringCreate(agency);
  assertReviewed(agencyRow, "dm", "the DM without initiator");
  assert(agencyRow.reviewInitiator === null, "the agency review invented an initiator");
  assert((await post(`/workflows/${agencyRow.workflowId}/abandon`)).status === 204, "the agency DM review was not abandoned");
  proof.push({ case: "DM racine sans initiateur (agence)", ...agencyRow, review: "workflow dm 0175" });

  // 5. A legacy room turn (no workflow, no step kind): a `group` review, whose
  // retry is refused like any room's.
  await worker.begin((tx) => chainLegacyRoomTurnTx(tx, {
    organizationId: ORG, threadId: threads.room, botId: bots.morpheus, groupTurnPosition: 1, input: "legacy", groupState: null,
  }));
  const legacy = (await owner<Array<{ id: string }>>`select id from runs where thread_id = ${threads.room}`)[0]!.id;
  const legacyRow = await loseLeaseDuringCreate(legacy);
  assertReviewed(legacyRow, "group", "the legacy room turn");
  const legacyRetry = await post(`/workflows/${legacyRow.workflowId}/retry`, { confirmDuplicateRisk: true });
  assert(legacyRetry.status === 409 && legacyRetry.code === "WORKFLOW_GROUP_RETRY_UNSUPPORTED",
    `the legacy room retry answered ${JSON.stringify(legacyRetry)}`);
  assert((await post(`/workflows/${legacyRow.workflowId}/abandon`)).status === 204, "the legacy room review was not abandoned");
  proof.push({ case: "tour de salon hérité", ...legacyRow, review: "workflow group 0175 ; relance refusée" });

  console.table(proof);
  console.log("S2b proof passed: no production insert writes unknown; every run without a workflow that becomes unknown"
    + " (root DM, persona draft, legacy inbound handoff, DM without initiator, legacy room turn) gets a review workflow (0175),"
    + " and abandoning it frees the thread, the runtime slot and the bot (defect D1 fixed).");
});
