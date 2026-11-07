/**
 * Proved against a disposable PostgreSQL database, the real send route, the
 * real queue and the real runner (loopback fake Hermes). A plain DM turn must
 * leave `runs.workflow_id` null, insert no workflow and never read the Hermes
 * session counters; rooms, explicit handoffs and autonomy keep their
 * workflow; a thread stays FIFO across workflow and workflow-less turns; an
 * overdue plain turn expires before it is ever claimed, and an uncertain one
 * gets the review workflow every recovery path is keyed by. Its events carry
 * the run itself as their turn (0092 identity), under the run lease, before and
 * after that review workflow opens.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import { encryptSecret, secretEncryptionKey } from "../../platform/hermes/src/index.ts";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import { claimRun } from "../../modules/execution/src/application/queue";
import { executeRun } from "../../modules/execution/src/application/runner";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { startFakeHermes } from "../fake-hermes/server";
import { FAKE_HERMES_TOKEN } from "../fake-hermes/defaults";
import { withDisposablePostgres } from "./disposable-postgres";

const ORG = "91130000-0000-4000-8000-000000000001";
const FIFO_ORG = "91130000-0000-4000-8000-000000000002";
const USER = "91130000-0000-4000-8000-000000000003";
const id = (n: number) => `91130000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bots = { neo: id(101), auto: id(102), trinity: id(103), fifo: id(104) };
const threads = { neo: id(201), auto: id(202), trinity: id(203), group: id(204), fifo: id(205) };
const groupId = id(301);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const hermes = startFakeHermes({ port: 0, delayMs: 5, capacity: 4 });
const hermesRequests: string[] = [];
const recorder = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    hermesRequests.push(`${request.method} ${url.pathname}`);
    return fetch(`${hermes.url.origin}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    });
  },
});


try {
  await withDisposablePostgres("openedbot113_dm", async ({ owner: target, connect }) => {
    const api = await connect("openedbot_api");
    const worker = await connect("openedbot_worker");
    const key = secretEncryptionKey(new Uint8Array(32).fill(13));
    const endpoint = recorder.url.toString().replace(/\/$/, "");
    const bearer = encryptSecret(FAKE_HERMES_TOKEN, key.value);
    await target`insert into users (id, email) values (${USER}, 'openedbot113@example.test')`;
    for (const [org, slug] of [[ORG, "openedbot113"], [FIFO_ORG, "openedbot113-fifo"]] as const) {
      await target`insert into organizations (id, slug, name) values (${org}, ${slug}, ${slug})`;
      await target`insert into memberships (organization_id, user_id, role) values (${org}, ${USER}, 'owner')`;
      await target`insert into sections (id, organization_id, name, position)
        values (${org === ORG ? id(401) : id(402)}, ${org}, 'DM without workflow', 0)`;
      await target`insert into runtimes (
          id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
          is_active, capacity, last_health_status, last_probed_at
        ) values (
          ${org === ORG ? id(501) : id(502)}, ${org}, 'Fake Hermes', 'direct', ${endpoint},
          ${bearer.ciphertext}, ${bearer.nonce}, ${bearer.tag}, ${key.id}, true, 4, 'healthy', now() + interval '1 hour'
        )`;
    }
    const bot = (botId: string, org: string, slug: string, autonomy: boolean, position: number) => target!`
      insert into bots (id, organization_id, section_id, name, slug, position, autonomy_enabled, autonomy_timeout_seconds)
      values (${botId}, ${org}, ${org === ORG ? id(401) : id(402)}, ${slug}, ${slug}, ${position}, ${autonomy}, 900)`;
    await bot(bots.neo, ORG, "neo", false, 0);
    await bot(bots.auto, ORG, "auto", true, 1);
    await bot(bots.trinity, ORG, "trinity", false, 2);
    await bot(bots.fifo, FIFO_ORG, "fifo", false, 0);
    for (const [threadId, botId, org] of [
      [threads.neo, bots.neo, ORG], [threads.auto, bots.auto, ORG], [threads.trinity, bots.trinity, ORG],
      [threads.fifo, bots.fifo, FIFO_ORG],
    ] as const) {
      await target`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
        values (${threadId}, ${org}, ${botId}, 'DM', ${`openedbot113-${threadId}`}, true)`;
    }
    await target`insert into bot_groups (id, organization_id, section_id, name, position)
      values (${groupId}, ${ORG}, ${id(401)}, 'Salon', 0)`;
    await target`insert into group_members (organization_id, group_id, bot_id, position)
      values (${ORG}, ${groupId}, ${bots.neo}, 0), (${ORG}, ${groupId}, ${bots.trinity}, 1)`;
    await target`insert into threads (id, organization_id, group_id, title, hermes_session_id)
      values (${threads.group}, ${ORG}, ${groupId}, 'Salon', 'openedbot113-group')`;

    const workerConfig: WorkerConfig = {
      workerId: "openedbot113-worker",
      apiInternalUrl: "http://127.0.0.1:9",
      internalSecrets: testInternalSecrets("worker", "openedbot113"),
      tokenEncryption: { current: key, previous: [] },
      hermesMtls: null,
      hermesEndpointPolicy: { environment: "test", testHttpUrl: endpoint } as WorkerConfig["hermesEndpointPolicy"],
      leaseSeconds: 30,
      runInactivityMs: 20_000,
      runTimeoutMs: 30_000,
      reconciliationTimeoutMs: 10_000,
      billingEnforced: false,
      cachedInputTokenWeight: 0.1,
      webAppUrl: "http://127.0.0.1:1420",
    };
    const settle = (runId: string) => target!`
      update runs set status = 'completed', external_state = 'settled', lease_owner = null, lease_expires_at = null,
        ended_at = now(), updated_at = now()
       where id = ${runId}`;

    // 1. FIFO per thread across workflow and workflow-less turns, before any
    // other queued run exists. W1's two steps stay contiguous; the plain turn
    // created between them waits for the whole workflow.
    const fifo = { s0: id(601), r1: id(602), r1b: id(603), s1: id(604), s2: id(605), overdue: id(606), w1: id(701) };
    await target`insert into runs (id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind,
        initiator_user_id, deadline_at, created_at)
      values
        (${fifo.s0}, ${FIFO_ORG}, ${threads.fifo}, ${bots.fifo}, 's0', 'queued', null, 0, 'root', ${USER}, now() + interval '1 hour', now() - interval '50 seconds'),
        (${fifo.s1}, ${FIFO_ORG}, ${threads.fifo}, ${bots.fifo}, 's1', 'queued', null, 0, 'root', ${USER}, now() + interval '1 hour', now() - interval '30 seconds'),
        (${fifo.s2}, ${FIFO_ORG}, ${threads.fifo}, ${bots.fifo}, 's2', 'queued', null, 0, 'root', ${USER}, now() + interval '1 hour', now() - interval '10 seconds'),
        (${fifo.overdue}, ${FIFO_ORG}, ${threads.fifo}, ${bots.fifo}, 'late', 'queued', null, 0, 'root', ${USER}, now() - interval '1 second', now() - interval '5 seconds')`;
    await target.begin(async (tx) => {
      await tx`insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, initiator_user_id, kind,
          status, deadline_at, created_at, used_steps)
        values (${fifo.w1}, ${FIFO_ORG}, ${threads.fifo}, ${fifo.r1}, ${bots.fifo}, ${USER}, 'dm', 'queued',
          now() + interval '1 hour', now() - interval '40 seconds', 2)`;
      await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind, created_at)
        values
          (${fifo.r1}, ${FIFO_ORG}, ${threads.fifo}, ${bots.fifo}, 'r1', 'queued', ${fifo.w1}, 0, 'root', now() - interval '40 seconds'),
          (${fifo.r1b}, ${FIFO_ORG}, ${threads.fifo}, ${bots.fifo}, 'r1b', 'queued', ${fifo.w1}, 1, 'continuation', now() - interval '20 seconds')`;
    });
    const order: string[] = [];
    for (;;) {
      const claimed = await claimRun(worker, workerConfig);
      if (!claimed) break;
      order.push(claimed.id);
      await settle(claimed.id);
    }
    const fifoNames = Object.fromEntries(Object.entries(fifo).map(([name, value]) => [value, name]));
    assert(JSON.stringify(order.map((runId) => fifoNames[runId])) === JSON.stringify(["s0", "r1", "r1b", "s1", "s2"]),
      `thread FIFO broken: ${order.map((runId) => fifoNames[runId]).join(" -> ")}`);
    const overdue = (await target<Array<{ status: string; errorCode: string; events: number }>>`
      select status, error_code as "errorCode",
             (select count(*)::int from run_events e where e.run_id = runs.id and e.type = 'run.error') as events
        from runs where id = ${fifo.overdue}`)[0];
    assert(overdue?.status === "failed" && overdue.errorCode === "WORKFLOW_DEADLINE_EXCEEDED" && overdue.events === 1,
      `overdue plain DM was not expired before claim: ${JSON.stringify(overdue)}`);

    // An uncertain plain turn blocks its thread: it gets the review workflow
    // that every recovery path (reconcile, abandon, retry, inbox) is keyed by.
    const uncertain = id(607);
    await target`insert into runs (id, organization_id, thread_id, bot_id, input, status, step_index, step_kind,
        initiator_user_id, deadline_at, external_state)
      values (${uncertain}, ${FIFO_ORG}, ${threads.fifo}, ${bots.fifo}, 'u', 'starting', 0, 'root', ${USER},
        now() + interval '15 minutes', 'creating')`;
    const uncertainBefore = Number((await target`select count(*)::int as n from workflows where organization_id = ${FIFO_ORG}`)[0].n);
    // Written under the run lease (0092 fence): before and after the review
    // workflow opens, the turn stays the run itself and the lease still matches.
    const leasedEvent = async (sequence: number) => (await worker!<Array<{ turnId: string; leaseGeneration: string }>>`
      insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at, lease_generation)
      values (${FIFO_ORG}, ${threads.fifo}, ${uncertain}, ${sequence}, 'agent.message', ${{ delta: "u" }}, now(),
              (select lease_generation from runs where id = ${uncertain}))
      returning turn_id as "turnId", lease_generation as "leaseGeneration"`)[0];
    const beforeReview = await leasedEvent(0);
    assert(beforeReview?.turnId === uncertain, `plain DM event turn is not its run: ${JSON.stringify(beforeReview)}`);
    const marked = await worker`
      update runs set status = 'unknown', external_state = 'ambiguous', error_code = 'HERMES_CREATE_OUTCOME_UNKNOWN',
        error_message = 'incertain', updated_at = now()
       where id = ${uncertain} returning workflow_id as "workflowId"`;
    const review = (await target<Array<Record<string, unknown>>>`
      select w.id, w.kind, w.status, w.root_run_id = ${uncertain} as "rooted", w.initiator_user_id = ${USER} as "initiator",
             w.error_code as "errorCode", w.timeout_seconds as "timeoutSeconds", w.autonomy_enabled as "autonomy"
        from workflows w where w.id = ${marked[0]?.workflowId ?? null}`)[0];
    assert(review && review.kind === "dm" && review.status === "unknown" && review.rooted && review.initiator
      && review.errorCode === "HERMES_CREATE_OUTCOME_UNKNOWN" && review.timeoutSeconds === 900 && review.autonomy === false,
      `uncertain plain DM did not open its review workflow: ${JSON.stringify(review)}`);
    const uncertainAfter = Number((await target`select count(*)::int as n from workflows where organization_id = ${FIFO_ORG}`)[0].n);
    assert(uncertainAfter === uncertainBefore + 1, "review workflow count");
    const afterReview = await leasedEvent(1);
    assert(afterReview?.turnId === uncertain && afterReview.leaseGeneration === beforeReview.leaseGeneration,
      `review workflow moved the turn or the lease: ${JSON.stringify({ beforeReview, afterReview })}`);
    await target`update runs set status = 'failed', updated_at = now() where id = ${uncertain}`;

    // 2. The real send route, as openedbot_api under RLS.
    const auth: AuthContext = {
      sessionId: "openedbot113-session", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "openedbot113",
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
    app.route("/", conversationRoutes(api, {} as BlobStore, { billingEnforced: false } as ApiConfig));
    const send = async (threadId: string, input: string, idempotencyKey?: string) => {
      const response = await app.request(`/${threadId}/messages`, {
        method: "POST", headers: { "content-type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) }, body: JSON.stringify({ input }),
      });
      const body = await response.json() as { runId: string; workflowId: string | null; foldedIntoRunId?: string; workflow?: unknown };
      assert(response.status === 202, `POST ${input} returned ${response.status}: ${JSON.stringify(body)}`);
      return body;
    };
    const workflowCount = async () => Number((await target!`select count(*)::int as n from workflows where organization_id = ${ORG}`)[0].n);
    const proof: Array<Record<string, unknown>> = [];
    const runRow = async (label: string, runId: string) => {
      const row = (await target!<Array<Record<string, unknown>>>`
        select r.workflow_id as "workflowId", r.step_kind as "stepKind", r.status, r.completion_kind as "completionKind",
               r.initiator_user_id = ${USER} as "initiator",
               extract(epoch from (r.deadline_at - r.created_at))::int as "deadlineSeconds",
               w.kind as "workflowKind"
          from runs r left join workflows w on w.id = r.workflow_id where r.id = ${runId}`)[0]!;
      proof.push({ label, ...row, workflowId: row.workflowId ? "<uuid>" : null });
      return row;
    };

    const before = await workflowCount();
    const plainKey = crypto.randomUUID();
    const plain = await send(threads.neo, "bonjour", plainKey);
    assert(plain.workflowId === null && plain.workflow === undefined, "plain DM 202 still carries a workflow");
    const plainRow = await runRow("dm simple", plain.runId);
    assert(plainRow.workflowId === null && plainRow.stepKind === "root" && plainRow.initiator === true
      && plainRow.deadlineSeconds === 900, `plain DM run row: ${JSON.stringify(plainRow)}`);
    assert(await workflowCount() === before, "plain DM inserted a workflow");

    const replayed = await send(threads.neo, "bonjour", plainKey);
    const ordered = (body: Record<string, unknown>) => JSON.stringify(body, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value);
    assert(ordered(replayed) === ordered(plain), "Idempotent plain DM changed its accepted response");
    const plainCounts = (await target<Array<{ runs: number; messages: number; receipts: number }>>`
      select (select count(*)::int from runs where thread_id = ${threads.neo}) as runs,
             (select count(*)::int from messages where thread_id = ${threads.neo} and role = 'user') as messages,
             (select count(*)::int from message_ingress where organization_id = ${ORG} and run_id = ${plain.runId}) as receipts`)[0];
    assert(plainCounts?.runs === 1 && plainCounts.messages === 1 && plainCounts.receipts === 1,
      "Idempotent replay duplicated the plain DM message, run or ingress receipt");
    assert(await workflowCount() === before, "Idempotent replay inserted a workflow");

    const folded = await send(threads.neo, "et ensuite ?");
    assert(folded.foldedIntoRunId === plain.runId && folded.workflowId === null, `follow-up did not fold: ${JSON.stringify(folded)}`);
    const neoRuns = Number((await target`select count(*)::int as n from runs where thread_id = ${threads.neo}`)[0].n);
    assert(neoRuns === 1 && await workflowCount() === before, "fold created a run or a workflow");

    const autonomous = await send(threads.auto, "bonjour");
    const autoRow = await runRow("dm autonomie", autonomous.runId);
    assert(autonomous.workflowId && autoRow.workflowKind === "dm" && autoRow.deadlineSeconds === null,
      `autonomy DM lost its workflow: ${JSON.stringify(autoRow)}`);
    const handoff = await send(threads.trinity, "@neo vérifie le disque.");
    const handoffRow = await runRow("dm handoff", handoff.runId);
    assert(handoff.workflowId && handoffRow.stepKind === "delegated" && handoffRow.workflowKind === "dm",
      `explicit handoff lost its workflow: ${JSON.stringify(handoffRow)}`);
    const room = await send(threads.group, "on fait le point ?");
    const roomRow = await runRow("salon", room.runId);
    assert(room.workflowId && roomRow.workflowKind === "group", `room lost its workflow: ${JSON.stringify(roomRow)}`);
    assert(await workflowCount() === before + 3, "room, handoff and autonomy must each open exactly one workflow");

    // 3. The real runner. The plain turn runs to completion without any
    // `GET /api/sessions/:id` (Hermes session counters); the autonomy turn,
    // which has a token budget, reads them.
    const plainClaim = await claimRun(worker, workerConfig);
    assert(plainClaim?.id === plain.runId, `expected the plain DM to be claimed first, got ${plainClaim?.id}`);
    hermesRequests.length = 0;
    await executeRun(worker, workerConfig, plainClaim);
    const plainCounters = hermesRequests.filter((line) => /^GET \/api\/sessions\/[^/]+$/.test(line));
    assert(hermesRequests.includes("POST /v1/runs"), `plain DM never reached Hermes: ${hermesRequests.join(", ")}`);
    assert(plainCounters.length === 0, `plain DM read Hermes session counters: ${plainCounters.join(", ")}`);
    const plainDone = await runRow("dm simple (exécuté)", plain.runId);
    const author = (await target`select author_bot_id as "authorBotId" from messages
      where run_id = ${plain.runId} and role = 'assistant'`)[0] as { authorBotId: string } | undefined;
    assert(plainDone.status === "completed" && plainDone.completionKind === "final" && plainDone.workflowId === null,
      `plain DM did not settle as a final answer: ${JSON.stringify(plainDone)}`);
    assert(author?.authorBotId === bots.neo, "plain DM answer lost its author bot");
    assert(await workflowCount() === before + 3, "executing a plain DM created a workflow");
    const plainEvents = await target<Array<Record<string, unknown>>>`
      select e.type, e.lease_generation::int as "generation",
             e.turn_id = e.run_id as "ownTurn", e.bot_id = ${bots.neo} as "bot",
             e.session_key is not null as "session", e.lease_generation = r.lease_generation as "lease"
        from run_events e join runs r on r.id = e.run_id where e.run_id = ${plain.runId}`;
    assert(plainEvents.length > 0 && plainEvents.every((row) => row.ownTurn && row.bot && row.session
      && (row.type === "message.admitted" ? row.generation === 0 : row.lease)),
      `plain DM events lack their envelope identity: ${JSON.stringify(plainEvents)}`);

    const autoClaim = await claimRun(worker, workerConfig);
    assert(autoClaim?.id === autonomous.runId, `expected the autonomy DM next, got ${autoClaim?.id}`);
    hermesRequests.length = 0;
    await executeRun(worker, workerConfig, autoClaim);
    const autoCounters = hermesRequests.filter((line) => /^GET \/api\/sessions\/[^/]+$/.test(line));
    assert(autoCounters.length >= 1, `autonomy DM did not read session counters: ${hermesRequests.join(", ")}`);
    const autoWorkflow = (await target`select w.status from workflows w join runs r on r.workflow_id = w.id
      where r.id = ${autonomous.runId}`)[0] as { status: string };
    assert(autoWorkflow.status === "completed", `autonomy workflow did not complete: ${autoWorkflow.status}`);
    await runRow("dm autonomie (exécuté)", autonomous.runId);

    console.table(proof);
    console.log(`workflows: ${before} before, ${await workflowCount()} after (salon + handoff + autonomie; DM simple et repli: 0)`);
    console.log("DM without workflow PostgreSQL proof passed: plain DM without workflow nor session counters, fold, FIFO per thread, deadline expiry, review workflow on uncertainty, turn = run under the lease fence; room, handoff and autonomy keep their workflow.");
  });
} finally {
  recorder.stop(true);
  hermes.stop(true);
}
