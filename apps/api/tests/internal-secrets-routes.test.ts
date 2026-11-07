import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { readInternalSecrets, type InternalSecrets } from "@openedbot/platform-config/internal-secrets";
import type { Db } from "@openedbot/platform-db";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { NO_RUNTIME_LINK_LOCATOR } from "@openedbot/runtime-link/application/instances";
import { internalEventRoutes } from "../src/routes/events/event-routes";
import { internalInventoryRoutes } from "../src/routes/runtimes/runtime-inventory-warm";
import { runtimeLinkInternalRoutes } from "../src/routes/runtimes/runtime-link-routes";

/**
 * S1b (ADR 0001, 4.7): every internal route accepts the secret of its role and
 * refuses the others, the run-key secret included. Authentication runs before
 * anything else, so any status but 401 means the bearer was accepted.
 */
const split = {
  EVENTS_INTERNAL_TOKEN: "e".repeat(64),
  RELAY_INTERNAL_TOKEN: "r".repeat(64),
  INVENTORY_INTERNAL_TOKEN: "i".repeat(64),
  RUN_KEY_SECRET: "k".repeat(64),
};
const OTHER = "x".repeat(64);

function app(secrets: InternalSecrets<"api">): Hono {
  const db = { begin: async () => [] } as unknown as Db;
  const routes = new Hono();
  routes.route("/internal/events", internalEventRoutes(db, secrets, new EventHub(), () => {}));
  routes.route("/internal/runtime-inventory", internalInventoryRoutes(secrets, { warm: () => {}, idle: async () => {} }));
  routes.route("/internal/runtime-links", runtimeLinkInternalRoutes(secrets, null, NO_RUNTIME_LINK_LOCATOR));
  routes.onError((error, context) => {
    const status = (error as { status?: number }).status ?? 500;
    return context.json({ error: String(error) }, status as 400);
  });
  return routes;
}

const ROUTES = {
  events: { path: "/internal/events/publish", method: "POST", body: "{}" },
  inventory: { path: "/internal/runtime-inventory/changed", method: "POST", body: "{}" },
  relayProxy: { path: "/internal/runtime-links/5f0f8a3a-1111-4222-8333-444455556666/proxy/health", method: "GET", body: undefined },
  relayControl: { path: "/internal/runtime-links/5f0f8a3a-1111-4222-8333-444455556666/control", method: "POST", body: "{}" },
  relayProbe: { path: "/internal/runtime-links/5f0f8a3a-1111-4222-8333-444455556666/probe", method: "POST", body: "{}" },
} as const;
const ROLE_OF: Record<keyof typeof ROUTES, keyof typeof split> = {
  events: "EVENTS_INTERNAL_TOKEN",
  inventory: "INVENTORY_INTERNAL_TOKEN",
  relayProxy: "RELAY_INTERNAL_TOKEN",
  relayControl: "RELAY_INTERNAL_TOKEN",
  relayProbe: "RELAY_INTERNAL_TOKEN",
};

async function status(routes: Hono, route: keyof typeof ROUTES, bearer: string): Promise<number> {
  const { path, method, body } = ROUTES[route];
  const response = await routes.request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body,
  });
  return response.status;
}

describe("internal routes, one secret per role (S1b)", () => {
  test("each route accepts its role's secret only; the run-key secret is never a bearer", async () => {
    const routes = app(readInternalSecrets("api", "production", split));
    for (const route of Object.keys(ROUTES) as Array<keyof typeof ROUTES>) {
      for (const [name, value] of Object.entries(split)) {
        const accepted = (await status(routes, route, value)) !== 401;
        expect({ route, name, accepted }).toEqual({ route, name, accepted: name === ROLE_OF[route] });
      }
      expect(await status(routes, route, OTHER)).toBe(401);
    }
  });
});
