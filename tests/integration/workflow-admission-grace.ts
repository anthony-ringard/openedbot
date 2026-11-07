// Preuve d'intégration (vraie base) du fix "deadline avant démarrage" :
// WORKFLOW_ADMISSION_GRACE_SECONDS sépare l'attente en file de l'exécution.
// Les 4 scénarios demandés en revue de la PR #61 :
//   1. Workflow jamais démarré, créé il y a plus de 30 min : reste admissible
//      avant 2h, même si son deadline_at (budget d'EXÉCUTION) est déjà passé.
//   2. Premier vrai démarrage : le budget d'exécution repart à neuf.
//   3. Workflow déjà démarré : aucune prolongation artificielle au second run.
//   4. Attente de plus de 2h sans jamais démarrer : expiration effective.
import { withDisposablePostgres } from "./disposable-postgres";
import { claimRun } from "../../modules/execution/src/application/queue";
import { admitClaimedRun } from "../../modules/execution/src/application/runner/admission";
import { sweepExpiredRunsTx } from "../../modules/execution/src/application/queue-sweeps";
import { withRunReceiptJournal } from "../../modules/execution/src/application/run-receipts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

const ORG = "91450000-0000-4000-8000-000000000001";
const BOT = "91450000-0000-4000-8000-000000000003";
const id = (n: number) => `91450000-0000-4000-8000-${String(n).padStart(12, "0")}`;

