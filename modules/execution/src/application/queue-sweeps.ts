import type { SQL } from "bun";
import { APPROVAL_LEASE_EXPIRED_CODE } from "@openedbot/contracts-errors";
import { recoverRunSteersBeforeClaim } from "./run-steering";
import { captureRunEventTx } from "./run-receipts";
import { ACTIVE_RUN_STATUSES } from "../domain/run-transitions";
import { appendRunEventsTx } from "../sql/run-events";
import { NOW, RELEASE_LEASE, sqlExpr, transitionRuns, type TransitionedRun } from "../sql/run-transitions";

/** Plafond de tentatives partagé (reaper de baux + retry Hermes). Au-delà: échec terminal. */
export const MAX_RUN_ATTEMPTS = 5;

/**
 * Un workflow jamais démarré (aucun run encore passé par Hermes) ne doit pas
 * mourir simplement parce que `deadline_at` — fixé à la création, pour borner
 * le temps d'EXÉCUTION — est dépassé alors qu'il n'a fait qu'attendre une
 * capacité ou un runtime libre. Cette fenêtre borne l'attente en file à part,
 * généreuse mais finie : au-delà, le workflow est bien abandonné (pas de
 * zombie indéfini). Une fois réellement démarré, `deadline_at` est redonné à
 * neuf dans `admission.ts` et c'est lui seul qui borne l'exécution.
 */
export const WORKFLOW_ADMISSION_GRACE_SECONDS = 7200;

type RunRow = { organizationId: string; id: string };

/** Rows grouped by organization, in id order: one transition per organization. */
function byOrganization<T extends RunRow>(rows: readonly T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const row of [...rows].sort((a, b) => a.organizationId.localeCompare(b.organizationId) || a.id.localeCompare(b.id))) {
    groups.set(row.organizationId, [...(groups.get(row.organizationId) ?? []), row]);
  }
  return [...groups];
}

/** The workflows of moved runs, settled after them (run then workflow lock order). */
function workflowsOf(rows: readonly TransitionedRun[]): Array<{ organizationId: string; id: string }> {
  const seen = new Map<string, { organizationId: string; id: string }>();
  for (const row of rows) if (row.workflowId) seen.set(`${row.organizationId}:${row.workflowId}`, { organizationId: row.organizationId, id: row.workflowId });
  return [...seen.values()];
}

/**
 * Commit the approval reaper before acquiring unrelated claim candidates: a
 * transaction must never keep a gate lock and then go looking for another run.
 */
export async function reapExpiredApprovalSends(db: SQL): Promise<void> {
  await db.begin(async (tx) => {
    const sql = tx as unknown as SQL;
    // A process can die after Hermes received an approval but before the DB
    // confirmation. Replaying that decision could duplicate a consequential
    // action, so an expired `sending` lease is always a review state.
    const gates = await sql<RunRow[]>`
      with expired_gate_parents as (
        select distinct organization_id, run_id
          from approval_requests
         where forward_state = 'sending' and forwarding_lease_expires_at <= now()
      ), locked_runs as (
        select run.organization_id, run.id, run.workflow_id
          from runs run
          join expired_gate_parents parent
            on parent.organization_id = run.organization_id and parent.run_id = run.id
         order by run.organization_id, run.id
         for update of run
      ), locked_workflows as (
        select workflow.organization_id, workflow.id
          from workflows workflow
          join locked_runs run
            on run.organization_id = workflow.organization_id and run.workflow_id = workflow.id
         order by workflow.organization_id, workflow.id
         for update of workflow
      ), locked_gates as (
        select approval.id, approval.organization_id, approval.run_id
          from approval_requests approval
          join locked_runs run
            on run.organization_id = approval.organization_id and run.id = approval.run_id
          left join locked_workflows workflow
            on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
         where approval.forward_state = 'sending' and approval.forwarding_lease_expires_at <= now()
           and (run.workflow_id is null or workflow.id is not null)
         order by approval.organization_id, approval.run_id, approval.gate_ordinal
         for update of approval
      ), ambiguous_gates as (
        update approval_requests approval set forward_state = 'ambiguous', forwarding_owner = null,
          forwarding_lease_expires_at = null
         from locked_gates locked
         where approval.id = locked.id and approval.organization_id = locked.organization_id
         returning approval.organization_id, approval.run_id
      )
      select distinct organization_id as "organizationId", run_id as id from ambiguous_gates
    `;
    const ambiguous: TransitionedRun[] = [];
    for (const [organizationId, runs] of byOrganization(gates)) {
      // Unleased: the gate's forwarding lease expired, whoever holds the run.
      ambiguous.push(...await transitionRuns(sql, {
        target: { organizationId, ids: runs.map((run) => run.id) }, fence: "unleased",
        transition: { from: ACTIVE_RUN_STATUSES, to: { status: "unknown", externalState: "ambiguous" } },
        set: {
          eventsComplete: false, errorCode: "APPROVAL_FORWARD_OUTCOME_UNKNOWN",
          errorMessage: "La transmission de la décision Hermes est incertaine.", ...RELEASE_LEASE,
        },
      }));
    }
    for (const workflow of workflowsOf(ambiguous)) {
      await sql`
        update workflows set status = 'unknown', error_code = 'APPROVAL_FORWARD_OUTCOME_UNKNOWN',
          error_message = 'La transmission de la décision Hermes est incertaine.', updated_at = now()
         where organization_id = ${workflow.organizationId} and id = ${workflow.id}
           and status not in ('completed','failed','cancelled','expired')
      `;
    }
    // The update holds every run's row: the primitive numbers each run.error
    // after the cursor lock, in its own statement (D2).
    await appendRunEventsTx(sql, ambiguous.map((run) => ({
      organizationId: run.organizationId,
      threadId: run.threadId,
      runId: run.id,
      type: "run.error",
      payload: {
        message: "Transmission d’autorisation incertaine : vérification requise.",
        errorCode: "APPROVAL_FORWARD_OUTCOME_UNKNOWN",
        recoveryState: "needs_review",
      },
    })));
  });
}

