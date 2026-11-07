import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { HermesCapabilityInventory, HermesMcpInventory } from "@openedbot/hermes";
import type { RuntimeReadKind, SnapshotStore } from "@openedbot/runtimes/application/runtime-read-snapshots";
import type { ApiConfig } from "../src/infrastructure/config";
import { integrationRouteContext } from "../src/routes/runtimes/runtime-integration-context";
import { createInventoryWarmer, internalInventoryRoutes } from "../src/routes/runtimes/runtime-inventory-warm";
import { HttpError } from "../src/interfaces/http/http-error";

const ORG = "00000000-0000-4000-8000-000000000001";
const RUNTIME = "00000000-0000-4000-8000-000000000101";

function memorySnapshots(): SnapshotStore & { rows: Map<string, { document: unknown; observedAt: Date }> } {
  const rows = new Map<string, { document: unknown; observedAt: Date }>();
  const key = (org: string, runtime: string, kind: RuntimeReadKind) => `${org}/${runtime}/${kind}`;
  return {
    rows,
    async read(org, runtime, kind) { return rows.get(key(org, runtime, kind)) ?? null; },
    async write(org, runtime, kind, document, observedAt) { rows.set(key(org, runtime, kind), { document, observedAt }); },
    async invalidate() {},
  };
}

const inventory: HermesCapabilityInventory = {
  toolsets: [{ name: "web", label: "Web", description: null, enabled: true, configured: true, tools: ["web_search"] }],
  skills: [{ name: "research", description: null, category: "work" }],
};

function harness(options: { activeRuntime?: string | null; hostRead?: () => Promise<void>; failInventory?: boolean } = {}) {
  const snapshots = memorySnapshots();
  const counts = { runtime: 0, inventory: 0, mcp: 0 };
  const ctx = integrationRouteContext(null as unknown as SQL, {} as ApiConfig, {
    snapshotStore: snapshots,
    timeoutMs: 1_000,
    readRuntime: (async () => {
      counts.runtime += 1;
      const id = options.activeRuntime === undefined ? RUNTIME : options.activeRuntime;
      return id === null ? null : {
        id, name: "Hermes", capacity: 4,
        linkFeatures: ["mcp_management"],
        client: { endpoint: "https://runtime.invalid", token: "t", policy: { environment: "production" } },
      };
    }) as never,
    clientFactory: (() => ({
      capabilityInventory: async () => {
        counts.inventory += 1;
        await options.hostRead?.();
        if (options.failInventory) throw new Error("host down");
        return inventory;
      },
      connectorManagementProbe: async () => ({ status: "not_exposed" as const, serverCount: null }),
      hostCapabilities: async () => null,
      mcpInventory: async () => {
        counts.mcp += 1;
        await options.hostRead?.();
        return { servers: [], catalog: [] } as unknown as HermesMcpInventory;
      },
    })) as never,
  });
  return { warmer: createInventoryWarmer(ctx), snapshots, counts };
}

describe("réchauffage de l'inventaire sur signal de l'hôte", () => {
  test("a signal re-reads integrations and MCP and stores both snapshots", async () => {
    const { warmer, snapshots, counts } = harness();
    warmer.warm(ORG, RUNTIME);
    await warmer.idle();
    expect(counts.inventory).toBe(1);
    expect(counts.mcp).toBe(1);
    expect(snapshots.rows.has(`${ORG}/${RUNTIME}/integrations`)).toBe(true);
    expect(snapshots.rows.has(`${ORG}/${RUNTIME}/mcp`)).toBe(true);
  });

  test("a burst during a read costs exactly one more read, never one per signal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const { warmer, counts } = harness({ hostRead: async () => { if (first) { first = false; await gate; } } });
    warmer.warm(ORG, RUNTIME);
    for (let index = 0; index < 50; index++) warmer.warm(ORG, RUNTIME);
    release();
    await warmer.idle();
    expect(counts.runtime).toBe(2);
    expect(counts.inventory).toBe(2);
  });

  test("a runtime that is no longer the active one is not read", async () => {
    const { warmer, counts } = harness({ activeRuntime: "00000000-0000-4000-8000-000000000999" });
    warmer.warm(ORG, RUNTIME);
    await warmer.idle();
    expect(counts.inventory).toBe(0);
    expect(counts.mcp).toBe(0);
  });

  test("a failing host read is contained: nothing stored for it, the other kind still is, nothing thrown", async () => {
    const { warmer, snapshots } = harness({ failInventory: true });
    warmer.warm(ORG, RUNTIME);
    await warmer.idle();
    // The inventory DTO carries the failure and is not kept; MCP is.
    expect(snapshots.rows.has(`${ORG}/${RUNTIME}/integrations`)).toBe(false);
    expect(snapshots.rows.has(`${ORG}/${RUNTIME}/mcp`)).toBe(true);
  });
});

describe("POST /internal/runtime-inventory/changed", () => {
  const token = "internal-token-0123456789";
  function app() {
    const warmed: string[] = [];
    const routes = internalInventoryRoutes(testInternalSecrets("api", token), {
      warm: (organizationId, runtimeId) => warmed.push(`${organizationId}/${runtimeId}`),
      idle: async () => {},
    });
    routes.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED" } }, 500));
    return { routes, warmed };
  }
  const call = (routes: ReturnType<typeof app>["routes"], body: unknown, authorization = `Bearer ${token}`) =>
    routes.request("/changed", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });

  test("the gateway's signal starts a warm and answers 202", async () => {
    const { routes, warmed } = app();
    const response = await call(routes, { organizationId: ORG, runtimeId: RUNTIME });
    expect(response.status).toBe(202);
    expect(warmed).toEqual([`${ORG}/${RUNTIME}`]);
  });

  test("a wrong bearer is refused and warms nothing", async () => {
    const { routes, warmed } = app();
    const response = await call(routes, { organizationId: ORG, runtimeId: RUNTIME }, "Bearer nope");
    expect(response.status).toBe(401);
    expect(warmed).toEqual([]);
  });

  test("identifiers that are not UUIDs are refused", async () => {
    const { routes, warmed } = app();
    expect((await call(routes, { organizationId: "org-1", runtimeId: RUNTIME })).status).toBe(400);
    expect((await call(routes, { organizationId: ORG })).status).toBe(400);
    expect(warmed).toEqual([]);
  });
});
