import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { claimRun } from "../src/application/queue";
import { WORKFLOW_ADMISSION_GRACE_SECONDS } from "../src/application/queue-sweeps";

function fakeDb() {
  const statements: string[] = [];
  const db = ((parts: TemplateStringsArray) => {
    statements.push([...parts].join(" "));
    return Promise.resolve([]);
  }) as unknown as SQL;
  (db as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(db);
  return { db, statements };
}

test("claimRun stays eligible for a never-started workflow past its exec deadline, within the admission grace window", async () => {
  const { db, statements } = fakeDb();
  await claimRun(db, { workerId: "worker-1", billingEnforced: false, leaseSeconds: 30 } as never);
  const claim = statements.find((sql) => sql.includes("with candidate_run")) ?? "";
  // The exec deadline alone must not be the sole gate once a workflow never started.
  expect(claim).toContain("workflow.started_at is null");
  expect(claim).toContain("now() - (");
  expect(claim).toContain("* interval '1 second')");
  // candidate_run must carry created_at through for workflow_guard to use it.
  expect(claim).toContain("r.created_at");
  expect(claim).toContain("candidate.created_at");
});

test("WORKFLOW_ADMISSION_GRACE_SECONDS is a generous but finite ceiling (queue starvation still terminates eventually)", () => {
  expect(WORKFLOW_ADMISSION_GRACE_SECONDS).toBeGreaterThan(1800); // plus que le budget d'exécution par défaut
  expect(WORKFLOW_ADMISSION_GRACE_SECONDS).toBeLessThan(24 * 3600); // mais pas infini
});
