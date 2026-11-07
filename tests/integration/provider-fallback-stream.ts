/**
 * A provider failure in the middle of a run, against a disposable PostgreSQL
 * database, the real send route, the real queue and the real runner. A
 * recorder in front of the fake Hermes scripts the first attempt's event
 * stream and the catalogue (two authenticated providers).
 *
 * 1. Quota: the worker re-routes once, and the answer of the second attempt
 *    is persisted whole. Measured 2026-10-24: the `run.provider_fallback`
 *    notice took the sequence of the next attempt's first delta, whose insert
 *    was then dropped by `on conflict do nothing`: "ello" for "hello".
 * 2. Authentication: the bot's provider refused its login. The run is never
 *    served by the other provider: it fails with `PROVIDER_AUTH_REQUIRED`
 *    naming the provider, and the next run still goes to that provider.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
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

const ORG = "91320000-0000-4000-8000-000000000001";
const USER = "91320000-0000-4000-8000-000000000002";
const id = (n: number) => `91320000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECTION = id(10);
const RUNTIME = id(20);
const bots = { quota: id(101), auth: id(102) };
const threads = { quota: id(201), auth: id(202) };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const CATALOG = {
  provider: "fake",
  model: "fake/hermes",
  providers: [
    {
      slug: "fake", name: "Fake provider", is_current: true, authenticated: true, auth_type: "oauth",
      models: ["fake/hermes"], capabilities: { "fake/hermes": { fast: false, reasoning: false } },
    },
    {
      slug: "fake-backup", name: "Backup provider", is_current: false, authenticated: true, auth_type: "api_key",
      models: ["fake/backup"], capabilities: { "fake/backup": { fast: false, reasoning: false } },
    },
  ],
};

type Script = Array<Record<string, unknown>>;
const sse = (frames: Script) => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
  headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
});
const at = () => Date.now() / 1_000;
const QUOTA_FAILURE = "HTTP 429: The usage limit has been reached";
const AUTH_FAILURE = "Provider authentication failed: xAI token refresh failed. Response: {\"error\":\"invalid_grant\",\"error_description\":\"Invalid or unknown refresh token\"} Run `hermes -p pilote-live model` to re-authenticate.";

const hermes = startFakeHermes({ port: 0, delayMs: 5, capacity: 4 });
/** Event streams to serve, in order, one per created Hermes run. */
let scripts: Script[] = [];
const created: Array<{ runId: string; provider: string | null; model: string | null }> = [];
const scripted = new Map<string, Script>();
const recorder = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/model/options" && request.method === "GET") return Response.json(CATALOG);
    const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (events && scripted.has(decodeURIComponent(events[1]!))) {
      const runId = decodeURIComponent(events[1]!);
      return sse(scripted.get(runId)!.map((frame) => ({ run_id: runId, timestamp: at(), ...frame })));
    }
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const response = await fetch(`${hermes.url.origin}${url.pathname}${url.search}`, {
      method: request.method, headers: request.headers, body,
    });
    if (url.pathname === "/v1/runs" && request.method === "POST" && response.status < 300) {
      const sent = JSON.parse(new TextDecoder().decode(body)) as { provider?: string; model?: string };
      const answer = await response.json() as { run_id: string };
      created.push({ runId: answer.run_id, provider: sent.provider ?? null, model: sent.model ?? null });
      const script = scripts.shift();
      if (script) scripted.set(answer.run_id, script);
      return Response.json(answer, { status: response.status });
    }
    return response;
  },
});

