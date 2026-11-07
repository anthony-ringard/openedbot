/**
 * PERM2-9 against a disposable PostgreSQL database: a gate of a
 * run nobody attends. `persistEvents` writes the real `approval_requests`
 * row under the real guard trigger (0138) and stage check (0144):
 *
 *   - a "Never wait" routine workflow, `v2`: a gate that would wait for a
 *     person is born refused at stage `unattended`, ready to forward, and
 *     nobody is notified;
 *   - the same in `legacy`: refused, the bot's mode recorded;
 *   - an interdiction keeps its own stage; a policy `once` is unchanged;
 *   - an attended routine workflow still waits for a person and notifies;
 *   - an expired gate whose stop is reconciled names the run
 *     `APPROVAL_EXPIRED` (the third outcome, an unconfirmed stop, keeps
 *     `APPROVAL_EXPIRY_STOP_OUTCOME_UNKNOWN` from `markRunUnknown`).
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { persistEvents } from "../../modules/execution/src/application/runner";
import { reconcileHermesRun } from "../../modules/execution/src/application/runner/reconcile";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_V2 = id(1), ORG_LEGACY = id(2);
const WORKER = "perm2-9-worker";
const LEASE = 3;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const WRITE_GATE = {
  hermesRequestId: "req-1", gateKind: "plugin_tool", toolKey: "write_file", descriptorVersion: 1,
  gateArgs: { tool: "write_file", deletes: "no", opaque: false, digest: "c".repeat(64), args: { path: "notes.md", size: 4 } },
};
const CRON_GATE = { ...WRITE_GATE, toolKey: "cronjob", gateArgs: { ...WRITE_GATE.gateArgs, tool: "cronjob" } };

await withDisposablePostgres("openedbot260_unattended_gates", async ({ owner, connect }) => {
  const worker = await connect("openedbot_worker");
  await owner`insert into organizations (id, slug, name, permission_pipeline)
    values (${ORG_V2}, 'acme-unattended', 'Acme', 'v2'), (${ORG_LEGACY}, 'acme-legacy', 'Acme Legacy', 'legacy')`;
  const bots = new Map<string, string>();
  let next = 100;
  for (const [org, mode] of [[ORG_V2, "manual"], [ORG_V2, "bypass"], [ORG_LEGACY, "manual"]] as const) {
    const section = id(next++), bot = id(next++);
    await owner`insert into sections (id, organization_id, name, position) values (${section}, ${org}, ${`S${next}`}, ${next})`;
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
      values (${bot}, ${org}, ${section}, ${`Scout ${next}`}, ${`scout-${next}`}, ${next}, ${mode})`;
    bots.set(`${org}:${mode}`, bot);
  }
  const config = { workerId: WORKER, apiInternalUrl: "http://127.0.0.1:9", internalSecrets: testInternalSecrets("worker", "unused")} as WorkerConfig;

  /** One thread, routine workflow and leased run, then one gate through `persistEvents`. */
  async function gate(org: string, mode: string, neverWait: boolean, gateIdentity: Record<string, unknown>) {
    const botId = bots.get(`${org}:${mode}`)!;
    const thread = id(next++), workflow = id(next++), run = id(next++), approval = crypto.randomUUID();
    await owner.begin(async (tx) => {
      await tx`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
        values (${thread}, ${org}, ${botId}, 'Routine', ${`unattended:${thread}`}, false)`;
      await tx`insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, kind, status, autonomy_enabled, never_wait)
        values (${workflow}, ${org}, ${thread}, ${run}, ${botId}, 'routine', 'running', false, ${neverWait})`;
      await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind,
          lease_owner, lease_expires_at, lease_generation, external_state)
        values (${run}, ${org}, ${thread}, ${botId}, '[Routine « Revue »] Fais le point.', 'running', ${workflow}, 0, 'root',
          ${WORKER}, now() + interval '2 minutes', ${LEASE}, 'streaming')`;
    });
    const context = {
      id: run, organizationId: org, threadId: thread, botId, sessionId: `unattended:${thread}`, leaseGeneration: LEASE,
      workflowId: workflow, workflowRootRunId: run, stepKind: "root", groupTurnPosition: null, groupId: null,
      groupState: null, originRunId: null, permissionMode: mode,
    };
    await persistEvents(worker, config, context as never, 1, [{
      sequence: 1,
      type: "approval.requested",
      occurredAt: new Date(),
      payload: { approvalRequestId: approval, command: null, description: "Write notes.md", choices: ["once", "deny"], gate: gateIdentity },
    }] as never[]);
    const row = (await owner<Array<{
      status: string; choice: string | null; state: string | null; stage: string | null; kind: string | null;
      policy: string | null; forward: string; detail: Record<string, unknown> | null;
    }>>`select status, selected_choice as choice, decision_state as state, decision_stage as stage,
              decided_by_kind as kind, resolved_by_policy as policy, forward_state as forward, decision_detail as detail
         from approval_requests where id = ${approval}`)[0];
    assert(row, "persistEvents wrote no gate");
    const flow = (await owner<Array<{ status: string; pushes: number }>>`
      select w.status, (select count(*)::int from push_outbox p where p.workflow_id = w.id) as pushes
        from workflows w where w.id = ${workflow}`)[0]!;
    return { row, flow };
  }

  // 1. v2, "Never wait": the manual bot's gate is refused at once, ready to forward, nobody notified.
  {
    const { row, flow } = await gate(ORG_V2, "manual", true, WRITE_GATE);
    assert(row.status === "denied" && row.choice === "deny" && row.state === "decided" && row.stage === "unattended"
      && row.kind === "policy" && row.policy === "manual" && row.forward === "ready", `v2 never wait: ${JSON.stringify(row)}`);
    assert(row.detail?.reason === "never_wait" && row.detail.heldStage === "human" && row.detail.heldReason === "manual_mode",
      `v2 never wait detail: ${JSON.stringify(row.detail)}`);
    assert(flow.status === "running" && flow.pushes === 0, `v2 never wait notified: ${JSON.stringify(flow)}`);
  }

  // 2. An interdiction keeps its stage; a policy once is unchanged.
  {
    const forbidden = await gate(ORG_V2, "bypass", true, CRON_GATE);
    assert(forbidden.row.choice === "deny" && forbidden.row.stage === "forbidden", `forbidden: ${JSON.stringify(forbidden.row)}`);
    const allowed = await gate(ORG_V2, "bypass", true, WRITE_GATE);
    assert(allowed.row.choice === "once" && allowed.row.stage === "full", `bypass once: ${JSON.stringify(allowed.row)}`);
  }

  // 3. The floor in bypass is refused, never answered once.
  {
    const ssh = { ...WRITE_GATE, gateArgs: { ...WRITE_GATE.gateArgs, args: { path: "/root/.ssh/authorized_keys", size: 4 } } };
    const { row } = await gate(ORG_V2, "bypass", true, ssh);
    assert(row.choice === "deny" && row.stage === "unattended" && row.detail?.heldStage === "floor", `floor: ${JSON.stringify(row)}`);
  }

  // 4. Legacy, "Never wait": refused too, with the bot's mode.
  {
    const { row, flow } = await gate(ORG_LEGACY, "manual", true, WRITE_GATE);
    assert(row.status === "denied" && row.choice === "deny" && row.policy === "manual" && row.forward === "ready"
      && row.detail?.reason === "never_wait" && row.state === null, `legacy never wait: ${JSON.stringify(row)}`);
    assert(flow.pushes === 0, "legacy never wait notified");
  }

  // 5. An attended routine still waits for a person, and notifies once.
  for (const org of [ORG_V2, ORG_LEGACY]) {
    const { row, flow } = await gate(org, "manual", false, WRITE_GATE);
    assert(row.status === "pending" && row.choice === null && row.forward === "pending", `attended: ${JSON.stringify(row)}`);
    assert(flow.status === "awaiting_approval" && flow.pushes === 1, `attended was not notified: ${JSON.stringify(flow)}`);
  }

  // 6. An expired gate whose stop Hermes confirmed names the run and its
  // workflow `APPROVAL_EXPIRED`; any other cancellation keeps the generic code.
  for (const [cause, expected] of [
    [{ errorCode: "APPROVAL_EXPIRED", message: "La demande d’autorisation a expiré sans réponse. Le run a été arrêté." }, "APPROVAL_EXPIRED"],
    [undefined, "HERMES_RUN_CANCELLED"],
  ] as const) {
    const botId = bots.get(`${ORG_V2}:manual`)!;
    const thread = id(next++), workflow = id(next++), run = id(next++), hermesRunId = `hermes-${run}`;
    await owner.begin(async (tx) => {
      await tx`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
        values (${thread}, ${ORG_V2}, ${botId}, 'Routine', ${`expiry:${thread}`}, false)`;
      await tx`insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, kind, status, autonomy_enabled)
        values (${workflow}, ${ORG_V2}, ${thread}, ${run}, ${botId}, 'routine', 'awaiting_approval', false)`;
      await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind,
          lease_owner, lease_expires_at, lease_generation, external_state, hermes_run_id, remote_stop_state)
        values (${run}, ${ORG_V2}, ${thread}, ${botId}, 'routine', 'awaiting_approval', ${workflow}, 0, 'root',
          ${WORKER}, now() + interval '2 minutes', ${LEASE}, 'polling', ${hermesRunId}, 'confirmed')`;
    });
    const context = {
      id: run, organizationId: ORG_V2, threadId: thread, botId, botName: "Scout", botSlug: "scout",
      sessionId: `expiry:${thread}`, leaseGeneration: LEASE, workflowId: workflow, workflowRootRunId: run,
      workflowStatus: "awaiting_approval", stepKind: "root", groupTurnPosition: null, groupId: null, groupState: null,
      originRunId: null, callerBotId: null, callerRunId: null, stackDepth: 0, permissionMode: "manual",
    };
    const client = { getRunStatus: async () => ({ status: "cancelled", output: null, usage: null, pendingSteer: null }) };
    await reconcileHermesRun(worker, { ...config, reconciliationTimeoutMs: 5_000 } as WorkerConfig, context as never,
      client as never, hermesRunId, new AbortController().signal, undefined, cause);
    const ended = (await owner<Array<{ status: string; code: string | null; workflowCode: string | null }>>`
      select r.status, r.error_code as code, w.error_code as "workflowCode"
        from runs r join workflows w on w.id = r.workflow_id where r.id = ${run}`)[0]!;
    assert(ended.status === "failed" && ended.code === expected && ended.workflowCode === expected,
      `expiry naming (${expected}): ${JSON.stringify(ended)}`);
  }

  // 7. The stage check refuses a stage outside the closed set.
  let refused = false;
  try {
    await owner`update approval_requests set decision_stage = 'nobody' where organization_id = ${ORG_V2}`;
  } catch {
    refused = true;
  }
  assert(refused, "an unknown decision stage was stored");

  await worker.close();
  console.log("PERM2-9 PostgreSQL proof passed: an unattended gate is refused at once, floors and interdictions kept.");
});