/**
 * One expiry pass over the queue, in the single transaction `claimRun` opens
 * before it claims: steering recovery, lease recovery of `starting`/`running`
 * and `awaiting_approval` runs, workflow deadlines before and after Hermes,
 * and the lease lost during a Hermes create. Idempotent, shared by the dedicated
 * sweep job and the head of `claimRun`. Each move takes over a lapsed lease
 * (`lease_expired`) or a queued run that holds none.
 */
export async function sweepExpiredRunsTx(tx: SQL): Promise<void> {
  // Recover steering before holding an unrelated expired target. A late ACK
  // locks source/target in id order; requeueing the target first would invert
  // that order when recovery later waits for the ACK's source lock.
  await recoverRunSteersBeforeClaim(tx);
  // Inclure awaiting_approval: un worker mort pendant une approbation laissait
  // sinon le run orphelin à vie (bail expiré, jamais réclamé, fil bloqué). À la
  // reprise, executeRun reconnecte le stream Hermes et le heartbeat transmet la
  // réponse déjà saisie. Un worker vivant renouvelle son bail, donc n'est pas volé.
  // `error_code` garde la cause la plus explicative pour l'opérateur : un run
  // dont l'arrêt était DÉJÀ demandé a été arrêté par lui, et le bail n'a fait
  // que retarder la clôture. Écraser avec 'WORKER_LEASE_EXPIRED' affichait un
  // code de panne interne sous le « Run annulé. » qu'il venait de demander.
  await transitionRuns(tx, {
    target: { sweep: true }, fence: "lease_expired",
    transition: { from: ["starting", "running"], to: { status: "queued", externalState: { withHermesRun: "polling", withoutHermesRun: "not_started" } } },
    set: {
      ...RELEASE_LEASE, nextAttemptAt: null,
      errorCode: sqlExpr`case when remote_stop_state = 'requested'
        then coalesce(error_code, 'CANCELLED_BY_USER') else 'WORKER_LEASE_EXPIRED' end`,
      eventsComplete: sqlExpr`case when hermes_run_id is null then events_complete else false end`,
    },
    where: sqlExpr`attempts < ${MAX_RUN_ATTEMPTS} and (external_state = 'not_started' or hermes_run_id is not null)`,
  });
  await expireOverdueRunsBeforeStartTx(tx);
  await requestOverdueExternalStopsTx(tx);
  // Sending POST /v1/runs without receiving/storing a run id is the unsafe
  // boundary: the old request may have executed, so never create again.
  const ambiguous = await transitionRuns(tx, {
    target: { sweep: true }, fence: "lease_expired",
    transition: {
      from: ACTIVE_RUN_STATUSES, fromExternalState: ["creating", "streaming", "stopping"],
      to: { status: "unknown", externalState: "ambiguous" },
    },
    set: {
      eventsComplete: false, errorCode: "HERMES_CREATE_OUTCOME_UNKNOWN",
      errorMessage: "Le worker a perdu son bail pendant la création Hermes; aucune relance automatique.", ...RELEASE_LEASE,
    },
    where: sqlExpr`hermes_run_id is null`,
  });
  for (const workflow of workflowsOf(ambiguous)) {
    await tx`
      update workflows set status = 'unknown', error_code = 'HERMES_CREATE_OUTCOME_UNKNOWN',
        error_message = 'L’effet de la création Hermes est incertain.', updated_at = now()
       where organization_id = ${workflow.organizationId} and id = ${workflow.id}
    `;
  }
  await transitionRuns(tx, {
    target: { sweep: true }, fence: "lease_expired",
    transition: { from: ["awaiting_approval"], to: { status: "queued", externalState: "polling" } },
    set: {
      ...RELEASE_LEASE, nextAttemptAt: null, errorCode: APPROVAL_LEASE_EXPIRED_CODE,
      errorMessage: "Le worker a expiré pendant l’approbation; reprise de la demande.", eventsComplete: false,
    },
    where: sqlExpr`hermes_run_id is not null and attempts < ${MAX_RUN_ATTEMPTS}`,
  });
}