try {
  await withDisposablePostgres("openedbot132_fallback", async ({ owner: target, connect }) => {
    const api = await connect("openedbot_api");
    const worker = await connect("openedbot_worker");
    const key = secretEncryptionKey(new Uint8Array(32).fill(32));
    const endpoint = recorder.url.toString().replace(/\/$/, "");
    const bearer = encryptSecret(FAKE_HERMES_TOKEN, key.value);
    await target`insert into users (id, email) values (${USER}, 'openedbot132@example.com')`;
    await target`insert into organizations (id, slug, name) values (${ORG}, 'acme-fallback', 'Acme')`;
    await target`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
    await target`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Fallback', 0)`;
    await target`insert into runtimes (
        id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
        is_active, capacity, last_health_status, last_probed_at
      ) values (
        ${RUNTIME}, ${ORG}, 'Fake Hermes', 'direct', ${endpoint},
        ${bearer.ciphertext}, ${bearer.nonce}, ${bearer.tag}, ${key.id}, true, 4, 'healthy', now() + interval '1 hour'
      )`;
    for (const [position, [slug, botId, threadId]] of ([["quota", bots.quota, threads.quota], ["auth", bots.auth, threads.auth]] as const).entries()) {
      await target`insert into bots (id, organization_id, section_id, name, slug, position)
        values (${botId}, ${ORG}, ${SECTION}, ${slug}, ${slug}, ${position})`;
      await target`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
        values (${threadId}, ${ORG}, ${botId}, 'DM', ${`openedbot132-${threadId}`}, true)`;
    }

    const workerConfig: WorkerConfig = {
      workerId: "openedbot132-worker",
      apiInternalUrl: "http://127.0.0.1:9",
      internalSecrets: testInternalSecrets("worker", "openedbot132"),
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
    const auth: AuthContext = {
      sessionId: "openedbot132-session", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "openedbot132",
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
    app.route("/", conversationRoutes(api, {} as BlobStore, { billingEnforced: false } as ApiConfig));
    const turn = async (threadId: string, input: string) => {
      const response = await app.request(`/${threadId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }),
      });
      const accepted = await response.json() as { runId: string };
      assert(response.status === 202, `POST ${input} returned ${response.status}: ${JSON.stringify(accepted)}`);
      const claimed = await claimRun(worker, workerConfig);
      assert(claimed?.id === accepted.runId, `expected run ${accepted.runId}, claimed ${claimed?.id}`);
      await executeRun(worker, workerConfig, claimed);
      return accepted.runId;
    };
    const eventsOf = (runId: string) => target<Array<{ sequence: number; type: string; payload: Record<string, unknown> }>>`
      select sequence, type, payload from run_events where run_id = ${runId} order by sequence`;
    const runOf = async (runId: string) => (await target<Array<{ status: string; errorCode: string | null; model: string | null }>>`
      select status, error_code as "errorCode", model from runs where id = ${runId}`)[0];

    // 1. Quota mid-stream: one fallback, and the whole answer.
    scripts = [
      [{ event: "run.started" }, { event: "run.failed", message: QUOTA_FAILURE }],
      [{ event: "message.delta", delta: "h" }, { event: "message.delta", delta: "ello" },
        { event: "run.completed", output: "hello", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }],
    ];
    const quotaRun = await turn(threads.quota, "dis bonjour");
    const quotaEvents = await eventsOf(quotaRun);
    const text = quotaEvents.filter((event) => event.type === "agent.message").map((event) => String(event.payload.text ?? "")).join("");
    const fallback = quotaEvents.filter((event) => event.type === "run.provider_fallback");
    const firstText = quotaEvents.find((event) => event.type === "agent.message");
    assert(text === "hello", `the answer after a fallback lost characters: ${JSON.stringify(text)} in ${JSON.stringify(quotaEvents.map((event) => [event.sequence, event.type]))}`);
    assert(fallback.length === 1 && firstText && fallback[0]!.sequence < firstText.sequence,
      `fallback notice missing or after the answer: ${JSON.stringify(quotaEvents.map((event) => [event.sequence, event.type]))}`);
    assert(fallback[0]!.payload.to === "fake-backup" && fallback[0]!.payload.reason === "quota", `fallback payload ${JSON.stringify(fallback[0]!.payload)}`);
    const quotaRow = await runOf(quotaRun);
    assert(quotaRow?.status === "completed" && quotaRow.model === "fake/backup", `quota run row ${JSON.stringify(quotaRow)}`);
    assert(created.length === 2 && created[0]!.provider === "fake" && created[1]!.provider === "fake-backup",
      `Hermes runs created ${JSON.stringify(created)}`);
    await target`delete from runtime_provider_incidents where organization_id = ${ORG}`;

    // 2. Authentication mid-stream: no fallback, an actionable failure.
    created.length = 0;
    scripts = [[{ event: "run.started" }, { event: "run.failed", message: AUTH_FAILURE }]];
    const authRun = await turn(threads.auth, "dis bonjour");
    const authRow = await runOf(authRun);
    const authEvents = await eventsOf(authRun);
    const authError = authEvents.find((event) => event.type === "run.error");
    assert(created.length === 1 && created[0]!.provider === "fake", `an auth failure was re-routed: ${JSON.stringify(created)}`);
    assert(!authEvents.some((event) => event.type === "run.provider_fallback"), "an auth failure wrote a fallback notice");
    assert(authRow?.status === "failed" && authRow.errorCode === "PROVIDER_AUTH_REQUIRED", `auth run row ${JSON.stringify(authRow)}`);
    assert(authError?.payload.errorCode === "PROVIDER_AUTH_REQUIRED" && authError.payload.provider === "fake",
      `auth run.error payload ${JSON.stringify(authError?.payload)}`);
    assert(!String(authError.payload.message).includes("invalid_grant"), "the upstream text reached the thread");
    const incident = (await target<Array<{ kind: string }>>`
      select kind from runtime_provider_incidents where organization_id = ${ORG} and provider = 'fake'`)[0];
    assert(incident?.kind === "auth", `auth incident ${JSON.stringify(incident)}`);

    // The next turn still goes to the bot's provider, never to the backup:
    // once the login is repaired it answers, and the incident clears.
    created.length = 0;
    const repaired = await turn(threads.auth, "et maintenant ?");
    assert(created.length === 1 && created[0]!.provider === "fake", `the turn after an auth failure went elsewhere: ${JSON.stringify(created)}`);
    assert((await runOf(repaired))?.status === "completed", "the repaired turn did not complete");
    const left = await target`select 1 from runtime_provider_incidents where organization_id = ${ORG} and provider = 'fake'`;
    assert(left.length === 0, "a completed run on the provider did not clear its auth incident");
    console.info("Provider fallback stream passed: a quota fallback keeps the whole answer after its notice; an auth failure is never re-routed, fails with PROVIDER_AUTH_REQUIRED naming the provider, and the next turn stays on it.");
  });
} finally {
  recorder.stop(true);
  hermes.stop(true);
}
