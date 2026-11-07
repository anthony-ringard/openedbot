/** Real-provider acceptance across two observed API boots; independent gateway
 * SSE, worker persistence, journal identity and cleanup are all required.
 * Lifecycle commands require explicit argv AND E2E_ALLOW_API_RESTARTS=1.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { proveRemoteCreations, proveBrowserReplay, proveVerdictSignature, type CreationAudit, type BrowserEvidence, type ExpectedRun } from "./runtime-link-external-proof";
import { inspectSealedExport } from "./runtime-link-export-audit-lib";
import type { BotDto, RunDto, ThreadSnapshot, UpdateBotInput } from "@openedbot/contracts-api";
import { hermesProfilePath } from "../../platform/hermes/src/endpoint";
import { parseServerSentEvents } from "../../platform/hermes/src/sse";
import { createWorkerRelayDialer } from "../../modules/execution/src/application/runtime-client";
import { appendParsedGatewayFrame, proveActiveRestart, provePrimaryRunIdentities } from "./runtime-link-continuity-proof";
import { passwordLogin } from "../../scripts/lib/password-login";

const need = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} must be explicit.`); return value; };
if (need("E2E_ALLOW_REAL_RUNS") !== "1") throw new Error("Real provider charges require E2E_ALLOW_REAL_RUNS=1.");
const email = need("E2E_EMAIL"), password = need("E2E_PASSWORD"), runtimeId = need("E2E_RUNTIME_ID");
const provider = need("E2E_PROVIDER"), model = need("E2E_MODEL"), input = need("E2E_RUN_INPUT");
const endInput = process.env.E2E_END_RUN_INPUT ?? "Reply with only CONTINUITY_END_OK.";
// The relay secret (S1b); an unmigrated host still runs on the former single one.
const internalToken = need("RELAY_INTERNAL_TOKEN"), metricsToken = need("METRICS_INTERNAL_TOKEN");
function origin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:"
    && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use HTTPS or loopback HTTP origins without credentials.");
  return url.origin;
}
const apiURL = origin(process.env.E2E_API_URL ?? "http://127.0.0.1:8790"), gatewayURL = origin(need("E2E_LINK_GATEWAY_URL"));
if (gatewayURL === apiURL) throw new Error("A separate gateway origin is required.");
const seconds = Number(process.env.E2E_OBSERVE_SECONDS ?? 1800), runSeconds = Number(process.env.E2E_RUN_TIMEOUT_SECONDS ?? 300);
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86400 || !Number.isInteger(runSeconds) || runSeconds < 10 || runSeconds > 1800) throw new Error("Observation must be 10..86400s; run timeout must be 10..1800s.");
const restartArgv: unknown = process.env.E2E_API_RESTART_ARGV ? JSON.parse(process.env.E2E_API_RESTART_ARGV) : null;
if (restartArgv && (process.env.E2E_ALLOW_API_RESTARTS !== "1" || !Array.isArray(restartArgv) || !restartArgv.length || restartArgv.some((arg) => typeof arg !== "string" || !arg))) throw new Error("Restart argv requires a string array and E2E_ALLOW_API_RESTARTS=1.");
const auditPath = process.env.E2E_CREATION_AUDIT_PATH, browserPath = process.env.E2E_BROWSER_EVIDENCE_PATH;
for (const path of [auditPath, browserPath]) if (path && !isAbsolute(path)) throw new Error("Evidence paths must be explicit absolute local export paths.");
const pageOrigin = process.env.E2E_PAGE_URL ? origin(process.env.E2E_PAGE_URL) : null;
const eventOrigin = process.env.E2E_BROWSER_EVENTS_URL ? origin(process.env.E2E_BROWSER_EVENTS_URL) : pageOrigin;
if (browserPath && !pageOrigin) throw new Error("Browser evidence requires explicit E2E_PAGE_URL.");
const evidenceWait = Number(process.env.E2E_EVIDENCE_WAIT_SECONDS ?? 120);
if (!Number.isInteger(evidenceWait) || evidenceWait < 1 || evidenceWait > 600) throw new Error("Evidence wait must be 1..600 seconds.");
const nonce = crypto.randomUUID(), expectedRuns: ExpectedRun[] = [];
let scenarioStartedAt = "", scenarioEndedAt = "";
async function readExport<T>(path: string): Promise<{ data: T; sha256: string }> {
  const file = Bun.file(path);
  if (file.size > 8_000_000) throw new Error("Evidence export exceeds 8 MB");
  const raw = await file.text();
  return { data: JSON.parse(raw) as T, sha256: createHash("sha256").update(raw).digest("hex") };
}
const artifacts = await mkdtemp(join(tmpdir(), "openedbot-restart-continuity-"));
const result: Record<string, unknown> = { passed: false, acceptanceComplete: false, startedAt: new Date().toISOString(), runtimeId, provider, model, artifacts, observationSeconds: seconds, evidenceKind: "real-runtime", plannedRealRuns: 2, remoteCreationCountVerified: false, browserReplayVerified: false, nonce, limitations: ["The sealed connector audit, decrypted and cross-checked by openedbot, establishes creations dispatched through this connector in the owned profile; creations made outside that path are only covered by the runtime session reconciliation."] };
const secrets = [password, internalToken, metricsToken];
const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
let headers: Record<string, string> = {}, logout: (() => Promise<void>) | null = null;
let bot: { id: string; threadId: string; hermesProfile?: string | null; hermesProfileManaged?: boolean } | null = null;
let runId: string | null = null, runTerminal = false, workerCompleted = false, endRunCompleted = false;
const abortStream = new AbortController();
let streamTimer: ReturnType<typeof setTimeout> | undefined;
class ApiUnavailable extends Error {}
type VerdictKey = { keyId: string; publicKey: string; algorithm: string; ephemeral: boolean };
/** Submits the sealed export unchanged; the runner holds no audit key and never sees the plaintext file. */
async function submitAudit(raw: Uint8Array): Promise<CreationAudit> {
  const response = await fetch(`${apiURL}/api/runtimes/${runtimeId}/creation-audit/verifications`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: raw as Uint8Array<ArrayBuffer>, redirect: "error", signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null) as (CreationAudit & { code?: string; message?: string }) | null;
  assert(response.ok && body, `Audit verification HTTP ${response.status}${body?.code ? ` ${body.code}: ${body.message ?? ""}` : ""}`);
  return body;
}
async function api<T>(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(apiURL + path, { method, headers: { ...headers, "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5000) }); }
  catch { throw new ApiUnavailable("API temporarily unreachable"); }
  if (response.status >= 500) throw new ApiUnavailable(`API HTTP ${response.status}`);
  assert(response.ok, `${method} ${path.split("?")[0]} HTTP ${response.status}`);
  return response.status === 204 ? undefined as T : await response.json() as T;
}
type Run = RunDto;
type Thread = ThreadSnapshot;
type LinkEvent = { id: string; kind: string; occurredAt: string; agent: string | null; meta?: { instanceId?: string; generation?: string } };
const journal = async () => (await api<{ events: LinkEvent[] }>(`/api/runtime/${runtimeId}/link/events?limit=200`)).events;
const thread = async () => {
  const snapshot = await api<Thread>(`/api/threads/${bot!.threadId}?events=full`);
  assert(snapshot.id === bot!.threadId && !snapshot.truncated, "Thread snapshot is mismatched or truncated; complete persistence proof unavailable.");
  return snapshot;
};
const boot = async () => {
  const data = await api<{ api: { startedAt: string } }>("/internal/metrics", "GET", undefined, { Authorization: `Bearer ${metricsToken}` });
  assert(Number.isFinite(Date.parse(data.api.startedAt)), "API metrics did not supply a valid boot timestamp.");
  return data.api.startedAt;
};
const sse: Array<{ sequence: number; type: string; at: string }> = [];
const restarts: Array<{ from: string; to: string; observedAt: string; runId: string; remoteId: string }> = [];
let streamError: unknown, streamDone = false, streamTask: Promise<void> | null = null;
let baseline: LinkEvent[] = [], known = new Set<string>();
const verifyLink = async () => {
  const { runtime } = await api<{ runtime: { id: string; reachability: string; link: { connected: boolean } | null } | null }>("/api/runtime");
  assert(runtime?.id === runtimeId && runtime.reachability === "connector" && runtime.link?.connected, "Active runtime changed or link disconnected.");
  const after = await journal();
  assert(after.some((event) => event.id === baseline[0]?.id), "Journal boundary fell outside the 200-event window.");
  assert(!after.some((event) => !known.has(event.id)), "New link events occurred during acceptance.");
  return after;
};
try {
  const response = await passwordLogin(apiURL, { email, password }, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    onCode: (code) => secrets.push(code),
  });
  assert(response.ok, `Login HTTP ${response.status}`);
  const auth = await response.json() as { organizationId: string; csrfToken: string };
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  assert(cookie && auth.organizationId && auth.csrfToken, "Incomplete login session.");
  secrets.push(cookie, auth.csrfToken); headers = { Cookie: cookie, "X-OpenedBot-Organization": auth.organizationId, "X-CSRF-Token": auth.csrfToken };
  logout = async () => { await api("/api/auth/logout", "POST"); };
  baseline = await journal(); known = new Set(baseline.map((event) => event.id));
  assert(baseline.length > 0, "Missing journal boundary."); await verifyLink();
  const identity = baseline.find((event) => event.kind === "connected" || event.kind === "replaced")?.meta;
  assert(identity?.instanceId && identity.generation, "Missing persisted gateway instance/generation identity.");
  result.connectionIdentity = identity;
  let lastBoot = await boot(); result.initialBoot = lastBoot;
  const catalog = await api<{ providers: Array<{ slug: string; authenticated: boolean; models: Array<{ id: string }> }> }>(`/api/runtimes/${runtimeId}/models`);
  assert(catalog.providers.some((entry) => entry.slug === provider && entry.authenticated && entry.models.some((entry) => entry.id === model)), "Explicit provider/model is unavailable; no fallback is allowed.");
  const dial = createWorkerRelayDialer(runtimeId, { apiInternalUrl: apiURL, internalSecrets: testInternalSecrets("worker", { RELAY_INTERNAL_TOKEN: internalToken }), runtimeLinkInternalUrl: gatewayURL });
  assert((await dial({ method: "GET", path: "/health", headers: {}, body: null }, AbortSignal.timeout(5000))).ok, "Separate gateway health failed.");
  await Bun.write(join(artifacts, "journal-before.json"), JSON.stringify(baseline, null, 2));
  console.info(JSON.stringify({ event: "real_inference_opt_in", runtimeId, provider, model, artifacts, observationSeconds: seconds, plannedRealRuns: 2, restartMode: restartArgv ? "explicit-command" : "externally-coordinated", note: "Provider usage may be billed." }));
  bot = await api("/api/bots", "POST", { name: `Continuity ${crypto.randomUUID().slice(0, 8)}`, instructions: "Follow the requested output. Do not perform external actions." });
  assert(bot?.id && bot.threadId, "Bot creation did not return identity.");
  await api<BotDto>(`/api/bots/${bot.id}`, "PATCH", { provider, model } satisfies UpdateBotInput);
  const configured = (await api<{ bots: BotDto[] }>("/api/bots")).bots.find((entry) => entry.id === bot!.id);
  assert(configured?.model === model, "Bot did not persist the explicit model.");
  if (browserPath) {
    const manifest = { nonce, threadId: bot.threadId, botId: bot.id, apiOrigin: apiURL, eventOrigin, pageOrigin, observationSeconds: seconds };
    await Bun.write(join(artifacts, "browser-manifest.json"), JSON.stringify(manifest, null, 2));
    console.info(JSON.stringify({ event: "awaiting_browser_observer", manifest: join(artifacts, "browser-manifest.json"), browserPath, deadlineSeconds: evidenceWait }));
    const readyDeadline = Date.now() + evidenceWait * 1000;
    let ready = false;
    do {
      if (await Bun.file(browserPath).exists()) {
        const { data } = await readExport<BrowserEvidence>(browserPath);
        ready = data.nonce === nonce && data.threadId === bot.threadId && data.source === "ghostchrome-mcp-page-fetch" && data.phase === "observing" && data.apiOrigin === apiURL && data.pageOrigin === pageOrigin && data.eventOrigin === eventOrigin && data.pagePath === `/bot/${bot.id}` && data.requests.some((request) => request.status === 200);
      }
      if (!ready) await Bun.sleep(500);
    } while (!ready && Date.now() < readyDeadline);
    assert(ready, "No matching browser observer ready export before deadline.");
  }
  scenarioStartedAt = new Date().toISOString();
  runId = (await api<{ runId: string }>(`/api/threads/${bot.threadId}/messages`, "POST", { input })).runId;
  assert(runId, "No run returned; mutation is not retried.");
  const deadline = Date.now() + runSeconds * 1000, observationDeadline = Date.now() + seconds * 1000;
  let own: Run | undefined;
  do {
    own = (await thread()).runs.find((run) => run.id === runId);
    if (own?.status === "running" && own.hermesResponseId) break;
    assert(!own?.endedAt, "Run finished before active-overlap evidence could begin.");
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  assert(own?.status === "running" && own.hermesResponseId, "No active remote run observed.");
  const remoteId = own.hermesResponseId;
  result.run = { id: runId, remoteId, startedAt: own.startedAt };
  const path = (bot.hermesProfile ? hermesProfilePath(bot.hermesProfile) : "") + `/v1/runs/${encodeURIComponent(remoteId)}/events?since=0`;
  streamTimer = setTimeout(() => abortStream.abort("run deadline exceeded"), Math.max(1, deadline - Date.now()));
  const stream = await dial({ method: "GET", path, headers: { accept: "text/event-stream" }, body: null }, abortStream.signal);
  assert(stream.ok && stream.body, "Independent gateway SSE failed to open.");
  streamTask = (async () => {
    for await (const frame of parseServerSentEvents(stream.body!)) {
      appendParsedGatewayFrame(sse, frame);
      if (sse.length === 1) console.info(JSON.stringify({ event: "continuity_stream_active", runId, remoteId, at: sse[0]!.at }));
    }
    streamDone = true;
  })().catch((error) => { streamError = error; });
  let unavailableSince: number | null = null, previousActive = true, restartInvocations = 0;
  while (Date.now() < deadline) {
    if (streamError) throw streamError;
    try {
      const currentBoot = await boot(), current = (await thread()).runs.find((run) => run.id === runId);
      assert(current?.hermesResponseId === remoteId, "Worker remote run identity changed.");
      if (currentBoot !== lastBoot) {
        restarts.push(proveActiveRestart({ previousBoot: lastBoot, currentBoot, previousActive,
          sseStarted: Boolean(sse[0] && Date.parse(sse[0].at) <= Date.parse(currentBoot)), runId, remoteId, run: current }));
        lastBoot = currentBoot;
      }
      previousActive = current.status === "running"; unavailableSince = null;
      if (current.endedAt) { assert(current.status === "completed", `Worker terminal status ${current.status}`); runTerminal = true; workerCompleted = true; break; }
      if (restartArgv && sse.length && restartInvocations < 2 && restarts.length === restartInvocations) {
        const restart = Bun.spawn(restartArgv as string[], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdout: "pipe", stderr: "pipe" });
        const out = new Response(restart.stdout).text(), err = new Response(restart.stderr).text();
        const timer = setTimeout(() => restart.kill(), 30_000);
        const exit = await restart.exited; clearTimeout(timer); restartInvocations++;
        await Bun.write(join(artifacts, `restart-${restartInvocations}.log`), redact((await out) + (await err)));
        assert(exit === 0, "Explicit restart command failed.");
      }
    } catch (error) {
      if (!(error instanceof ApiUnavailable)) throw error;
      unavailableSince ??= Date.now(); assert(Date.now() - unavailableSince < 30_000, "API outage exceeded 30 seconds.");
    }
    await Bun.sleep(250);
  }
  assert(runTerminal, "Worker did not reach completed before deadline.");
  await Promise.race([streamTask, Bun.sleep(5000)]);
  if (streamError) throw streamError;
  assert(streamDone && sse.filter((event) => event.type === "run.completed").length === 1 && !sse.some((event) => event.type === "run.error"), "Independent SSE did not complete exactly once.");
  assert(restarts.length >= 2, "Fewer than two proven API restarts overlapped the real run.");
  const persisted = await thread();
  provePrimaryRunIdentities(persisted.runs, [runId]);
  assert(persisted.messages.filter((message) => message.runId === runId && message.role === "assistant").length === 1, "Expected exactly one persisted assistant response.");
  const runEvents = persisted.events.filter((event) => event.runId === runId);
  assert(runEvents.filter((event) => event.type === "run.completed").length === 1, "Worker terminal event missing or duplicated.");
  assert(new Set(runEvents.map((event) => event.sequence)).size === runEvents.length, "Duplicate worker event sequence.");
  assert(runEvents.every((event, index) => index === 0 || event.sequence > runEvents[index - 1]!.sequence), "Worker events persisted out of sequence.");
  expectedRuns.push({ id: runId, remoteId, assistantMessageId: persisted.messages.find((message) => message.runId === runId && message.role === "assistant")!.id, events: runEvents.map(({ cursor, sequence, type }) => ({ cursor, sequence, type })) });
  result.persistedEvents = runEvents.map(({ sequence, type }) => ({ sequence, type }));
  clearTimeout(streamTimer);
  let nextProgress = 0;
  while (Date.now() < observationDeadline) {
    await verifyLink();
    if (Date.now() >= nextProgress) {
      console.info(JSON.stringify({ event: "continuity_observation", remainingSeconds: Math.ceil((observationDeadline - Date.now()) / 1000), apiRestarts: restarts.length, streamCompleted: true }));
      nextProgress = Date.now() + 30_000;
    }
    await Bun.sleep(Math.max(0, Math.min(1000, observationDeadline - Date.now())));
  }
  // A second bounded inference proves the same runtime remains usable at the end.
  runTerminal = false;
  runId = (await api<{ runId: string }>(`/api/threads/${bot.threadId}/messages`, "POST", { input: endInput })).runId;
  assert(runId, "No final run returned; mutation is not retried.");
  const endDeadline = Date.now() + runSeconds * 1000;
  let endRun: Run | undefined;
  do {
    endRun = (await thread()).runs.find((run) => run.id === runId);
    if (endRun?.hermesResponseId) break;
    assert(!endRun?.endedAt, "Final run ended without remote identity.");
    await Bun.sleep(250);
  } while (Date.now() < endDeadline);
  assert(endRun?.hermesResponseId, "No final remote run observed.");
  const endRemoteId = endRun.hermesResponseId;
  const endSSE: typeof sse = [];
  result.endRun = { id: runId, remoteId: endRemoteId, sse: endSSE };
  console.info(JSON.stringify({ event: "continuity_final_run", runId, remoteId: endRemoteId, plannedRealRuns: 2 }));
  streamTimer = setTimeout(() => abortStream.abort("final run deadline exceeded"), Math.max(1, endDeadline - Date.now()));
  const endStream = await dial({ method: "GET", path: (bot.hermesProfile ? hermesProfilePath(bot.hermesProfile) : "") + `/v1/runs/${encodeURIComponent(endRemoteId)}/events?since=0`, headers: { accept: "text/event-stream" }, body: null }, abortStream.signal);
  assert(endStream.ok && endStream.body, "Final gateway SSE failed to open.");
  let endStreamDone = false;
  streamTask = (async () => {
    for await (const frame of parseServerSentEvents(endStream.body!)) appendParsedGatewayFrame(endSSE, frame);
    endStreamDone = true;
  })().catch((error) => { streamError = error; });
  while (Date.now() < endDeadline) {
    if (streamError) throw streamError;
    endRun = (await thread()).runs.find((run) => run.id === runId);
    assert(endRun?.hermesResponseId === endRemoteId, "Final remote identity changed.");
    if (endRun.endedAt) { runTerminal = true; assert(endRun.status === "completed", `Final worker status ${endRun.status}`); break; }
    await verifyLink(); await Bun.sleep(250);
  }
  assert(runTerminal, "Final worker run exceeded deadline.");
  await Promise.race([streamTask, Bun.sleep(5000)]);
  if (streamError) throw streamError;
  assert(endStreamDone && endSSE.filter((event) => event.type === "run.completed").length === 1 && !endSSE.some((event) => event.type === "run.error"), "Final gateway SSE did not complete exactly once.");
  const finalThread = await thread(), finalEvents = finalThread.events.filter((event) => event.runId === runId);
  provePrimaryRunIdentities(finalThread.runs, [expectedRuns[0]!.id, runId]);
  assert(finalThread.messages.filter((message) => message.runId === runId && message.role === "assistant").length === 1, "Final assistant response missing or duplicated.");
  assert(finalEvents.filter((event) => event.type === "run.completed").length === 1 && finalEvents.every((event, index) => index === 0 || event.sequence > finalEvents[index - 1]!.sequence), "Final persisted events missing, duplicated or unordered.");
  result.endRun = { id: runId, remoteId: endRemoteId, sse: endSSE, persistedEvents: finalEvents.map(({ sequence, type }) => ({ sequence, type })) };
  expectedRuns.push({ id: runId, remoteId: endRemoteId, assistantMessageId: finalThread.messages.find((message) => message.runId === runId && message.role === "assistant")!.id, events: finalEvents.map(({ cursor, sequence, type }) => ({ cursor, sequence, type })) });
  scenarioEndedAt = new Date().toISOString();
  endRunCompleted = true;
  clearTimeout(streamTimer);
  await Bun.write(join(artifacts, "journal-after.json"), JSON.stringify(await verifyLink(), null, 2));
  result.continuityScenarioComplete = seconds >= 1800; result.passed = true;
  const expected = { nonce, runtimeId, profile: bot.hermesProfile ?? "default", threadId: bot.threadId, apiOrigin: apiURL, eventOrigin: eventOrigin ?? "", pageOrigin: pageOrigin ?? "", pagePath: `/bot/${bot.id}`, startedAt: scenarioStartedAt, endedAt: scenarioEndedAt, boots: restarts.map((restart) => restart.to), runs: expectedRuns };
  await Bun.write(join(artifacts, "evidence-expectations.json"), JSON.stringify(expected, null, 2));
  if (auditPath || browserPath) {
    console.info(JSON.stringify({ event: "awaiting_external_evidence", artifacts, auditPath, browserPath, deadlineSeconds: evidenceWait }));
    const exportDeadline = Date.now() + evidenceWait * 1000;
    let auditReady = !auditPath, browserReady = !browserPath;
    do {
      if (auditPath && await Bun.file(auditPath).exists()) {
        // The export is opaque here: header and digest only, then openedbot decrypts,
        // cross-checks its own dispatch log and signs a dated verdict.
        const raw = new Uint8Array(await Bun.file(auditPath).arrayBuffer());
        const inspection = inspectSealedExport(raw);
        assert(inspection.header.runtimeId === runtimeId, "Audit export belongs to another runtime.");
        const verdictKey = await api<VerdictKey>("/api/creation-audit/verdict-key");
        const verdict = await submitAudit(raw);
        const signature = proveVerdictSignature(verdict, verdictKey.publicKey, inspection.sha256);
        await Bun.write(join(artifacts, "creation-audit-verdict-key.json"), JSON.stringify(verdictKey, null, 2));
        await Bun.write(join(artifacts, "creation-audit-verdict.json"), JSON.stringify(verdict, null, 2));
        result.remoteCreationEvidence = { ...proveRemoteCreations(verdict, expected), exportSha256: inspection.sha256, exportWriteSeq: inspection.header.writeSeq, keyId: inspection.header.keyId, receivedAt: verdict.receivedAt, ...signature };
        if (signature.ephemeral) (result.limitations as string[]).push("The verdict was signed by an ephemeral development key; a production API signs with AUDIT_VERDICT_SIGNING_KEY.");
        result.remoteCreationCountVerified = true; auditReady = true;
      }
      if (browserPath && await Bun.file(browserPath).exists()) {
        const browser = await readExport<BrowserEvidence>(browserPath);
        if (browser.data.phase === "complete" && browser.data.nonce === nonce) {
          result.browserReplayEvidence = { ...proveBrowserReplay(browser.data, expected), sha256: browser.sha256 };
          await Bun.write(join(artifacts, "browser-evidence.json"), JSON.stringify(browser.data, null, 2));
          result.browserReplayVerified = true; browserReady = true;
        }
      }
      if (!auditReady || !browserReady) await Bun.sleep(500);
    } while ((!auditReady || !browserReady) && Date.now() < exportDeadline);
    assert(auditReady && browserReady, "External evidence export deadline exceeded.");
  }
} catch (error) { result.passed = false; result.error = redact(error instanceof Error ? error.message : "Unknown failure"); process.exitCode = 1; }
finally {
  clearTimeout(streamTimer);
  abortStream.abort(); await streamTask;
  result.restarts = restarts; result.sse = sse;
  if (bot) {
    try {
      if (runId && !runTerminal) {
        await api(`/api/threads/${bot.threadId}/stop`, "POST");
        const stopDeadline = Date.now() + 30_000;
        do {
          const stopped = (await thread()).runs.find((run) => run.id === runId);
          if (stopped?.endedAt) { runTerminal = true; break; }
          await Bun.sleep(250);
        } while (Date.now() < stopDeadline);
        assert(runTerminal, "Test run did not stop; refusing to hide it with a forced purge.");
      }
      const cleanup = await api<{ hostCleanup: "queued" | "none" }>(`/api/bots/${bot.id}?purge=1`, "DELETE");
      assert(cleanup.hostCleanup === "queued" || cleanup.hostCleanup === "none", "Remote artifact cleanup was not recorded.");
      result.cleanup = cleanup;
    } catch (error) { result.cleanupError = redact(error instanceof Error ? error.message : "Cleanup failed"); result.passed = false; result.acceptanceComplete = false; process.exitCode = 1; }
  }
  if (logout) try { await logout(); result.sessionCleanup = "revoked"; } catch { result.sessionCleanup = "failed"; result.passed = false; result.acceptanceComplete = false; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  result.missingGates = [
    ...(result.remoteCreationCountVerified ? [] : ["Independent evidence of remote creation count"]),
    ...(result.browserReplayVerified ? [] : ["Real browser event catch-up after API restart"]),
    ...(seconds >= 1800 ? [] : ["At least 30 minutes of observation"]),
    ...(endRunCompleted ? [] : ["Completed final real run with ordered gateway SSE and worker persistence"]),
    ...(restarts.length >= 2 ? [] : ["Two API boot changes during the same active run"]),
    ...(workerCompleted ? [] : ["Completed worker run"]),
    ...(streamDone && !streamError && sse.filter((event) => event.type === "run.completed").length === 1 ? [] : ["Uninterrupted ordered gateway SSE through terminal"]),
    ...(result.persistedEvents ? [] : ["Unique ordered worker persistence"]),
    ...(result.cleanup ? [] : ["Test artifact cleanup"]),
    ...(result.sessionCleanup === "revoked" ? [] : ["Authentication session cleanup"]),
  ];
  result.acceptanceComplete = result.passed === true && (result.missingGates as string[]).length === 0;
  await Bun.write(join(artifacts, "result.json"), redact(JSON.stringify(result, null, 2)));
  console.info(redact(JSON.stringify(result)));
}