const WORKFLOW_DEADLINE_MESSAGE = "La durée maximale du workflow est atteinte avant son démarrage.";
const WORKFLOW_DEADLINE_STOP_MESSAGE = "La durée maximale du workflow est atteinte; arrêt Hermes requis.";

/**
 * A workflow can spend its entire lifetime waiting for capacity or a runtime.
 * Once its deadline passes, that pre-Hermes run can never be claimed, so
 * settle the run and its workflow together while keeping run -> workflow
 * lock order. Runs that may have crossed Hermes are deliberately excluded.
 * A plain DM run has no workflow and carries its own `deadline_at`.
 */
async function expireOverdueRunsBeforeStartTx(tx: SQL): Promise<void> {
  const overdue = await tx<RunRow[]>`
    with overdue_runs as (
      select run.organization_id, run.id, run.workflow_id, run.created_at
        from runs run
        left join workflows workflow
          on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
       where run.status = 'queued' and run.external_state = 'not_started'
         and run.hermes_run_id is null and run.remote_stop_state is null
         and (
           (
             workflow.status in ('queued','running','awaiting_approval')
             and workflow.started_at is null
             and coalesce(workflow.created_at, run.created_at) <= now() - (${WORKFLOW_ADMISSION_GRACE_SECONDS} * interval '1 second')
           )
           or (run.workflow_id is null and run.deadline_at <= now())
         )
       order by run.organization_id, run.id
       for update of run skip locked
       limit 50
    ), overdue_workflows as (
      select workflow.organization_id, workflow.id
        from workflows workflow
        join overdue_runs run
          on run.organization_id = workflow.organization_id and run.workflow_id = workflow.id
       where workflow.status in ('queued','running','awaiting_approval')
         and workflow.started_at is null
         and coalesce(workflow.created_at, run.created_at) <= now() - (${WORKFLOW_ADMISSION_GRACE_SECONDS} * interval '1 second')
       order by workflow.organization_id, workflow.id
       for update of workflow
    )
    select overdue.organization_id as "organizationId", overdue.id
      from overdue_runs overdue
      left join overdue_workflows workflow
        on workflow.organization_id = overdue.organization_id and workflow.id = overdue.workflow_id
     where overdue.workflow_id is null or workflow.id is not null
  `;
  const expired: TransitionedRun[] = [];
  for (const [organizationId, runs] of byOrganization(overdue)) {
    expired.push(...await transitionRuns(tx, {
      target: { organizationId, ids: runs.map((run) => run.id) }, fence: "unleased",
      transition: { from: ["queued"], fromExternalState: ["not_started"], to: { status: "failed", externalState: "settled" } },
      set: {
        eventsComplete: true, completionKind: "workflow_deadline_before_start", errorCode: "WORKFLOW_DEADLINE_EXCEEDED",
        errorMessage: WORKFLOW_DEADLINE_MESSAGE, endedAt: NOW, ...RELEASE_LEASE, nextAttemptAt: null,
      },
    }));
  }
  for (const workflow of workflowsOf(expired)) {
    await tx`
      update workflows set status = 'expired',
        error_code = 'WORKFLOW_DEADLINE_EXCEEDED', error_message = ${WORKFLOW_DEADLINE_MESSAGE},
        ended_at = now(), updated_at = now()
       where organization_id = ${workflow.organizationId} and id = ${workflow.id}
         and status in ('queued','running','awaiting_approval')
    `;
  }
  for (const run of expired) {
    captureRunEventTx(tx, {
      organizationId: run.organizationId, threadId: run.threadId, runId: run.id, type: "run.error",
      payload: { message: WORKFLOW_DEADLINE_MESSAGE, errorCode: "WORKFLOW_DEADLINE_EXCEEDED" },
    });
  }
}

