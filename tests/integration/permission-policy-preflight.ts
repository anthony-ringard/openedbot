/**
 * PERM2-2 against a disposable PostgreSQL database, the real
 * queue and the real runner (loopback fake Hermes). In a `v2` organization a
 * bot whose host policy is not proven in force starts no run: the run fails
 * `PERMISSION_POLICY_NOT_EFFECTIVE` before any Hermes call. The same bot in a
 * `legacy` organization keeps today's behavior and reaches Hermes.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { encryptSecret, secretEncryptionKey } from "../../platform/hermes/src/index.ts";
import { claimRun } from "../../modules/execution/src/application/queue";
import { executeRun } from "../../modules/execution/src/application/runner";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { startFakeHermes } from "../fake-hermes/server";
import { FAKE_HERMES_TOKEN } from "../fake-hermes/defaults";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92520000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const USER = id(2);
const SECTION = id(3);
const RUNTIME = id(4);
const BOT = id(5);
const THREAD = id(6);

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
  await withDisposablePostgres("openedbot252_preflight", async ({ owner: target, connect }) => {
    const worker = await connect("openedbot_worker");
    const key = secretEncryptionKey(new Uint8Array(32).fill(52));
    const endpoint = recorder.url.toString().replace(/\/$/, "");
    const bearer = encryptSecret(FAKE_HERMES_TOKEN, key.value);
    await target`insert into users (id, email) values (${USER}, 'perm2-preflight@example.test')`;
    await target`insert into organizations (id, slug, name, permission_pipeline) values (${ORG}, 'acme-perm2', 'Acme', 'v2')`;
    await target`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
    await target`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'PERM2', 0)`;
    await target`insert into runtimes (
        id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
        is_active, capacity, last_health_status, last_probed_at
      ) values (
        ${RUNTIME}, ${ORG}, 'Fake Hermes', 'direct', ${endpoint},
        ${bearer.ciphertext}, ${bearer.nonce}, ${bearer.tag}, ${key.id}, true, 4, 'healthy', now() + interval '1 hour'
      )`;
    await target`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
      values (${BOT}, ${ORG}, ${SECTION}, 'Scout', 'scout', 0, 'bypass')`;
    await target`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${THREAD}, ${ORG}, ${BOT}, 'DM', 'perm2-preflight', true)`;

    const workerConfig: WorkerConfig = {
      workerId: "perm2-preflight-worker",
      apiInternalUrl: "http://127.0.0.1:9",
      internalSecrets: testInternalSecrets("worker", "perm2"),
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
    const runRow = async (runId: string) => (await target<Array<{ status: string; errorCode: string | null }>>`
      select status, error_code as "errorCode" from runs where id = ${runId}`)[0];
    const queue = async (runId: string, input: string) => target`
      insert into runs (id, organization_id, thread_id, bot_id, input, status, step_index, step_kind, initiator_user_id, deadline_at)
      values (${runId}, ${ORG}, ${THREAD}, ${BOT}, ${input}, 'queued', 0, 'root', ${USER}, now() + interval '1 hour')`;

    // 1. v2, a direct runtime: no host plugin can be proven, no run starts.
    await queue(id(11), "écris un fichier");
    const blocked = await claimRun(worker, workerConfig);
    assert(blocked?.id === id(11), `expected the v2 run to be claimed, got ${blocked?.id}`);
    hermesRequests.length = 0;
    await executeRun(worker, workerConfig, blocked);
    const failed = await runRow(id(11));
    assert(failed?.status === "failed" && failed.errorCode === "PERMISSION_POLICY_NOT_EFFECTIVE",
      `a v2 run without a proven host policy did not fail closed: ${JSON.stringify(failed)}`);
    assert(!hermesRequests.includes("POST /v1/runs"), `a v2 run without proof reached Hermes: ${hermesRequests.join(", ")}`);

    // 2. legacy: the same bot keeps today's behavior and reaches Hermes.
    await target`update organizations set permission_pipeline = 'legacy' where id = ${ORG}`;
    await queue(id(12), "bonjour");
    const allowed = await claimRun(worker, workerConfig);
    assert(allowed?.id === id(12), `expected the legacy run to be claimed, got ${allowed?.id}`);
    hermesRequests.length = 0;
    await executeRun(worker, workerConfig, allowed);
    const done = await runRow(id(12));
    assert(hermesRequests.includes("POST /v1/runs"), `the legacy run never reached Hermes: ${hermesRequests.join(", ")}`);
    assert(done?.status === "completed", `the legacy run did not complete: ${JSON.stringify(done)}`);

    console.log("PERM2-2 PostgreSQL proof passed: an unproven host policy starts no v2 run, legacy unchanged.");
  });
} finally {
  recorder.stop(true);
  hermes.stop(true);
}
