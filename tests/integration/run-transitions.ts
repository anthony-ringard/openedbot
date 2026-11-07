/**
 * S2d (ADR 0001, sections 4.5 and 5; inventory docs/architecture/0002,
 * sections 7 and 8): the transition function of `runs`, against a disposable
 * PostgreSQL, each actor on its own connection.
 *
 *  1. Fencing, two workers. Worker A holds a run; once its lease has expired
 *     every write of A is refused, before the sweep (lease lapsed) and after
 *     worker B took the run over (new generation): heartbeat, events and their
 *     transition, polling, `unknown`, a direct transition. B then finishes it.
 *  2. Illegal transitions on real rows: `completed` never moves again,
 *     `cancelled` → `queued` only for a steered follow-up, `unknown` →
 *     `running` and `ambiguous` → `streaming` never, a stop request is never
 *     forgotten; the database row is left as it was.
 *  3. D6: the API closing a courier (cancelled hand-off) while the worker
 *     delivers it, from a read taken before the delivery committed: the
 *     courier is closed once, with one reply and one `run.completed`.
 *  4. D4: a stopping worker requeues a run with a known Hermes id in
 *     `polling` (`events_complete = false`), as the lease sweep does, so the
 *     next claim reconciles by status instead of reattaching to the stream.
 *  5. D9: an abandoned `unknown` run is `failed` and `settled`, no longer
 *     shown as to review.
 *
 * On `develop` before S2d, parts 1 (writes after expiry, before the sweep),
 * 3, 4 and 5 fail; part 2 is new (the function did not exist).
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import type { SQL } from "bun";
import { claimRun } from "../../modules/execution/src/application/queue";
import { markRunUnknown } from "../../modules/execution/src/application/runner/failure";
import { deliverHandoffReplyTx } from "../../modules/execution/src/application/runner/handoff";
import {
  confirmFallbackCreate,
  confirmFirstCreate,
  heldLease,
  markCreateIntent,
  requestRemoteStop,
  resumeAnnouncedReplay,
  runKey,
  settleResumedRunStatus,
  switchToPolling,
} from "../../modules/execution/src/application/runner/lease-transitions";
import { persistEvents } from "../../modules/execution/src/application/runner/persist";
import type { RunContext } from "../../modules/execution/src/application/runner/types";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { ACTIVE_RUN_STATUSES } from "../../modules/execution/src/domain/run-transitions";
import { renewRunLease } from "../../modules/execution/src/sql/run-columns";
import { transitionRuns } from "../../modules/execution/src/sql/run-transitions";
import { settleCancelledHandoffsTx } from "../../apps/api/src/routes/conversation/conversation-followup";
import { workflowRoutes } from "../../apps/api/src/routes/execution/workflow-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { createWorkerRegistry } from "../../apps/worker/src/infrastructure/worker-registry";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `94000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const USER = id(2);
const RUNTIME = id(3);
const SECTION = id(4);
const BOT = id(5);
const TARGET_BOT = id(6);
const NAMES = ["fence", "completed", "cancelled", "steered", "unknown", "stop", "courier", "child", "d4a", "d4b", "d4c", "d9"] as const;
type Name = (typeof NAMES)[number];
const T = Object.fromEntries(NAMES.map((name, index) => [name, id(200 + index)])) as Record<Name, string>;
const R = Object.fromEntries(NAMES.map((name, index) => [name, id(300 + index)])) as Record<Name, string>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Row = {
  status: string; externalState: string; remoteStopState: string | null; leaseOwner: string | null;
  leaseGeneration: number; eventsComplete: boolean; hermesRunId: string | null; completionKind: string | null;
};

await withDisposablePostgres("openedbot4_s2d_transitions", async ({ owner, connect }) => {
  await owner`insert into users (id, email) values (${USER}, 's2d-transitions@example.test')`;
  await owner`insert into organizations (id, slug, name) values (${ORG}, 's2d-transitions', 's2d-transitions')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'S2d', 0)`;
  const linkHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_last_seen_at, link_token_hash)
    values (${RUNTIME}, ${ORG}, 'Connector', 'connector', true, 8, now(), ${linkHash})`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${BOT}, ${ORG}, ${SECTION}, 'Neo', 'neo', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${TARGET_BOT}, ${ORG}, ${SECTION}, 'Trinity', 'trinity', 1)`;
  for (const [name, threadId] of Object.entries(T)) {
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${threadId}, ${ORG}, ${name === "child" ? TARGET_BOT : BOT}, ${name}, ${`s2d-${name}`}, ${name === "fence"})`;
  }
  const insertRun = (name: Name, status: string, extra: Partial<{
    externalState: string; remoteStopState: string; hermesRunId: string; completionKind: string; botId: string | null;
    leaseOwner: string; originRunId: string; handoffTargetBotId: string; initiator: string;
  }> = {}) => owner`
    insert into runs (id, organization_id, thread_id, bot_id, input, status, step_kind, external_state, remote_stop_state,
                      hermes_run_id, completion_kind, lease_owner, lease_expires_at, lease_generation, origin_run_id,
                      handoff_target_bot_id, initiator_user_id, ended_at)
    values (${R[name]}, ${ORG}, ${T[name]}, ${extra.botId === undefined ? BOT : extra.botId}, 'S2d', ${status},
            ${extra.originRunId || extra.handoffTargetBotId ? null : "root"},
            ${extra.externalState ?? "not_started"}, ${extra.remoteStopState ?? null}, ${extra.hermesRunId ?? null},
            ${extra.completionKind ?? null}, ${extra.leaseOwner ?? null},
            ${extra.leaseOwner ? new Date(Date.now() + 600_000) : null}, ${extra.leaseOwner ? 1 : 0},
            ${extra.originRunId ?? null}, ${extra.handoffTargetBotId ?? null}, ${extra.initiator ?? null},
            ${["completed", "failed", "cancelled"].includes(status) ? new Date() : null})`;
  const read = async (name: Name): Promise<Row> => {
    const [row] = await owner<Row[]>`
      select status, external_state as "externalState", remote_stop_state as "remoteStopState",
             lease_owner as "leaseOwner", lease_generation::int as "leaseGeneration", events_complete as "eventsComplete",
             hermes_run_id as "hermesRunId", completion_kind as "completionKind"
        from runs where id = ${R[name]}`;
    assert(row, `run ${name} must exist`);
    return row;
  };
  const journal = async (name: Name) => (await owner<Array<{ sequence: number; type: string }>>`
    select sequence, type from run_events where run_id = ${R[name]} order by sequence`).map((row) => `${row.sequence}:${row.type}`).join(",");
  const config = (workerId: string) => ({
    workerId, apiInternalUrl: "http://127.0.0.1:9", internalSecrets: testInternalSecrets("worker", "s2d"), hermesMtls: null, leaseSeconds: 30,
    runInactivityMs: 20_000, runTimeoutMs: 30_000, reconciliationTimeoutMs: 10_000, billingEnforced: false,
    cachedInputTokenWeight: 0.1, webAppUrl: "http://127.0.0.1:1420",
  }) as unknown as WorkerConfig;
  const context = (name: Name, leaseGeneration: number, externalState: RunContext["externalState"]) => ({
    id: R[name], organizationId: ORG, threadId: T[name], botId: BOT, botName: "Neo", botSlug: "neo", botDescription: null,
    sessionId: `s2d-${name}`, leaseGeneration, workflowId: null, workflowRootRunId: null, workflowStatus: null,
    groupId: null, groupTurnPosition: null, groupState: null, stepKind: "root", originRunId: null,
    provider: null, runtimeId: RUNTIME, input: "S2d", attempts: 1, hermesRunId: null, lastHermesSequence: 0,
    externalState, remoteStopState: null, permissionMode: null, planOnly: false,
    operator: { name: "Kévin", handle: "kevin" },
  }) as unknown as RunContext;
  const proof: Array<Record<string, unknown>> = [];

  // 1. Fencing, two workers on their own connections.
  const workerA = await connect("openedbot_worker");
  const workerB = await connect("openedbot_worker");
  const configA = config("s2d-worker-a");
  const configB = config("s2d-worker-b");
  await insertRun("fence", "queued");
  const claimedA = await claimRun(workerA, configA);
  assert(claimedA?.id === R.fence && claimedA?.leaseGeneration === 1, `worker A claims the run (got ${JSON.stringify(claimedA)})`);
  const holderA = context("fence", 1, "not_started");
  assert(await markCreateIntent(workerA, configA, holderA, "model-a"), "A marks its create while it holds the lease");
  assert(await confirmFirstCreate(workerA, configA, holderA, "hermes-fence", "S2d"), "A confirms its create while it holds the lease");
  await persistEvents(workerA, configA, { ...holderA, externalState: "streaming" }, 1, [
    { sequence: 0, type: "agent.message", occurredAt: new Date(), payload: { text: "bonjour" } },
  ]);
  assert(await journal("fence") === "0:agent.message", "A's events land while it holds the lease");

  const refusedWrites = async (holder: RunContext, stage: string) => {
    const before = await read("fence");
    assert(await renewRunLease(workerA, runKey(holder), heldLease(configA, holder), 30) === null, `${stage}: A's heartbeat renewed a lost lease`);
    await persistEvents(workerA, configA, { ...holder, externalState: "streaming" }, 2, [
      { sequence: 1, type: "run.completed", occurredAt: new Date(), payload: { output: "trop tard" } },
    ]);
    await switchToPolling(workerA, configA, holder);
    assert(!await markRunUnknown(workerA, configA, holder, "S2D_LATE", "trop tard"), `${stage}: A marked the run unknown`);
    assert(!await requestRemoteStop(workerA, configA, holder), `${stage}: A requested a stop`);
    assert(!await confirmFallbackCreate(workerA, configA, holder, "hermes-late", null), `${stage}: A confirmed a fallback`);
    const direct = await transitionRuns(workerA, {
      target: runKey(holder), fence: heldLease(configA, holder), transition: { from: ACTIVE_RUN_STATUSES, to: { status: "failed", externalState: "settled" } },
    });
    assert(direct.length === 0, `${stage}: a direct transition under A's lease moved the run`);
    const after = await read("fence");
    assert(JSON.stringify(after) === JSON.stringify(before), `${stage}: A's late writes changed the run: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    assert(await journal("fence") === "0:agent.message", `${stage}: A's late events reached the journal: ${await journal("fence")}`);
  };
  // 1a. Expired, before any sweep: nobody took the run yet, A may not write any more.
  await owner`update runs set lease_expires_at = now() - interval '1 second' where id = ${R.fence}`;
  await refusedWrites(holderA, "lease expired");
  // 1b. Taken over: B's claim sweeps the lapsed lease (known Hermes id: polling) and claims generation 2.
  const claimedB = await claimRun(workerB, configB);
  assert(claimedB?.id === R.fence && claimedB?.leaseGeneration === 2, `worker B takes the run over (got ${JSON.stringify(claimedB)})`);
  const takenOver = await read("fence");
  assert(takenOver.leaseOwner === "s2d-worker-b" && takenOver.externalState === "polling" && takenOver.status === "starting",
    `the takeover requeued in polling then claimed: ${JSON.stringify(takenOver)}`);
  await refusedWrites(holderA, "lease taken over");
  // B finishes the run under its own lease.
  const holderB = context("fence", 2, "polling");
  await settleResumedRunStatus(workerB, configB, holderB);
  assert((await read("fence")).status === "running", "B resumes the run");
  assert(await resumeAnnouncedReplay(workerB, configB, holderB, "hermes-fence"), "B resumes the announced replay");
  await persistEvents(workerB, configB, { ...holderB, externalState: "streaming" }, 2, [
    { sequence: 1, type: "run.completed", occurredAt: new Date(), payload: { output: "fini" } },
  ]);
  const finished = await read("fence");
  assert(finished.status === "completed" && finished.externalState === "settled" && finished.leaseOwner === null,
    `B completes the run: ${JSON.stringify(finished)}`);
  assert(await journal("fence") === "0:agent.message,1:run.completed", `one completion only, B's: ${await journal("fence")}`);
  proof.push({ case: "fencing", expiredRefused: true, takenOverRefused: true, finishedBy: "s2d-worker-b" });

  // 2. Illegal transitions on real rows (the API's own connection, no lease).
  const api = await connect();
  const unchanged = async (name: Name, move: () => Promise<unknown>, expect: "refused" | "not_applied") => {
    const before = await read(name);
    const outcome = await move().then((rows) => rows, (error: unknown) => error);
    if (expect === "refused") {
      assert(outcome instanceof Error && outcome.message.startsWith("run transition refused before writing"), `${name}: expected a refusal, got ${String(outcome)}`);
    } else {
      assert(Array.isArray(outcome) && outcome.length === 0, `${name}: the transition applied: ${JSON.stringify(outcome)}`);
    }
    assert(JSON.stringify(await read(name)) === JSON.stringify(before), `${name}: the row changed`);
  };
  await insertRun("completed", "completed", { externalState: "settled", hermesRunId: "hermes-done" });
  await unchanged("completed", () => transitionRuns(api, {
    target: { organizationId: ORG, id: R.completed }, fence: "unleased", transition: { from: ["completed"], to: { status: "running" } },
  }), "refused");
  // The same move as a late command would write it: its origins exclude a completed run.
  await unchanged("completed", () => transitionRuns(api, {
    target: { organizationId: ORG, id: R.completed }, fence: "unleased", transition: { from: ACTIVE_RUN_STATUSES, to: { status: "running", externalState: "streaming" } },
  }), "not_applied");
  // An operator's cancellation is not a steered follow-up: it never comes back to the queue.
  await insertRun("cancelled", "cancelled", { externalState: "settled" });
  const replay = (name: Name) => () => transitionRuns(api, {
    target: { organizationId: ORG, id: R[name] }, fence: "unleased",
    transition: { from: ["cancelled"], fromExternalState: ["settled"], to: { status: "queued", externalState: "not_started" } },
    set: { completionKind: null },
  });
  await unchanged("cancelled", replay("cancelled"), "not_applied");
  await unchanged("cancelled", () => transitionRuns(api, {
    target: { organizationId: ORG, id: R.cancelled }, fence: "unleased", transition: { from: ["cancelled"], to: { status: "cancelled" } },
  }), "refused");
  await insertRun("steered", "cancelled", { externalState: "settled", completionKind: "steered_into_active" });
  assert((await replay("steered")()).length === 1 && (await read("steered")).status === "queued", "a steered follow-up is replayed");
  await insertRun("unknown", "unknown", { externalState: "ambiguous", hermesRunId: "hermes-unknown" });
  await unchanged("unknown", () => transitionRuns(api, {
    target: { organizationId: ORG, id: R.unknown }, fence: "unleased", transition: { from: ["unknown"], to: { status: "running" } },
  }), "refused");
  await unchanged("unknown", () => transitionRuns(api, {
    target: { organizationId: ORG, id: R.unknown }, fence: "unleased", transition: { from: ["unknown"], to: { externalState: "streaming" } },
  }), "not_applied");
  await insertRun("stop", "queued", { externalState: "polling", remoteStopState: "requested", hermesRunId: "hermes-stop" });
  await unchanged("stop", () => transitionRuns(api, {
    target: { organizationId: ORG, id: R.stop }, fence: "unleased", transition: { from: ["queued"], to: { remoteStopState: null } },
  }), "not_applied");
  proof.push({ case: "illegal", completedToRunning: "refused", cancelledToQueued: "not_applied unless steered", unknownToRunning: "refused", ambiguousToStreaming: "not_applied", stopForgotten: "not_applied" });

  // 3. D6: the worker delivers the courier while the API, from an earlier read, closes it as cancelled.
  await insertRun("courier", "relaying", { botId: null, handoffTargetBotId: TARGET_BOT });
  await insertRun("child", "cancelled", { botId: TARGET_BOT, originRunId: R.courier, externalState: "settled" });
  const workerD6 = await connect();
  const apiD6 = await connect();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let delivered!: () => void;
  const delivering = new Promise<void>((resolve) => { delivered = resolve; });
  const worker = workerD6.begin(async (tx) => {
    await deliverHandoffReplyTx(tx as unknown as SQL, {
      organizationId: ORG, id: R.child, originRunId: R.courier, botId: TARGET_BOT, botName: "Trinity", botSlug: "trinity",
    }, { status: "completed", output: "réponse", error: null });
    delivered();
    await held;
  });
  await delivering;
  const apiDone = apiD6.begin((tx) => settleCancelledHandoffsTx(tx as unknown as Bun.TransactionSQL, ORG, [{
    id: R.child, originRunId: R.courier, botId: TARGET_BOT, previousStatus: "running", status: "cancelled", workflowId: null,
  }]));
  // The API read the courier as relaying (the delivery is not committed) and now waits on its row.
  for (let attempt = 0; ; attempt += 1) {
    const [waiting] = await owner<Array<{ count: number }>>`
      select count(*)::int as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
    if ((waiting?.count ?? 0) > 0) break;
    assert(attempt < 200, "the API never waited on the courier's row");
    await Bun.sleep(10);
  }
  release();
  await worker;
  await apiDone;
  const replies = await owner<Array<{ count: number }>>`select count(*)::int as count from messages where run_id = ${R.courier}`;
  assert((await read("courier")).status === "completed", "the courier is closed");
  assert(replies[0]?.count === 1, `D6: the courier received ${replies[0]?.count} replies`);
  assert(await journal("courier") === "0:bot.message,1:run.completed", `D6: the courier's journal is ${await journal("courier")}`);
  proof.push({ case: "D6", replies: 1, journal: await journal("courier") });

  // 4. D4: a stopping worker hands its runs back; with a known Hermes id, in polling.
  await insertRun("d4a", "running", { externalState: "streaming", hermesRunId: "hermes-d4", leaseOwner: "s2d-worker-d4" });
  await insertRun("d4b", "starting", { externalState: "not_started", leaseOwner: "s2d-worker-d4" });
  await insertRun("d4c", "running", { externalState: "creating", leaseOwner: "s2d-worker-d4" });
  await createWorkerRegistry(await connect("openedbot_worker"), "s2d-worker-d4").releaseLeasesAndClose();
  const [d4a, d4b, d4c] = [await read("d4a"), await read("d4b"), await read("d4c")];
  assert(d4a.status === "queued" && d4a.leaseOwner === null, `D4: the run with a Hermes id is requeued: ${JSON.stringify(d4a)}`);
  assert(d4a.externalState === "polling" && d4a.eventsComplete === false,
    `D4: the requeued run must reconcile by status (polling, events incomplete), got ${d4a.externalState} / ${d4a.eventsComplete}`);
  assert(d4b.status === "queued" && d4b.externalState === "not_started", `D4: a run never sent is requeued as is: ${JSON.stringify(d4b)}`);
  assert(d4c.status === "unknown" && d4c.externalState === "ambiguous", `D4: a create without id is uncertain: ${JSON.stringify(d4c)}`);
  proof.push({ case: "D4", requeued: d4a.externalState, neverSent: d4b.externalState, creating: d4c.status });

  // 5. D9: an abandoned review settles the run's external outcome.
  await insertRun("d9", "running", { externalState: "streaming", hermesRunId: "hermes-d9", initiator: USER });
  await owner`update runs set status = 'unknown', external_state = 'ambiguous' where id = ${R.d9}`;
  const [review] = await owner<Array<{ workflowId: string }>>`select workflow_id as "workflowId" from runs where id = ${R.d9}`;
  assert(review?.workflowId, "the unknown run received its review workflow (0175)");
  const auth: AuthContext = { sessionId: "s2d", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "s2d" };
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, ctx) => error instanceof HttpError ? ctx.json({ code: error.code }, error.status as 409) : ctx.json({ code: String(error) }, 500));
  app.use("*", async (ctx, next) => { ctx.set("auth", auth); await next(); });
  app.route("/workflows", workflowRoutes(await connect("openedbot_api")));
  const abandoned = await app.request(`/workflows/${review.workflowId}/abandon`, { method: "POST" });
  assert(abandoned.status === 204, `the abandon answered ${abandoned.status}`);
  const [d9] = await owner<Array<{ status: string; externalState: string; recoveryState: string | null }>>`
    select status, external_state as "externalState",
           case when status = 'unknown' or external_state = 'ambiguous' then 'needs_review' else null end as "recoveryState"
      from runs where id = ${R.d9}`;
  assert(d9?.status === "failed" && d9.externalState === "settled" && d9.recoveryState === null,
    `D9: the abandoned run is still to review: ${JSON.stringify(d9)}`);
  proof.push({ case: "D9", status: d9.status, externalState: d9.externalState, recoveryState: d9.recoveryState });

  console.info(JSON.stringify({ test: "run-transitions", passed: true, proof }));
});
