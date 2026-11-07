/**
 * DEV-209: `routine_manage` on a real PostgreSQL, under openedbot_api and tenant RLS.
 *
 * Proves: the MCP handshake and the per-runtime bearer, the run key (signed by
 * the worker secret, live run only), the per-bot switch, each permission mode
 * (bypass writes, manual creates paused and refuses resume/remove, plan writes
 * nothing), the routine-run guard, the schedule forms and minimum interval,
 * and that a tenant's bearer never reaches another tenant's run.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import { routineToolMcpRoutes, routineToolSecretHash } from "../../apps/api/src/routes/execution/routine-tool-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import { signRoutineRunKey } from "../../modules/execution/src/application/routine-run-key";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92090000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id(1), ORG_B = id(2), USER = id(3), SECTION = id(4), RUNTIME_A = id(5), RUNTIME_B = id(6);
const BYPASS = id(10), MANUAL = id(11), PLAN = id(12), OFF = id(13), BOT_B = id(14);
const SECRET = "integration-worker-secret";
const BEARER_A = "bearer-a", BEARER_B = "bearer-b";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

await withDisposablePostgres("openedbot209_routine_tool", async ({ owner, connect }) => {
  await owner`insert into users (id, email) values (${USER}, 'dev209@example.test')`;
  await owner`insert into organizations (id, slug, name) values (${ORG_A}, 'dev209-a', 'A'), (${ORG_B}, 'dev209-b', 'B')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG_A}, ${USER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG_A}, 'S', 0)`;
  await owner`insert into sections (id, organization_id, name, position) values (${id(7)}, ${ORG_B}, 'S', 0)`;
  for (const [runtime, org] of [[RUNTIME_A, ORG_A], [RUNTIME_B, ORG_B]] as const) {
    await owner`insert into runtimes (id, organization_id, name, endpoint, token_ciphertext, token_nonce, token_tag, is_active)
      values (${runtime}, ${org}, 'fixture', 'http://127.0.0.1:8123', 'c', 'n', 't', true)`;
  }
  const runs = new Map<string, string>();
  let n = 100;
  for (const [bot, org, section, mode] of [
    [BYPASS, ORG_A, SECTION, "bypass"], [MANUAL, ORG_A, SECTION, "manual"], [PLAN, ORG_A, SECTION, "plan"],
    [OFF, ORG_A, SECTION, "bypass"], [BOT_B, ORG_B, id(7), "bypass"],
  ] as const) {
    const thread = id(n++), run = id(n++);
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
      values (${bot}, ${org}, ${section}, ${`b${n}`}, ${`b${n}`}, ${n}, ${mode})`;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${thread}, ${org}, ${bot}, 'DM', ${`dev209-${n}`}, true)`;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, external_state)
      values (${run}, ${org}, ${thread}, ${bot}, 'fixture', 'running', 'streaming')`;
    runs.set(bot, run);
  }
  await owner`insert into runtime_routine_tools (organization_id, runtime_id, secret_hash, installed_at, enabled_bot_ids)
    values (${ORG_A}, ${RUNTIME_A}, ${routineToolSecretHash(BEARER_A)}, now(), ${`{${BYPASS},${MANUAL},${PLAN}}`}::uuid[]),
           (${ORG_B}, ${RUNTIME_B}, ${routineToolSecretHash(BEARER_B)}, now(), ${`{${BOT_B}}`}::uuid[])`;

  const db = await connect("openedbot_api");
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 401)
    : context.json({ code: "INTERNAL" }, 500));
  app.route("/api/mcp/routines", routineToolMcpRoutes(db, testInternalSecrets("api", SECRET)));

  let rpc = 0;
  const post = (org: string, bearer: string | null, body: unknown) => app.request(`/api/mcp/routines/${org}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const call = async (bot: string, args: Record<string, unknown>, options: { org?: string; bearer?: string; runKey?: string } = {}) => {
    const response = await post(options.org ?? ORG_A, options.bearer ?? BEARER_A, {
      jsonrpc: "2.0", id: ++rpc, method: "tools/call",
      params: { name: "routine_manage", arguments: { run_key: options.runKey ?? signRoutineRunKey(SECRET, runs.get(bot)!), ...args } },
    });
    assert(response.status === 200, `tools/call status ${response.status}`);
    const json = await response.json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    return { error: json.result.isError, text: json.result.content[0]!.text };
  };

  // Handshake and bearer.
  assert((await post(ORG_A, null, { jsonrpc: "2.0", id: 1, method: "ping" })).status === 401, "no bearer must be 401");
  assert((await post(ORG_A, BEARER_B, { jsonrpc: "2.0", id: 1, method: "ping" })).status === 401, "another tenant's bearer must be 401");
  const init = await (await post(ORG_A, BEARER_A, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json() as { result: { protocolVersion: string } };
  assert(init.result.protocolVersion === "2025-06-18", "initialize must echo a supported version");
  assert((await post(ORG_A, BEARER_A, { jsonrpc: "2.0", method: "notifications/initialized" })).status === 202, "notification must be 202");
  const listed = await (await post(ORG_A, BEARER_A, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as { result: { tools: Array<{ name: string }> } };
  assert(listed.result.tools.map((tool) => tool.name).join() === "routine_manage", "tools/list must serve routine_manage only");

  // Bypass: write, read back, update, pause, remove.
  const created = await call(BYPASS, { action: "create", name: "News IA", prompt: "Cherche les news IA", schedule: "daily at 9am", timezone: "Europe/Paris" });
  assert(!created.error, `bypass create failed: ${created.text}`);
  const jobId = (JSON.parse(created.text) as { created: { job_id: string; enabled: boolean; schedule: string } }).created;
  assert(jobId.enabled && jobId.schedule === "0 9 * * *", "bypass create must be enabled with the normalized cron");
  const stored = await owner<Array<{ enabled: boolean; next: Date | null; by: string | null }>>`
    select enabled, next_run_at as next, created_by_user_id as by from routines where id = ${jobId.job_id}`;
  assert(stored[0]?.enabled && stored[0].next && stored[0].by === null, "the routine row must be enabled with a next run");
  // PERM2-9: a routine the bot creates never waits for a person, and the bot cannot move that.
  const neverWait = async (routine: string) =>
    (await owner<Array<{ neverWait: boolean }>>`select never_wait as "neverWait" from routines where id = ${routine}`)[0]?.neverWait;
  assert(await neverWait(jobId.job_id) === true, "a bot-created routine must be born never_wait");
  assert((JSON.parse(created.text) as { created: { never_wait: boolean } }).created.never_wait === true, "the tool view must say never_wait");
  await owner`update routines set never_wait = false where id = ${jobId.job_id}`;
  assert(!(await call(BYPASS, { action: "update", job_id: jobId.job_id, schedule: "weekdays at 8:30" })).error, "update must pass");
  assert(await neverWait(jobId.job_id) === false, "a bot update must not move never_wait the operator set");
  assert((await owner<Array<{ schedule: string }>>`select schedule from routines where id = ${jobId.job_id}`)[0]?.schedule === "30 8 * * 1-5", "update must store the cron");
  assert(!(await call(BYPASS, { action: "pause", job_id: jobId.job_id })).error, "pause must pass");
  assert((await owner<Array<{ enabled: boolean }>>`select enabled from routines where id = ${jobId.job_id}`)[0]?.enabled === false, "pause must disable");
  assert((await call(BYPASS, { action: "create", name: "Trop", prompt: "x", schedule: "every 5m" })).error, "every 5m must be refused");
  assert((await call(BYPASS, { action: "create", name: "Flou", prompt: "x", schedule: "parfois" })).error, "an unknown schedule must be refused");
  assert((await call(BYPASS, { action: "update", job_id: id(999), name: "x" })).error, "an unknown job_id must be refused");
  assert(!(await call(BYPASS, { action: "remove", job_id: jobId.job_id })).error, "bypass remove must pass");

  // Manual: created paused, the operator switches it on.
  const manual = await call(MANUAL, { action: "create", name: "M", prompt: "x", schedule: "hourly" });
  const manualJob = (JSON.parse(manual.text) as { created: { job_id: string; enabled: boolean } }).created;
  assert(!manual.error && manualJob.enabled === false, "manual create must be paused");
  assert(await neverWait(manualJob.job_id) === true, "a paused bot-created routine must be never_wait too");
  assert((await call(MANUAL, { action: "resume", job_id: manualJob.job_id })).error, "manual resume must be refused");
  assert((await call(MANUAL, { action: "remove", job_id: manualJob.job_id })).error, "manual remove must be refused");

  // Plan writes nothing; a switched-off bot, a bad key and an ended run are refused.
  assert((await call(PLAN, { action: "create", name: "P", prompt: "x", schedule: "hourly" })).error, "plan create must be refused");
  assert((await call(OFF, { action: "list" })).error, "a bot without the switch must be refused");
  assert((await call(BYPASS, { action: "list" }, { runKey: `${runs.get(BYPASS)}.forged` })).error, "a forged key must be refused");
  await owner`update runs set status = 'completed' where id = ${runs.get(PLAN)}`;
  assert((await call(PLAN, { action: "list" })).error, "an ended run must be refused");

  // A run fired by a routine reads, but never writes.
  const routine = id(500);
  await owner`insert into routines (id, organization_id, bot_id, name, schedule, timezone, message, enabled)
    values (${routine}, ${ORG_A}, ${BYPASS}, 'R', '0 9 * * *', 'UTC', 'm', true)`;
  await owner`insert into routine_executions (organization_id, routine_id, outcome, trigger, run_id)
    values (${ORG_A}, ${routine}, 'fired', 'scheduled', ${runs.get(BYPASS)})`;
  assert(!(await call(BYPASS, { action: "list" })).error, "a routine run may list");
  assert((await call(BYPASS, { action: "create", name: "R2", prompt: "x", schedule: "hourly" })).error, "a routine run must not create");

  // Tenant B's valid bearer and key never reach tenant A's run.
  const cross = await call(BOT_B, { action: "list" }, { org: ORG_B, bearer: BEARER_B, runKey: signRoutineRunKey(SECRET, runs.get(BYPASS)!) });
  assert(cross.error, "another tenant's run must not be visible");
  assert(!(await call(BOT_B, { action: "list" }, { org: ORG_B, bearer: BEARER_B })).error, "tenant B lists its own");

  // S1b: one secret per role. The run key is signed with RUN_KEY_SECRET; the former
  // secret reads only the keys of runs created before RUN_KEY_PREVIOUS_CREATED_BEFORE.
  const NEW_SECRET = "integration-run-key-secret";
  const listWith = async (env: Record<string, string>, runKey: string) => {
    const scoped = new Hono<{ Variables: AppVariables }>();
    scoped.route("/api/mcp/routines", routineToolMcpRoutes(db, testInternalSecrets("api", env)));
    const response = await scoped.request(`/api/mcp/routines/${ORG_A}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BEARER_A}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name: "routine_manage", arguments: { run_key: runKey, action: "list" } } }),
    });
    const json = await response.json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    return { error: json.result.isError, text: json.result.content[0]!.text };
  };
  const live = runs.get(BYPASS)!;
  const createdAt = (await owner<Array<{ at: Date }>>`select created_at as at from runs where id = ${live}`)[0]!.at;
  const after = new Date(createdAt.getTime() + 60_000).toISOString();
  const before = new Date(createdAt.getTime() - 60_000).toISOString();
  const oldKey = signRoutineRunKey(SECRET, live), newKey = signRoutineRunKey(NEW_SECRET, live);
  assert(!(await listWith({ RUN_KEY_SECRET: NEW_SECRET }, newKey)).error, "a key signed with RUN_KEY_SECRET must pass");
  assert(!(await listWith({ RUN_KEY_SECRET: NEW_SECRET, RUN_KEY_PREVIOUS_SECRET: SECRET, RUN_KEY_PREVIOUS_CREATED_BEFORE: after }, oldKey)).error,
    "the previous secret must read the key of a run created before its bound");
  assert((await listWith({ RUN_KEY_SECRET: NEW_SECRET, RUN_KEY_PREVIOUS_SECRET: SECRET, RUN_KEY_PREVIOUS_CREATED_BEFORE: createdAt.toISOString() }, oldKey)).error,
    "a run created at the bound is outside the cohort");
  assert((await listWith({ RUN_KEY_SECRET: NEW_SECRET, RUN_KEY_PREVIOUS_SECRET: SECRET, RUN_KEY_PREVIOUS_CREATED_BEFORE: before }, oldKey)).error,
    "a key forged with the previous secret for a run created after its bound must be refused");
  assert((await listWith({ RUN_KEY_SECRET: NEW_SECRET }, oldKey)).error, "once the previous secret is removed, it must read no key");

  await db.close();
  console.log("routine-tool: 1 handshake, 4 modes, routine guard, schedules, tenant isolation and run-key cohort proven");
});
