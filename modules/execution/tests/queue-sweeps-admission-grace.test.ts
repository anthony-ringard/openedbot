import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { sweepExpiredRunsTx } from "../src/application/queue-sweeps";

test("the before-start sweep no longer expires a never-started workflow on exec deadline alone", async () => {
  const statements: string[] = [];
  const tx = ((parts: TemplateStringsArray) => {
    statements.push([...parts].join(" "));
    return Promise.resolve([]);
  }) as unknown as SQL;
  await sweepExpiredRunsTx(tx);
  const overdue = statements.find((sql) => sql.includes("with overdue_runs")) ?? "";
  expect(overdue).toContain("workflow.started_at is null");
  expect(overdue).toContain("now() - (");
  expect(overdue).toContain("* interval '1 second')");
  // A plain DM run (no workflow) keeps its own simple deadline check untouched.
  expect(overdue).toContain("run.workflow_id is null and run.deadline_at <= now()");
  // The already-started/external-stop path is a different budget (execution,
  // not queueing) and must keep checking the real deadline directly.
  const externalStop = statements.find((sql) => sql.includes("with overdue_external_runs")) ?? "";
  expect(externalStop).toContain("workflow.deadline_at <= now()");
  expect(externalStop).not.toContain("workflow.started_at is null");
});
