import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import { botSettingsToolMcpRoutes, botSettingsToolSecretHash } from "../../apps/api/src/routes/execution/bot-settings-tool-routes";
import { botSettingProposalRoutes } from "../../apps/api/src/routes/roster/bot-setting-proposal-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import { signBotSettingsRunKey } from "../../modules/execution/src/application/bot-settings-run-key";
import { listThreadProposals } from "../../modules/roster/src/application/bot-setting-proposals";
import { withTenant } from "@openedbot/platform-db";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `93190000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id(1), ORG_B = id(2), USER = id(3), SECTION_A = id(4), SECTION_B = id(5), RUNTIME = id(6);
const BYPASS = id(10), PLAN = id(11), OFF = id(12), STALE = id(13), REJECT = id(14), SUPERSEDE = id(15);
const BEARER = "bot-settings-bearer";
const WORKER_SECRET = "integration-worker-secret";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

await withDisposablePostgres("openedbot131_bot_settings", async ({ owner, connect }) => {
  await owner`insert into users (id, email) values (${USER}, 'camille@example.com')`;
  await owner`insert into organizations (id, slug, name) values (${ORG_A}, 'acme', 'Acme'), (${ORG_B}, 'other', 'Other')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG_A}, ${USER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values
    (${SECTION_A}, ${ORG_A}, 'General', 0), (${SECTION_B}, ${ORG_B}, 'General', 0)`;
  await owner`insert into runtimes (id, organization_id, name, endpoint, token_ciphertext, token_nonce, token_tag, is_active)
    values (${RUNTIME}, ${ORG_A}, 'fixture', 'http://127.0.0.1:8123', 'c', 'n', 't', true)`;

  const runs = new Map<string, { runId: string; threadId: string }>();
  let sequence = 100;
  for (const [botId, mode, sectionId] of [
    [BYPASS, "bypass", SECTION_A], [PLAN, "plan", SECTION_A], [OFF, "bypass", SECTION_A],
    [STALE, "bypass", SECTION_A], [REJECT, "bypass", SECTION_A], [SUPERSEDE, "bypass", SECTION_A],
  ] as const) {
    const threadId = id(sequence++);
    const runId = id(sequence++);
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, instructions, permission_mode)
      values (${botId}, ${ORG_A}, ${sectionId}, 'Assistant', ${`assistant-${sequence}`}, ${sequence}, 'Original persona', ${mode})`;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${threadId}, ${ORG_A}, ${botId}, 'Conversation', ${`bot-settings-${sequence}`}, true)`;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, external_state)
      values (${runId}, ${ORG_A}, ${threadId}, ${botId}, 'fixture', 'running', 'streaming')`;
    runs.set(botId, { runId, threadId });
  }
  await owner`insert into runtime_bot_settings_tools (organization_id, runtime_id, secret_hash, installed_at, enabled_bot_ids)
    values (${ORG_A}, ${RUNTIME}, ${botSettingsToolSecretHash(BEARER)}, now(), ${`{${BYPASS},${PLAN},${STALE},${REJECT},${SUPERSEDE}}`}::uuid[])`;

  const db = await connect("openedbot_api");
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 401)
    : context.json({ code: "INTERNAL" }, 500));
  app.route("/api/mcp/bot-settings", botSettingsToolMcpRoutes(db, testInternalSecrets("api", WORKER_SECRET)));
  let rpcId = 0;
  const post = (organizationId: string, bearer: string | null, body: unknown) => app.request(`/api/mcp/bot-settings/${organizationId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const call = async (botId: string, args: Record<string, unknown>) => {
    const run = runs.get(botId)!;
    const response = await post(ORG_A, BEARER, {
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: {
        name: "bot_settings_propose",
        arguments: { run_key: signBotSettingsRunKey(WORKER_SECRET, run.runId), ...args },
      },
    });
    assert(response.status === 200, `tools/call status ${response.status}`);
    const json = await response.json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    return { error: json.result.isError, text: json.result.content[0]!.text };
  };

  assert((await post(ORG_A, "bad-bearer", { jsonrpc: "2.0", id: 1, method: "ping" })).status === 401, "bad bearer must be 401");
  const init = await (await post(ORG_A, BEARER, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json() as {
    result: { protocolVersion: string; serverInfo: { name: string } };
  };
  assert(init.result.protocolVersion === "2025-06-18" && init.result.serverInfo.name === "openedbot_bot_settings", "MCP initialize must identify the server");
  const listed = await (await post(ORG_A, BEARER, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json() as { result: { tools: Array<{ name: string }> } };
  assert(listed.result.tools.map((tool) => tool.name).join() === "bot_settings_propose", "tools/list must serve one tool");
  assert((await call(OFF, { reason: "test", label: "Off" })).error, "a bot without the switch must be refused");
  assert((await call(PLAN, { reason: "test", label: "Plan" })).text === "plan mode: proposing setting changes is disabled", "plan mode must be refused");

  const original = (await owner<Array<{ instructions: string; label: string | null }>>`
    select instructions, label from bots where organization_id = ${ORG_A} and id = ${BYPASS}`
  )[0]!;
  const pending = await call(BYPASS, { reason: "Improve clarity", instructions: "A full new persona", label: "Calm helper" });
  assert(!pending.error && pending.text.includes("Nothing has changed yet."), "bypass must create a pending proposal");
  const bypassProposalId = /Proposal ([0-9a-f-]{36})/.exec(pending.text)?.[1];
  assert(bypassProposalId, "proposal response must include its id");
  const unchanged = (await owner<Array<{ instructions: string; label: string | null }>>`
    select instructions, label from bots where organization_id = ${ORG_A} and id = ${BYPASS}`
  )[0]!;
  assert(unchanged.instructions === original.instructions && unchanged.label === original.label, "bypass must not mutate the bot row");
  const bypassThread = runs.get(BYPASS)!.threadId;
  const bypassProposals = await withTenant(db, ORG_A, (tx) => listThreadProposals(tx, ORG_A, bypassThread));
  const applyProposal = bypassProposals.find((proposal) => proposal.id === bypassProposalId)!;
  assert(applyProposal.status === "pending" && applyProposal.current.instructions === "Original persona", "proposal must preserve current fields and remain pending");

  const decisionApp = new Hono<{ Variables: AppVariables }>();
  decisionApp.use("*", async (context, next) => {
    context.set("auth", {
      sessionId: id(90), organizationId: ORG_A, userId: USER, role: "owner", kind: "web", credentialHash: "fixture",
    });
    await next();
  });
  decisionApp.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 401)
    : context.json({ code: "INTERNAL" }, 500));
  decisionApp.route("/api/bots", botSettingProposalRoutes(db));

  const applyResponse = await decisionApp.request(`/api/bots/${BYPASS}/setting-proposals/${bypassProposalId}/decision`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "apply", expectedHash: applyProposal.hash }),
  });
  assert(applyResponse.status === 200, `apply status ${applyResponse.status}`);
  const applied = await applyResponse.json() as { status: string };
  assert(applied.status === "applied", "operator apply must resolve the proposal");
  const written = (await owner<Array<{ instructions: string; label: string | null }>>`
    select instructions, label from bots where organization_id = ${ORG_A} and id = ${BYPASS}`
  )[0]!;
  assert(written.instructions === "A full new persona" && written.label === "Calm helper", "apply must write and re-read instructions and label");

  const staleCall = await call(STALE, { reason: "Revise persona", instructions: "Stale proposal" });
  const staleId = /Proposal ([0-9a-f-]{36})/.exec(staleCall.text)?.[1];
  assert(staleId, "stale proposal must be created");
  const staleThread = runs.get(STALE)!.threadId;
  const staleProposal = (await withTenant(db, ORG_A, (tx) => listThreadProposals(tx, ORG_A, staleThread)))[0]!;
  await owner`update bots set updated_at = updated_at + interval '1 second' where organization_id = ${ORG_A} and id = ${STALE}`;
  const staleResponse = await decisionApp.request(`/api/bots/${STALE}/setting-proposals/${staleId}/decision`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "apply", expectedHash: staleProposal.hash }),
  });
  assert(staleResponse.status === 409, "stale base version must return 409");
  const staleCode = await staleResponse.json() as { code: string };
  assert(staleCode.code === "BOT_SETTING_PROPOSAL_STALE", "stale response must use its error code");
  const staleStatus = (await owner<Array<{ status: string }>>`select status from bot_setting_proposals where id = ${staleId}`)[0]?.status;
  assert(staleStatus === "stale", "stale decision must commit its status");

  const rejectCall = await call(REJECT, { reason: "Turn off finish notice", notify_on_finish: false });
  const rejectId = /Proposal ([0-9a-f-]{36})/.exec(rejectCall.text)?.[1];
  assert(rejectId, "reject proposal must be created");
  const rejectProposal = (await withTenant(db, ORG_A, (tx) => listThreadProposals(tx, ORG_A, runs.get(REJECT)!.threadId)))[0]!;
  const rejectResponse = await decisionApp.request(`/api/bots/${REJECT}/setting-proposals/${rejectId}/decision`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "reject", expectedHash: rejectProposal.hash }),
  });
  assert(rejectResponse.status === 200, "reject must succeed");
  const rejected = await rejectResponse.json() as { status: string };
  assert(rejected.status === "rejected", "reject must resolve the proposal");

  const first = await call(SUPERSEDE, { reason: "First proposal", label: "First" });
  const firstId = /Proposal ([0-9a-f-]{36})/.exec(first.text)?.[1];
  const second = await call(SUPERSEDE, { reason: "Second proposal", label: "Second" });
  const secondId = /Proposal ([0-9a-f-]{36})/.exec(second.text)?.[1];
  assert(firstId && secondId, "both proposals must be created");
  const statuses = await owner<Array<{ id: string; status: string }>>`
    select id, status from bot_setting_proposals where organization_id = ${ORG_A} and bot_id = ${SUPERSEDE}
  `;
  assert(statuses.find((proposal) => proposal.id === firstId)?.status === "superseded", "a second proposal must supersede the first");
  assert(statuses.find((proposal) => proposal.id === secondId)?.status === "pending", "the newest proposal must remain pending");

  const crossTenant = await withTenant(db, ORG_B, (tx) => tx<Array<{ id: string }>>`
    select id from bot_setting_proposals where organization_id = ${ORG_A} and id = ${bypassProposalId}
  `);
  assert(crossTenant.length === 0, "RLS must hide another tenant's proposal");
  // S1b: the run-key cohort on the real route. The PLAN bot answers its plan-mode
  // refusal only once the key is accepted; a refused key says "run_key is not valid".
  const NEW_SECRET = "integration-bot-settings-run-key";
  const proposeWith = async (env: Record<string, string>, runKey: string) => {
    const scoped = new Hono<{ Variables: AppVariables }>();
    scoped.route("/api/mcp/bot-settings", botSettingsToolMcpRoutes(db, testInternalSecrets("api", env)));
    const response = await scoped.request(`/api/mcp/bot-settings/${ORG_A}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BEARER}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "bot_settings_propose", arguments: { run_key: runKey, reason: "cohort", label: "Cohort" } } }),
    });
    return (await response.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  };
  const ACCEPTED = "plan mode: proposing setting changes is disabled";
  const planRun = runs.get(PLAN)!.runId;
  const planCreated = (await owner<Array<{ at: Date }>>`select created_at as at from runs where id = ${planRun}`)[0]!.at;
  const bound = (offsetMs: number) => new Date(planCreated.getTime() + offsetMs).toISOString();
  const formerKey = signBotSettingsRunKey(WORKER_SECRET, planRun);
  const previous = (offsetMs: number) => ({ RUN_KEY_SECRET: NEW_SECRET, RUN_KEY_PREVIOUS_SECRET: WORKER_SECRET, RUN_KEY_PREVIOUS_CREATED_BEFORE: bound(offsetMs) });
  assert(await proposeWith({ RUN_KEY_SECRET: NEW_SECRET }, signBotSettingsRunKey(NEW_SECRET, planRun)) === ACCEPTED, "a key signed with RUN_KEY_SECRET must pass");
  assert(await proposeWith(previous(60_000), formerKey) === ACCEPTED, "the previous secret must read the key of a run created before its bound");
  assert((await proposeWith(previous(0), formerKey)).startsWith("run_key is not valid"), "a run created at the bound is outside the cohort");
  assert((await proposeWith(previous(-60_000), formerKey)).startsWith("run_key is not valid"), "a former key for a run created after the bound must be refused");
  assert((await proposeWith({ RUN_KEY_SECRET: NEW_SECRET }, formerKey)).startsWith("run_key is not valid"), "after P4 the former secret must read no key");

  await db.close();
  console.log("bot-settings-tool: MCP, proposal lifecycle, operator decisions, stale checks, tenant RLS and run-key cohort proven");
});
