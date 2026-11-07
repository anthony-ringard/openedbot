import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { admitClaimedRun } from "../src/application/runner/admission";

test("admitClaimedRun resets the workflow deadline to a fresh budget only on its first real start", async () => {
  const statements: string[] = [];
  const db = ((parts: TemplateStringsArray) => {
    statements.push([...parts].join(" "));
    return Promise.resolve([]);
  }) as unknown as SQL;
  const context = {
    id: "run-1", organizationId: "org-1", botId: "bot-1", threadId: "thread-1",
    workflowId: "wf-1", stackDepth: 0, callerBotId: null, workflowStatus: "queued",
    hostPolicyRequired: false, hostPolicyProven: true,
  } as never;
  const config = { workerId: "worker-1" } as never;
  const trace = { span: (_name: string, fn: () => unknown) => Promise.resolve(fn()) } as never;
  await admitClaimedRun(db, config, context, trace);
  const workflowUpdate = statements.find((sql) => sql.includes("preflight.workflow_running") || sql.includes("set status = 'running', started_at")) ?? statements.find((sql) => sql.includes("started_at = coalesce(started_at, now())")) ?? "";
  expect(workflowUpdate).toContain("case when workflow.started_at is null");
  expect(workflowUpdate).toContain("now() + (workflow.timeout_seconds * interval '1 second')");
  // A workflow already started (retried via run-steering) must keep its own deadline, not get a free reset.
  expect(workflowUpdate).toContain("else workflow.deadline_at");
});