/**
 * A requeued run with a durable Hermes id also must not stay behind the
 * deadline guard forever. If no stop boundary was ever persisted, schedule
 * the first stop. Otherwise force `polling + requested`, whose runner path is
 * GET-only, so a crash can never replay an ambiguous POST /stop.
 */
async function requestOverdueExternalStopsTx(tx: SQL): Promise<void> {
  const overdue = await tx<Array<RunRow & { stopped: boolean }>>`
    with overdue_external_runs as (
      select run.organization_id, run.id, run.workflow_id, run.remote_stop_state
        from runs run
        left join workflows workflow
          on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
       where run.status = 'queued' and run.hermes_run_id is not null
         and run.external_state <> 'settled' and run.remote_stop_state is distinct from 'requested'
         and (
           (workflow.status in ('queued','running','awaiting_approval') and workflow.deadline_at <= now())
           or (run.workflow_id is null and run.deadline_at <= now())
         )
       order by run.organization_id, run.id
       for update of run skip locked
       limit 50
    ), overdue_external_workflows as (
      select workflow.organization_id, workflow.id
        from workflows workflow
        join overdue_external_runs run
          on run.organization_id = workflow.organization_id and run.workflow_id = workflow.id
       where workflow.status in ('queued','running','awaiting_approval')
         and workflow.deadline_at <= now()
       order by workflow.organization_id, workflow.id
       for update of workflow
    )
    select overdue.organization_id as "organizationId", overdue.id,
           overdue.remote_stop_state is not null as stopped
      from overdue_external_runs overdue
      left join overdue_external_workflows workflow
        on workflow.organization_id = overdue.organization_id and workflow.id = overdue.workflow_id
     where overdue.workflow_id is null or workflow.id is not null
  `;
  const requested: TransitionedRun[] = [];
  for (const [organizationId, runs] of byOrganization(overdue)) {
    for (const stopped of [false, true]) {
      const ids = runs.filter((run) => run.stopped === stopped).map((run) => run.id);
      requested.push(...await transitionRuns(tx, {
        target: { organizationId, ids }, fence: "unleased",
        transition: { from: ["queued"], to: { externalState: stopped ? "polling" : "stopping", remoteStopState: "requested" } },
        set: {
          eventsComplete: false, errorCode: "WORKFLOW_DEADLINE_EXCEEDED", errorMessage: WORKFLOW_DEADLINE_STOP_MESSAGE,
          nextAttemptAt: NOW,
        },
        where: sqlExpr`hermes_run_id is not null`,
      }));
    }
  }
  for (const workflow of workflowsOf(requested)) {
    await tx`
      update workflows set error_code = 'WORKFLOW_DEADLINE_EXCEEDED', error_message = ${WORKFLOW_DEADLINE_STOP_MESSAGE},
        recovery_state = ${{ cancelRequested: true, reason: "deadline" }}, updated_at = now()
       where organization_id = ${workflow.organizationId} and id = ${workflow.id}
         and status in ('queued','running','awaiting_approval')
    `;
  }
  for (const run of requested) {
    captureRunEventTx(tx, {
      organizationId: run.organizationId, threadId: run.threadId, runId: run.id, type: "system.notice",
      payload: {
        message: "Délai du workflow atteint : arrêt et vérification Hermes en cours.",
        kind: "workflow.deadline_stop_requested",
        errorCode: "WORKFLOW_DEADLINE_EXCEEDED",
        workflowId: run.workflowId,
      },
    });
  }
}