await withDisposablePostgres("openedbot145_admission_grace", async ({ owner, connect }) => {
  await owner`insert into organizations (id, slug, name) values (${ORG}, 'openedbot145', 'Admission grace')`;
  await owner`insert into sections (id, organization_id, name, position) values (${id(4)}, ${ORG}, 'Grace', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${BOT}, ${ORG}, ${id(4)}, 'Grace', 'grace', 0)`;
  const linkHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_last_seen_at, link_token_hash)
    values (${id(5)}, ${ORG}, 'Fixture connector', 'connector', true, 8, now(), ${linkHash})`;
  const db = await connect("openedbot_worker");
  const workerId = "grace-probe";
  const config = { workerId, billingEnforced: false, leaseSeconds: 30 } as never;

  // --- Scénario 1 : jamais démarré, le budget d'EXÉCUTION a déjà expiré,
  // mais on est encore dans la fenêtre d'admission de 2h. ---
  const thread1 = id(100);
  const run1 = id(10);
  const workflow1 = id(200);
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${thread1}, ${ORG}, ${BOT}, 'Grace 1', 'openedbot145-session-1', true)`;
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input)
    values (${run1}, ${ORG}, ${thread1}, ${BOT}, 'fixture')`;
  await owner`insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, kind, status, timeout_seconds, created_at, deadline_at)
    values (${workflow1}, ${ORG}, ${thread1}, ${run1}, ${BOT}, 'dm', 'queued', 1800,
            now() - interval '35 minutes', now() - interval '5 minutes')`;
  await owner`update runs set workflow_id = ${workflow1} where id = ${run1}`;

  const claimed1 = await claimRun(db, config);
  assert(claimed1?.id === run1, "Un workflow jamais démarré doit rester admissible au claim avant la fenêtre de 2h, même si son deadline d'exécution est déjà passé.");

  // --- Scénario 2 : premier vrai démarrage -> budget d'exécution neuf. ---
  const before = await owner<Array<{ deadline_at: Date; started_at: Date | null }>>`
    select deadline_at, started_at from workflows where id = ${workflow1}`;
  assert(before[0]!.started_at === null, "Le workflow ne doit pas encore porter started_at avant l'admission.");

  await admitClaimedRun(db as never, config, {
    id: run1, organizationId: ORG, botId: BOT, threadId: thread1,
    workflowId: workflow1, stackDepth: 0, callerBotId: null, workflowStatus: "queued",
    hostPolicyRequired: false, hostPolicyProven: true, leaseGeneration: claimed1!.leaseGeneration,
  } as never, { span: (_name: string, fn: () => unknown) => Promise.resolve(fn()) } as never);

  const after = await owner<Array<{ deadline_at: Date; started_at: Date | null; status: string }>>`
    select deadline_at, started_at, status from workflows where id = ${workflow1}`;
  assert(after[0]!.started_at !== null, "started_at doit être posé au premier vrai démarrage.");
  assert(after[0]!.status === "running", "Le workflow doit être 'running' après admission.");
  const remainingMs = after[0]!.deadline_at.getTime() - Date.now();
  assert(remainingMs > 1700 * 1000, `Le budget d'exécution doit repartir à neuf (~1800s), pas être déjà grignoté (restant: ${Math.round(remainingMs / 1000)}s).`);

  // --- Scénario 3 : workflow déjà démarré -> aucune prolongation au second run. ---
  const deadlineBeforeSecondRun = after[0]!.deadline_at;
  await owner`update runs set status = 'completed', ended_at = now() where id = ${run1}`;
  const run1b = id(11);
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input, workflow_id, step_index)
    values (${run1b}, ${ORG}, ${thread1}, ${BOT}, 'fixture-continuation', ${workflow1}, 1)`;
  await owner`update runs set status = 'starting', lease_owner = ${workerId}, lease_generation = 1 where id = ${run1b}`;
  await admitClaimedRun(db as never, config, {
    id: run1b, organizationId: ORG, botId: BOT, threadId: thread1,
    workflowId: workflow1, stackDepth: 0, callerBotId: null, workflowStatus: "running",
    hostPolicyRequired: false, hostPolicyProven: true, leaseGeneration: 1,
  } as never, { span: (_name: string, fn: () => unknown) => Promise.resolve(fn()) } as never);
  const stillRunning = await owner<Array<{ deadline_at: Date }>>`select deadline_at from workflows where id = ${workflow1}`;
  assert(stillRunning[0]!.deadline_at.getTime() === deadlineBeforeSecondRun.getTime(),
    "Un workflow déjà démarré ne doit JAMAIS voir son deadline prolongé par une admission ultérieure (anti-abus).");

  // --- Scénario 4 : jamais démarré, en file depuis plus de 2h -> expiration réelle. ---
  const thread2 = id(101);
  const run2 = id(20);
  const workflow2 = id(201);
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${thread2}, ${ORG}, ${BOT}, 'Grace 2', 'openedbot145-session-2', false)`;
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input)
    values (${run2}, ${ORG}, ${thread2}, ${BOT}, 'fixture')`;
  await owner`insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, kind, status, timeout_seconds, created_at, deadline_at)
    values (${workflow2}, ${ORG}, ${thread2}, ${run2}, ${BOT}, 'dm', 'queued', 1800,
            now() - interval '125 minutes', now() - interval '95 minutes')`;
  await owner`update runs set workflow_id = ${workflow2} where id = ${run2}`;

  await withRunReceiptJournal(db, (tx) => sweepExpiredRunsTx(tx));
  const expired = await owner<Array<{ status: string; error_code: string | null }>>`
    select status, error_code from workflows where id = ${workflow2}`;
  assert(expired[0]!.status === "expired", `Un workflow jamais démarré depuis plus de 2h doit expirer réellement (status: ${expired[0]!.status}).`);
  assert(expired[0]!.error_code === "WORKFLOW_DEADLINE_EXCEEDED", "Le code d'erreur doit rester WORKFLOW_DEADLINE_EXCEEDED.");
  const expiredRun = await owner<Array<{ status: string }>>`select status from runs where id = ${run2}`;
  assert(expiredRun[0]!.status === "failed", "Le run associé doit lui aussi être réglé en 'failed', pas laissé en 'queued'.");

  console.info(JSON.stringify({ event: "openedbot145.admission_grace.passed" }));
});
