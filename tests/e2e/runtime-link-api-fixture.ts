import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
// Ephemeral API facade process for the runtime link continuity proof; production internal routes, fixture
// ownership lookup. Its lifecycle must never own the connector WebSocket.
import { Hono } from "hono";
import { readApiConfig } from "../../apps/api/src/infrastructure/config";
import { RuntimeLinkBroker } from "../../modules/runtime-link/src/application/broker";
import { createRuntimeLinkLocator } from "../../modules/runtime-link/src/application/instances";
import { runtimeLinkInternalRoutes } from "../../apps/api/src/routes/runtimes/runtime-link-routes";

const token = "separation-worker-fixture";
const config = readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });
const db = (async () => [{ instanceId: "link-fixture", internalUrl: process.env.OPENEDBOT_LINK_E2E_GATEWAY_URL, instanceLive: true }]) as unknown as Bun.SQL;
const broker = new RuntimeLinkBroker({ instanceId: "api-fixture", log: () => {}, liveness: {
  async connected() {}, async seen() {}, async disconnected() {},
} });
const app = new Hono();
app.get("/api/health", (c) => c.json({ fixture: true, pid: process.pid }));
app.route("/internal/runtime-links", runtimeLinkInternalRoutes(testInternalSecrets("api", token), broker, createRuntimeLinkLocator(db, {
  instanceId: "api-fixture", apiInternalUrl: "http://127.0.0.1", relay: testInternalSecrets("api", token),
})));
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.OPENEDBOT_LINK_E2E_API_PORT || 0), fetch: app.fetch });
console.log(JSON.stringify({ port: server.port, pid: process.pid }));
