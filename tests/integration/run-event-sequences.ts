/**
 * S2c (ADR 0001, sections 4.5 and 5; inventory docs/architecture/0002, section 5,
 * defects D2 and D3): run event sequences under concurrent producers, against a
 * disposable PostgreSQL, each producer on its own connection.
 *
 *  1. Concurrent producers on one run (worker notices, API receipts, batches
 *     spanning two runs): sequences unique and contiguous per run, cursor order
 *     equal to sequence order, and a cursor tailer polling meanwhile sees every
 *     event (commit order is cursor order: nothing skipped).
 *  2. D2: a sweep that fails a queued run (`failRunsOnUnhealthyDirectRuntimes`)
 *     while another writer holds an uncommitted event of the same run. It used
 *     to compute `max+1` in the statement that waited for the cursor, from a
 *     snapshot older than the wait, and lost its `run.error` in silence.
 *  3. D3: the worker's numbered write (`persistEvents`) after a foreign event
 *     took its sequence is refused with a named error, and the failure path
 *     still journals the run's `run.error`, instead of dropping the event and
 *     skipping the transition it carried.
 *  4. D3, as it happened: a completion that appends a notice (fire-and-forget
 *     warning) before the `tool.result.attached` the normalizer numbered after
 *     `run.completed` used to lose that event; every event is now kept.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { encryptSecret, secretEncryptionKey } from "../../platform/hermes/src/index.ts";
import { failRunsOnUnhealthyDirectRuntimes } from "../../modules/execution/src/application/runtime-direct";
import { recordRunReceiptsTx } from "../../modules/execution/src/application/run-receipts";
import { appendNoticeTx } from "../../modules/execution/src/application/runner/events";
import { handleFailure } from "../../modules/execution/src/application/runner/failure";
import { persistEvents } from "../../modules/execution/src/application/runner/persist";
import type { RunContext } from "../../modules/execution/src/application/runner/types";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { appendRunEventsTx } from "../../modules/execution/src/sql/run-events";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `93000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const USER = id(2);
const RUNTIME = id(3);
const SECTION = id(4);
const BOT = id(5);
const MESSAGE = id(6);
const threads = { busy: id(201), sweep: id(202), fence: id(203), tools: id(204) };
const runs = { busy: id(301), other: id(302), sweep: id(303), fence: id(304), tools: id(305) };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Row = { cursor: string; runId: string; sequence: number; type: string };

await withDisposablePostgres("openedbot3_s2c_sequences", async ({ owner, connect }) => {
  const key = secretEncryptionKey(new Uint8Array(32).fill(9));
  const bearer = encryptSecret("s2c-unused", key.value);
  await owner`insert into users (id, email) values (${USER}, 's2c-sequences@example.test')`;
  await owner`insert into organizations (id, slug, name) values (${ORG}, 's2c-sequences', 's2c-sequences')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'S2c', 0)`;
  await owner`insert into runtimes (
      id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
      is_active, capacity, last_health_status, last_probed_at
    ) values (
      ${RUNTIME}, ${ORG}, 'Hermes', 'direct', 'http://127.0.0.1:9', ${bearer.ciphertext}, ${bearer.nonce},
      ${bearer.tag}, ${key.id}, true, 4, 'healthy', now() + interval '1 hour'
    )`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position)
    values (${BOT}, ${ORG}, ${SECTION}, 'Neo', 'neo', 0)`;
  for (const [name, threadId] of Object.entries(threads)) {
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${threadId}, ${ORG}, ${BOT}, ${name}, ${`s2c-${name}`}, ${name === "busy"})`;
  }
  const insertRun = (runId: string, threadId: string, status: string, extra: { leased?: boolean; old?: boolean } = {}) => owner`
    insert into runs (id, organization_id, thread_id, bot_id, input, status, step_kind, step_index,
                      lease_owner, lease_expires_at, lease_generation, external_state, started_at, created_at)
    values (${runId}, ${ORG}, ${threadId}, ${BOT}, 'S2c', ${status}, 'root', 0,
            ${extra.leased ? "s2c-worker" : null}, ${extra.leased ? new Date(Date.now() + 600_000) : null},
            ${extra.leased ? 1 : 0}, ${extra.leased ? "streaming" : "not_started"},
            ${extra.leased ? new Date() : null}, ${extra.old ? new Date(Date.now() - 3_600_000) : new Date()})`;
  await insertRun(runs.busy, threads.busy, "queued");
  await insertRun(runs.other, threads.busy, "queued");
  await owner`insert into messages (id, organization_id, thread_id, run_id, role, content)
    values (${MESSAGE}, ${ORG}, ${threads.busy}, ${runs.busy}, 'user', ${[{ type: "text", text: "Bonjour" }]})`;

  const journal = async (runId: string) => owner<Row[]>`
    select cursor::text as cursor, run_id as "runId", sequence, type from run_events
     where organization_id = ${ORG} and run_id = ${runId} order by run_events.cursor
  `;

  // 1. Concurrent producers on one run.
  const PRODUCERS = { notices: 4, receipts: 2, batches: 2 };
  const ROUNDS = 12;
  const workers = await Promise.all(Array.from({ length: PRODUCERS.notices + PRODUCERS.batches }, () => connect("openedbot_worker")));
  const apis = await Promise.all(Array.from({ length: PRODUCERS.receipts }, () => connect("openedbot_api")));
  const tailer = await connect("openedbot_worker");
  const busy = { organizationId: ORG, threadId: threads.busy, id: runs.busy };
  const hold = (tx: SQL) => tx`select pg_sleep(0.002)`;
  let producing = true;
  const seen = new Set<string>();
  let last = 0;
  const tail = async () => {
    const rows = await tailer<Array<{ cursor: string }>>`
      select cursor::text as cursor from run_events where organization_id = ${ORG} and cursor > ${last} order by run_events.cursor
    `;
    for (const row of rows) {
      seen.add(row.cursor);
      last = Math.max(last, Number(row.cursor));
    }
  };
  const tailing = (async () => { while (producing) { await tail(); await Bun.sleep(1); } })();
  const producers = [
    ...workers.slice(0, PRODUCERS.notices).map((db, producer) => (async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        await db.begin(async (tx) => {
          await appendNoticeTx(tx as unknown as SQL, busy, { message: "notice", producer, round });
          await hold(tx as unknown as SQL);
        });
      }
    })()),
    ...workers.slice(PRODUCERS.notices).map((db, producer) => (async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        await db.begin(async (tx) => {
          const draft = (runId: string, step: number) => ({
            organizationId: ORG, threadId: threads.busy, runId, type: "system.notice", payload: { batch: producer, round, step },
          });
          await appendRunEventsTx(tx as unknown as SQL, [draft(runs.busy, 0), draft(runs.other, 1), draft(runs.busy, 2)]);
          await hold(tx as unknown as SQL);
        });
      }
    })()),
    ...apis.map((db) => (async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        await db.begin(async (tx) => {
          await tx`select set_config('app.organization_id', ${ORG}, true)`;
          await recordRunReceiptsTx(tx as unknown as SQL, { organizationId: ORG, messageIds: [MESSAGE] });
          await hold(tx as unknown as SQL);
        });
      }
    })()),
  ];
  await Promise.all(producers);
  producing = false;
  await tailing;
  await tail();

  const expected = {
    busy: ROUNDS * (PRODUCERS.notices + PRODUCERS.receipts + 2 * PRODUCERS.batches),
    other: ROUNDS * PRODUCERS.batches,
  };
  for (const [name, count] of Object.entries(expected)) {
    const rows = await journal(runs[name as keyof typeof expected]);
    assert(rows.length === count, `${name}: ${rows.length} events for ${count} written`);
    assert(rows.every((row, index) => row.sequence === index),
      `${name}: sequences in cursor order are not 0..${count - 1}: ${rows.map((row) => row.sequence).join(",")}`);
  }
  const all = await owner<Array<{ cursor: string }>>`select cursor::text as cursor from run_events where organization_id = ${ORG}`;
  const missed = all.filter((row) => !seen.has(row.cursor));
  assert(missed.length === 0, `the cursor tailer skipped ${missed.length} committed events (cursor not in commit order)`);

  // 2. D2: a failing sweep races a writer of the same queued run.
  await insertRun(runs.sweep, threads.sweep, "queued", { old: true });
  await owner`update runtimes set last_health_status = 'unreachable' where id = ${RUNTIME}`;
  const [holder, sweeper] = [workers[0]!, workers[1]!];
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => { wrote = resolve; });
  const holding = holder.begin(async (tx) => {
    await appendNoticeTx(tx as unknown as SQL, { organizationId: ORG, threadId: threads.sweep, id: runs.sweep }, { message: "first" });
    wrote();
    await released;
  });
  await written;
  const sweeping = failRunsOnUnhealthyDirectRuntimes(sweeper, 30 * 60_000);
  const whileHeld = await Promise.race([sweeping.then(() => "finished"), Bun.sleep(300).then(() => "blocked")]);
  assert(whileHeld === "blocked", "the sweep did not wait for the writer holding the run");
  release();
  await holding;
  assert(await sweeping === 1, "the sweep did not fail the queued run");
  const swept = await journal(runs.sweep);
  assert(swept.map((row) => `${row.sequence}:${row.type}`).join(",") === "0:system.notice,1:run.error",
    `D2: the sweep's run.error was lost or misnumbered: ${JSON.stringify(swept)}`);
  await owner`update runtimes set last_health_status = 'healthy' where id = ${RUNTIME}`;

  // 3. D3: a numbered write whose sequence a foreign event took.
  const blobRoot = mkdtempSync(join(tmpdir(), "s2c-blobs-"));
  const config = {
    workerId: "s2c-worker",
    apiInternalUrl: "http://127.0.0.1:9",
    internalSecrets: testInternalSecrets("worker", "s2c"),
    tokenEncryption: { current: key, previous: [] },
    hermesMtls: null,
    leaseSeconds: 30,
    runInactivityMs: 20_000,
    runTimeoutMs: 30_000,
    reconciliationTimeoutMs: 10_000,
    billingEnforced: false,
    cachedInputTokenWeight: 0.1,
    webAppUrl: "http://127.0.0.1:1420",
    blob: { driver: "file", root: blobRoot },
  } as unknown as WorkerConfig;
  const context = (runId: string, threadId: string) => ({
    id: runId, organizationId: ORG, threadId, botId: BOT, botName: "Neo", botSlug: "neo", botDescription: null,
    sessionId: `s2c-${threadId}`, leaseGeneration: 1, workflowId: null, workflowRootRunId: null, workflowStatus: null,
    groupId: null, groupTurnPosition: null, groupState: null, stepKind: "root", originRunId: null,
    provider: null, runtimeId: RUNTIME, input: "S2c", attempts: 1, hermesRunId: "hermes-s2c", lastHermesSequence: 0,
    externalState: "streaming", remoteStopState: null, permissionMode: null, planOnly: false,
    operator: { name: "Kévin", handle: "kevin" },
  }) as unknown as RunContext;
  const worker = workers[2]!;
  await insertRun(runs.fence, threads.fence, "running", { leased: true });
  const fenced = context(runs.fence, threads.fence);
  // The normalizer would start at 0; a writer that ignores the lease convention takes it first.
  await worker.begin((tx) => appendNoticeTx(tx as unknown as SQL, fenced, { message: "foreign" }));
  const refused = await persistEvents(worker, config, fenced, 1, [{
    sequence: 0, type: "run.error", occurredAt: new Date(), payload: { message: "Hermes a échoué.", errorCode: "HERMES_RUN_FAILED" },
  }]).then(() => null, (error: unknown) => error);
  assert((refused as { code?: string } | null)?.code === "RUN_EVENT_SEQUENCE_CONFLICT",
    `D3: the colliding run.error was swallowed instead of refused (${String(refused)})`);
  const [stillRunning] = await owner<Array<{ status: string }>>`select status from runs where id = ${runs.fence}`;
  assert(stillRunning?.status === "running", "the refused batch wrote its transition anyway");
  await handleFailure(worker, config, fenced, refused);
  const [failedRun] = await owner<Array<{ status: string; errorCode: string }>>`
    select status, error_code as "errorCode" from runs where id = ${runs.fence}`;
  const fencedJournal = await journal(runs.fence);
  assert(failedRun?.status === "failed" && failedRun.errorCode === "RUN_EVENT_SEQUENCE_CONFLICT",
    `the failure path did not settle the run: ${JSON.stringify(failedRun)}`);
  assert(fencedJournal.map((row) => `${row.sequence}:${row.type}`).join(",") === "0:system.notice,1:run.error",
    `the failure path did not journal its run.error after the foreign event: ${JSON.stringify(fencedJournal)}`);

  // 4. D3 as it happened: the completion's notice must not take the next event's sequence.
  await insertRun(runs.tools, threads.tools, "running", { leased: true });
  const tools = context(runs.tools, threads.tools);
  await persistEvents(worker, config, tools, 1, [{
    sequence: 0, type: "tool.call", occurredAt: new Date(), payload: { tool: "delegate_task", toolCallId: "tc_0" },
  }]);
  await persistEvents(worker, config, tools, 2, [
    { sequence: 1, type: "run.completed", occurredAt: new Date(), payload: { output: "Tâche confiée." } },
    { sequence: 2, type: "tool.result.attached", occurredAt: new Date(), payload: { tool: "delegate_task", toolCallId: "tc_0", result: "ok" } },
  ]);
  const toolJournal = await journal(runs.tools);
  assert(toolJournal.map((row) => `${row.sequence}:${row.type}`).join(",")
    === "0:tool.call,1:run.completed,2:tool.result.attached,3:system.notice",
    `D3: an event of the completion batch was lost: ${JSON.stringify(toolJournal)}`);
  const [completedRun] = await owner<Array<{ status: string }>>`select status from runs where id = ${runs.tools}`;
  assert(completedRun?.status === "completed", "the completion did not settle the run");

  console.info(JSON.stringify({
    test: "run-event-sequences", passed: true,
    concurrentEvents: expected.busy + expected.other, tailerSawAll: true, d2: "fixed", d3: "refused, then journaled",
  }));
});
