/**
 * The cause of a stop openedbot decided itself reaches the thread, against a
 * disposable PostgreSQL database, the real send route, the real queue and the
 * real runner (loopback fake Hermes). A run past its timeout is stopped on
 * Hermes, then reconciled by status: its `run.error` must say
 * `RUN_TIMEOUT` (`watchdogStopCause`), never the generic
 * `HERMES_RUN_CANCELLED`, which reads as if someone had cancelled it.
 *
 * Found while splitting `executeRun` (ADR 0001, S2e): the settlement step had
 * lost the cause on its way to `reconcileHermesRun`, and no test saw it, as
 * `unattended-gates.ts` calls the reconciliation directly. The same path
 * carries `APPROVAL_EXPIRED` and `RUN_INACTIVITY_TIMEOUT`.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import { RUN_TIMEOUT_STOP_CODE } from "../../contracts/errors/src/index.ts";
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

const ORG = "91470000-0000-4000-8000-000000000001";
const USER = "91470000-0000-4000-8000-000000000002";
const id = (n: number) => `91470000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECTION = id(10);
const RUNTIME = id(20);
const BOT = id(101);
const THREAD = id(201);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// The fake run stays in flight for 30 s after its first delta: only the
// worker's run timeout can end it, by a stop.
const hermes = startFakeHermes({ port: 0, delayMs: 30_000, capacity: 4 });

try {
  await withDisposablePostgres("openedbot147_stop_cause", async ({ owner: target, connect }) => {
    const api = await connect("openedbot_api");
    const worker = await connect("openedbot_worker");
    const key = secretEncryptionKey(new Uint8Array(32).fill(47));
    const endpoint = hermes.url.toString().replace(/\/$/, "");
    const bearer = encryptSecret(FAKE_HERMES_TOKEN, key.value);
    await target`insert into users (id, email) values (${USER}, 'openedbot147@example.com')`;
    await target`insert into organizations (id, slug, name) values (${ORG}, 'acme-stop-cause', 'Acme')`;
    await target`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
    await target`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Stop', 0)`;
    await target`insert into runtimes (
        id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
        is_active, capacity, last_health_status, last_probed_at
      ) values (
        ${RUNTIME}, ${ORG}, 'Fake Hermes', 'direct', ${endpoint},
        ${bearer.ciphertext}, ${bearer.nonce}, ${bearer.tag}, ${key.id}, true, 4, 'healthy', now() + interval '1 hour'
      )`;
    await target`insert into bots (id, organization_id, section_id, name, slug, position)
      values (${BOT}, ${ORG}, ${SECTION}, 'Slow', 'slow', 0)`;
    await target`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${THREAD}, ${ORG}, ${BOT}, 'DM', 'openedbot147-session', true)`;

    const workerConfig: WorkerConfig = {
      workerId: "openedbot147-worker",
      apiInternalUrl: "http://127.0.0.1:9",
      internalSecrets: testInternalSecrets("worker", "openedbot147"),
      tokenEncryption: { current: key, previous: [] },
      hermesMtls: null,
      hermesEndpointPolicy: { environment: "test", testHttpUrl: endpoint } as WorkerConfig["hermesEndpointPolicy"],
      leaseSeconds: 30,
      runInactivityMs: 60_000,
      // Long enough for the preflight and the creation, short against the fake run.
      runTimeoutMs: 2_000,
      reconciliationTimeoutMs: 10_000,
      billingEnforced: false,
      cachedInputTokenWeight: 0.1,
      webAppUrl: "http://127.0.0.1:1420",
    };
    const auth: AuthContext = {
      sessionId: "openedbot147-session", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "openedbot147",
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
    app.route("/", conversationRoutes(api, {} as BlobStore, { billingEnforced: false } as ApiConfig));

    const response = await app.request(`/${THREAD}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "prends ton temps" }),
    });
    const accepted = await response.json() as { runId: string };
    assert(response.status === 202, `POST returned ${response.status}: ${JSON.stringify(accepted)}`);
    const claimed = await claimRun(worker, workerConfig);
    assert(claimed?.id === accepted.runId, `expected run ${accepted.runId}, claimed ${claimed?.id}`);
    const startedAt = Date.now();
    await executeRun(worker, workerConfig, claimed);
    const elapsedMs = Date.now() - startedAt;

    const run = (await target<Array<{ status: string; errorCode: string | null; hermesRunId: string | null; remoteStopState: string | null }>>`
      select status, error_code as "errorCode", hermes_run_id as "hermesRunId", remote_stop_state as "remoteStopState"
        from runs where id = ${accepted.runId}`)[0];
    const errors = await target<Array<{ payload: { errorCode?: string; message?: string } }>>`
      select payload from run_events where run_id = ${accepted.runId} and type = 'run.error' order by sequence`;
    assert(run?.hermesRunId, `the run never reached Hermes: ${JSON.stringify(run)}`);
    assert(elapsedMs < 25_000, `the run was not stopped by its timeout (${elapsedMs} ms)`);
    assert(run.remoteStopState === "confirmed", `the stop was not confirmed: ${JSON.stringify(run)}`);
    assert(errors.length === 1, `expected one run.error, got ${JSON.stringify(errors)}`);
    assert(errors[0]!.payload.errorCode === RUN_TIMEOUT_STOP_CODE,
      `the stop cause was lost: run.error ${JSON.stringify(errors[0]!.payload)}, run ${JSON.stringify(run)}`);
    assert(run.errorCode === RUN_TIMEOUT_STOP_CODE, `run row ${JSON.stringify(run)}`);
    console.info(`Run stop cause passed: a run past its timeout is stopped and reconciled as ${RUN_TIMEOUT_STOP_CODE} (${elapsedMs} ms), not as a cancellation.`);
  });
} finally {
  hermes.stop(true);
}
