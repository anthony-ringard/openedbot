import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { expect, test } from "bun:test";
import { createPrivateKey, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { readApiConfig } from "../src/infrastructure/config";
import { hashCredential } from "../src/infrastructure/crypto";
import { RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import { startRuntimeLinkServer } from "@openedbot/runtime-link/application/server";
import { createRuntimeLinkGateway, runtimeLinkInternalRoutes } from "../src/routes/runtimes/runtime-link-routes";
import { rawPublicKey } from "@openedbot/runtime-link/application/audit-verdict";
import { RUNTIME_LINK_WS_PATH } from "@openedbot/runtime-link/domain/ws-path";
import { createWorkerRelayDialer } from "@openedbot/execution/application/runtime-client";
import { createRelayTransport, HermesClientError } from "@openedbot/hermes";
import { edgeSetupPath } from "../../../tests/edge-setup-dir";

const runtimeId = "5f0f8a3a-1111-4222-8333-444455556666";
const token = "separation-worker-fixture";
const enabled = process.env.OPENEDBOT_LINK_GATEWAY_E2E === "1";
/** A device key as systemd would unseal it for the daemon: the Ed25519 seed, base64, under `$CREDENTIALS_DIRECTORY/device.key`. */
async function testDeviceKey(): Promise<{ credentials: string; publicKey: string }> {
  const seed = randomBytes(32);
  const credentials = await mkdtemp(join(tmpdir(), "openedbot-link-e2e-creds-"));
  await writeFile(join(credentials, "device.key"), seed.toString("base64") + "\n", { mode: 0o600 });
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  return { credentials, publicKey: rawPublicKey(privateKey) };
}

(enabled ? test : test.skip)("worker HTTP/SSE survive two API process restarts; gateway loss stays ambiguous without replay", async () => {
  const events: string[] = [];
  const config = readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });
  const tx = (async (sql: TemplateStringsArray, ...values: unknown[]) => {
    if (sql.join("").includes("from runtimes") && values.includes(hashCredential("continuity-test-token"))) {
      return [{ id: runtimeId, organizationId: "test-org", isCurrent: true }];
    }
    if (sql.join("").includes("update runtimes set link_device_pubkey =")) return [{ id: runtimeId }];
    return [];
  }) as unknown as Bun.TransactionSQL;
  const db = { begin: async (fn: (tx: Bun.TransactionSQL) => unknown) => fn(tx) } as unknown as Bun.SQL;
  const broker = new RuntimeLinkBroker({ instanceId: "link-fixture", pingIntervalMs: 100, log: () => {}, liveness: {
    async connected() {}, async seen() {}, async disconnected() {}, async event(_link, kind) { events.push(kind); },
  } });
  const app = new Hono();
  let gateway: ReturnType<typeof startRuntimeLinkServer>;
  app.route("/internal/runtime-links", runtimeLinkInternalRoutes(testInternalSecrets("api", token), broker, undefined, { isDraining: () => gateway.draining }));
  // The proof of possession names the URL the host really dialed: the random
  // loopback port is only known once the listener is up, so the list is filled then.
  const wsUrls: string[] = [];
  gateway = startRuntimeLinkServer({ hostname: "127.0.0.1", port: 0, broker,
    gateway: createRuntimeLinkGateway({ db, config, broker, log: () => {}, wsUrls }), fetch: app.fetch, drainTimeoutMs: 50 });
  const linkURL = `http://127.0.0.1:${gateway.server.port}`;
  wsUrls.push(linkURL.replace("http:", "ws:") + RUNTIME_LINK_WS_PATH);
  const device = await testDeviceKey();
  let hostURL = "";
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/host-ready") return new Response(null, { status: 404 });
    hostURL = (await request.json()).url;
    return new Response(null, { status: 204 });
  } });
  const host = Bun.spawn(["go", "test", "-race", "./internal/connector", "-run", "^TestSeparatedGatewayE2EHost$", "-count=1", "-timeout=45s", "-v"], {
    cwd: edgeSetupPath("."),
    env: { ...process.env, OPENEDBOT_LINK_E2E_WS_URL: linkURL.replace("http:", "ws:") + RUNTIME_LINK_WS_PATH, OPENEDBOT_LINK_E2E_CONTROL_URL: `http://127.0.0.1:${control.port}`, CREDENTIALS_DIRECTORY: device.credentials },
    stdout: "inherit", stderr: "inherit",
  });
  let api: Bun.Subprocess | null = null;
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await predicate()) return; await Bun.sleep(10); }
    throw new Error("E2E condition timed out");
  };
  const startApi = async (port = 0) => {
    api = Bun.spawn(["bun", new URL("../../../tests/e2e/runtime-link-api-fixture.ts", import.meta.url).pathname], {
      env: { ...process.env, OPENEDBOT_LINK_E2E_GATEWAY_URL: linkURL, OPENEDBOT_LINK_E2E_API_PORT: String(port) }, stdout: "pipe", stderr: "inherit",
    });
    const reader = (api.stdout as ReadableStream<Uint8Array>).getReader();
    let line = "";
    while (!line.includes("\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("API fixture exited before ready"); line += new TextDecoder().decode(chunk.value); }
    reader.releaseLock();
    return JSON.parse(line) as { port: number; pid: number };
  };
  const state = async () => (await fetch(hostURL + "/test/state")).json() as Promise<Record<string, number>>;
  const release = (id: string) => fetch(`${hostURL}/test/release?id=${id}`, { method: "POST" });
  try {
    await until(() => Boolean(hostURL) && broker.connected(runtimeId));
    const connection = broker.connection(runtimeId);
    const first = await startApi();
    const apiURL = `http://127.0.0.1:${first.port}`;
    const dial = createWorkerRelayDialer(runtimeId, { apiInternalUrl: apiURL, internalSecrets: testInternalSecrets("worker", token), runtimeLinkInternalUrl: linkURL });
    const transport = createRelayTransport({ runtimeId, dial });
    const mutation = (id: string) => transport.send("/v1/runs", { method: "POST", body: JSON.stringify({ id }) }, "mutation");
    const stream = await dial({ method: "GET", path: "/v1/runs/survive-stream/events", headers: {}, body: null });
    const reader = stream.body!.getReader();
    let sse = new TextDecoder().decode((await reader.read()).value);
    const pending = mutation("survive");
    await until(async () => (await state()).survive === 1);
    const apiPids = [first.pid];
    for (let restart = 0; restart < 2; restart++) {
      api!.kill(); await api!.exited; api = null;
      // Direct worker/gateway requests continue even while the API is absent.
      expect((await dial({ method: "GET", path: "/health", headers: {}, body: null })).status).toBe(200);
      const next = await startApi(first.port); apiPids.push(next.pid);
      expect((await fetch(apiURL + "/api/health")).status).toBe(200);
    }
    await release("survive"); await release("survive-stream");
    expect(await (await pending).json()).toEqual({ run_id: "survive" });
    while (true) { const chunk = await reader.read(); if (chunk.done) break; sse += new TextDecoder().decode(chunk.value); }
    expect(Array.from(sse.matchAll(/"seq":(\d+)/g), (match) => Number(match[1]))).toEqual([1, 2]);
    expect(sse).toContain("run.completed");
    expect(new Set(apiPids).size).toBe(3);
    expect(broker.connection(runtimeId)).toBe(connection);
    // A host that presented the unsealed device key was challenged and proved it
    // before admission; one that did not is journaled `pop_missing` (test
    // configuration only: production refuses it) and the evidence says so.
    const popProven = connection?.devicePublicKey === device.publicKey;
    expect(events).toEqual(popProven ? ["device_key_registered", "connected"] : ["pop_missing", "connected"]);
    expect((await state()).survive).toBe(1);

    const lost = mutation("cutoff").then(() => null, (error: unknown) => error);
    await until(async () => (await state()).cutoff === 1);
    gateway.server.stop(true);
    const failure = await lost;
    expect(failure).toBeInstanceOf(HermesClientError);
    expect((failure as HermesClientError).requestDelivery).toBe("ambiguous");
    expect((await state()).cutoff).toBe(1);
    await release("cutoff");
    console.info(JSON.stringify({ evidence: "synthetic-host-real-Go-worker-gateway", apiRestarts: 2, apiPids, continuity: true, cutoffDelivery: "ambiguous", proofOfPossession: popProven ? "proven" : "not_presented_by_host", mutationCounts: await state() }));
  } finally {
    const remainingApi = api as Bun.Subprocess | null;
    if (remainingApi) { remainingApi.kill(); await remainingApi.exited; }
    if (hostURL) {
      for (const id of ["survive", "survive-stream", "cutoff"]) await release(id).catch(() => {});
      await fetch(hostURL + "/test/finish", { method: "POST" }).catch(() => {});
    }
    await Promise.race([host.exited, Bun.sleep(2000)]);
    if (host.exitCode === null) host.kill();
    const hostExit = await host.exited;
    broker.closeAll(); gateway.server.stop(true); control.stop(true);
    expect(hostExit).toBe(0);
  }
}, 45_000);
