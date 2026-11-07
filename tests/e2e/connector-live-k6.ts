/** Health-transport E2E on the authenticated active connector; no inference/mutations.
 * Required: E2E_EMAIL, E2E_PASSWORD, RELAY_INTERNAL_TOKEN, k6 in PATH or K6_BIN.
 * Optional: E2E_API_URL, E2E_RUNTIME_ID, E2E_ARTIFACT_DIR.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { passwordLogin } from "../../scripts/lib/password-login";

const artifactBase = process.env.E2E_ARTIFACT_DIR ?? tmpdir();
await mkdir(artifactBase, { recursive: true });
const artifacts = await mkdtemp(join(artifactBase, "openedbot-connector-live-k6-"));
const secrets: string[] = [];
const redact = (text: string) => secrets.reduce((value, secret) => secret ? value.replaceAll(secret, "[redacted]") : value, text)
  .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [redacted]");
const result: Record<string, unknown> = { kind: "live-connector-health-transport-e2e", startedAt: new Date().toISOString(), artifacts, passed: false };
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required explicitly.`);
  return value;
}
type Runtime = { id: string; name: string; reachability: string; isActive: boolean; detectedVersion: string | null; link: { connected: boolean } | null };
type Configuration = { runtime: Runtime | null; runtimeMode: string };
type LinkEvent = { id: string; kind: string; occurredAt: string; agent: string | null };
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = "", truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!truncated && text.length + chunk.length <= 1_000_000) text += chunk;
    else truncated = true;
  }
  if (truncated) text = text.slice(0, text.lastIndexOf("\n")) + "\n[output truncated]\n";
  return redact(text);
}
let logout: (() => Promise<void>) | null = null;
const publicEvents = (events: LinkEvent[]) => events.map(({ id, kind, occurredAt, agent }) => ({ id, kind, occurredAt, agent }));
try {
  const email = requireEnv("E2E_EMAIL"), password = requireEnv("E2E_PASSWORD"), token = requireEnv("RELAY_INTERNAL_TOKEN");
  secrets.push(password, token);
  const k6 = process.env.K6_BIN || Bun.which("k6");
  if (!k6) throw new Error("Install official k6 or set K6_BIN.");
  const origin = new URL(process.env.E2E_API_URL ?? "http://127.0.0.1:8790");
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
    || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("E2E_API_URL must be an HTTPS origin or HTTP loopback origin without credentials.");
  }
  const base = origin.origin;
  result.apiUrl = base;
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(base + path, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${path.split("?")[0]} returned HTTP ${response.status}.`);
    return response;
  }
  const apiHealth = await (await request("/api/health")).json() as { version?: string };
  result.apiVersion = apiHealth.version ?? null;
  const login = await passwordLogin(base, { email, password }, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    onCode: (code) => secrets.push(code),
  });
  if (!login.ok) throw new Error(`Login returned HTTP ${login.status}.`);
  const auth = await login.json() as { csrfToken?: string; organizationId?: string };
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  if (!cookie || !auth.organizationId || !auth.csrfToken) throw new Error("Login did not establish a session and organization.");
  secrets.push(cookie, auth.csrfToken);
  const headers = { Cookie: cookie, "X-OpenedBot-Organization": auth.organizationId };
  logout = async () => {
    await request("/api/auth/logout", { method: "POST", headers: { ...headers, "X-CSRF-Token": auth.csrfToken! } });
  };
  const configuration = async () => (await request("/api/runtime", { headers })).json() as Promise<Configuration>;
  const initial = await configuration(), runtime = initial.runtime;
  if (initial.runtimeMode !== "external") throw new Error("The health-transport E2E requires external runtime mode.");
  if (!runtime?.id || runtime.reachability !== "connector" || !runtime.isActive || !runtime.link?.connected) throw new Error("The authenticated account has no active connected connector.");
  if (process.env.E2E_RUNTIME_ID && process.env.E2E_RUNTIME_ID !== runtime.id) throw new Error("The observed active runtime differs from E2E_RUNTIME_ID.");
  const journal = async () => {
    const body = await (await request(`/api/runtime/${runtime.id}/link/events?limit=200`, { headers })).json() as { events: LinkEvent[] };
    if (!Array.isArray(body.events) || body.events.length > 200 || body.events.some(event => !event.id)) throw new Error("Invalid bounded runtime journal.");
    return body.events;
  };
  const before = await journal(), baselineId = before[0]?.id;
  if (!baselineId) throw new Error("No baseline link event is available; cannot prove continuity.");
  const internalHeaders = { Authorization: `Bearer ${token}` };
  await request(`/internal/runtime-links/${runtime.id}/proxy/health`, { headers: internalHeaders });
  const capabilities = await (await request(`/internal/runtime-links/${runtime.id}/proxy/v1/capabilities`, { headers: internalHeaders })).json() as { version?: string };
  result.runtime = { id: runtime.id, name: runtime.name, mode: initial.runtimeMode, organizationId: auth.organizationId,
    gatewayVersion: capabilities.version ?? runtime.detectedVersion ?? null, connectorAgent: before.find(event => event.agent)?.agent ?? null };
  result.before = { connected: true, baselineId, journalCount: before.length };
  await Bun.write(join(artifacts, "journal-before.json"), redact(JSON.stringify(publicEvents(before), null, 2)));
  const summaryPath = join(artifacts, "k6-summary.json");
  const child = Bun.spawn([k6, "run", "--no-usage-report", new URL("./connector-live.k6.js", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENEDBOT_K6_RUNTIME_ID: runtime.id, OPENEDBOT_K6_INTERNAL_TOKEN: token,
      OPENEDBOT_K6_API_URL: base, OPENEDBOT_K6_SUMMARY: summaryPath }, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]);
  await Promise.all([Bun.write(join(artifacts, "k6.stdout.log"), stdout), Bun.write(join(artifacts, "k6.stderr.log"), stderr)]);
  result.k6ExitCode = exitCode;
  const final = await configuration(), after = await journal();
  const baselineVisible = after.some(event => event.id === baselineId), initialIds = new Set(before.map(event => event.id));
  const newEvents = after.filter(event => !initialIds.has(event.id));
  result.after = { connected: final.runtime?.link?.connected === true, runtimeId: final.runtime?.id ?? null, baselineVisible, newEvents: publicEvents(newEvents) };
  await Bun.write(join(artifacts, "journal-after.json"), redact(JSON.stringify(publicEvents(after), null, 2)));
  const summary = await Bun.file(summaryPath).json();
  result.k6 = { requests: summary.metrics.http_reqs?.values, failures: summary.metrics.http_req_failed?.values,
    checks: summary.metrics.checks?.values, durationMs: summary.metrics.http_req_duration?.values };
  if (exitCode !== 0 || !(summary.metrics.http_reqs?.values.count > 0) || summary.metrics.http_req_failed?.values.rate !== 0 || summary.metrics.checks?.values.rate !== 1) throw new Error("k6 health-transport assertions failed.");
  if (!baselineVisible) throw new Error("Baseline event fell outside the 200-entry journal window; continuity cannot be established.");
  if (newEvents.length) throw new Error("New runtime link events occurred during the load test.");
  if (final.runtime?.id !== runtime.id || final.runtimeMode !== initial.runtimeMode || !final.runtime.isActive || !final.runtime.link?.connected) throw new Error("The active runtime changed or ended disconnected.");
  result.passed = true;
} catch (error) {
  result.error = redact(error instanceof Error ? error.message : "Unknown test failure");
  process.exitCode = 1;
} finally {
  if (logout) {
    try { await logout(); result.sessionCleanup = "revoked"; }
    catch (error) {
      result.sessionCleanup = "failed";
      result.cleanupError = redact(error instanceof Error ? error.message : "Session cleanup failed");
      result.passed = false;
      process.exitCode = 1;
    }
  }
  result.finishedAt = new Date().toISOString();
  await Bun.write(join(artifacts, "result.json"), redact(JSON.stringify(result, null, 2)));
  console.info(redact(JSON.stringify(result)));
}
