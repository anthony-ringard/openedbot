import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ApiConfig } from "../src/infrastructure/config";
import type { RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import { NO_RUNTIME_LINK_LOCATOR } from "@openedbot/runtime-link/application/instances";
import { startRuntimeLinkServer } from "@openedbot/runtime-link/application/server";
import { HttpError } from "../src/interfaces/http/http-error";
import { RUNTIME_LINK_INTERNAL_PREFIX, RUNTIME_LINK_WS_PATH, runtimeLinkInternalRoutes, type LinkSocketData, type RuntimeLinkGateway } from "../src/routes/runtimes/runtime-link-routes";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const gateway: RuntimeLinkGateway = {
  handleUpgrade: async () => new Response(null, { status: 426 }),
  websocket: { open() {}, message() {}, close() {}, pong() {} },
};
function stubBroker(inFlight = 0) {
  const state = { inFlight, closed: false };
  const broker = {
    get inFlightCount() { return state.inFlight; },
    closeAll() { state.closed = true; },
  } as unknown as RuntimeLinkBroker;
  return { broker, state };
}

describe("persistent gateway bounded transport drain", () => {
  test("hung drain observer cannot hold the transport open forever", async () => {
    const { broker, state } = stubBroker(1);
    const events: string[] = [];
    const service = startRuntimeLinkServer({ gateway, broker, port: 0, fetch: () => new Response("ok"), drainTimeoutMs: 25,
      onDraining: () => new Promise(() => {}),
      onStopped: async () => { expect(state.closed).toBe(true); events.push("owner-stopped"); },
      log: (event) => { events.push(event); },
    });
    const start = performance.now();
    try {
      const first = service.drain();
      expect(service.drain()).toBe(first);
      await first;
      expect(performance.now() - start).toBeLessThan(500);
      expect(state.closed).toBe(true);
      expect(events).toEqual(["runtime_link.draining", "runtime_link.drain_observer_failed", "owner-stopped", "runtime_link.stopped"]);
    } finally { service.server.stop(true); }
  });

  test("accepted work finishes before closure and ownership stop", async () => {
    const { broker, state } = stubBroker(1);
    const service = startRuntimeLinkServer({ gateway, broker, port: 0, fetch: () => new Response("ok"), drainTimeoutMs: 250,
      onStopped: async () => { expect(state.inFlight).toBe(0); expect(state.closed).toBe(true); },
    });
    try {
      const stopping = service.drain();
      expect(state.closed).toBe(false);
      state.inFlight = 0;
      await stopping;
      expect(state.closed).toBe(true);
    } finally { service.server.stop(true); }
  });

  test("a response body still leaving the gateway survives after broker work finishes", async () => {
    const { broker } = stubBroker();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const service = startRuntimeLinkServer({ gateway, broker, port: 0, drainTimeoutMs: 500,
      fetch: () => new Response(new ReadableStream<Uint8Array>({ start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode("first"));
      } })),
    });
    try {
      const response = await fetch(service.server.url);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
      const stopping = service.drain();
      await Bun.sleep(10);
      controller.enqueue(new TextEncoder().encode("last"));
      controller.close();
      let tail = "";
      while (true) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
      expect(tail).toBe("last");
      await stopping;
    } finally { await service.server.stop(true); }
  });

  test("failed owner update propagates after transport closure without a false stopped success", async () => {
    const { broker, state } = stubBroker();
    const events: string[] = [];
    const failure = new Error("owner update failed");
    const service = startRuntimeLinkServer({ gateway, broker, port: 0, fetch: () => new Response("ok"),
      onStopped: async () => { throw failure; }, log: (event) => { events.push(event); },
    });
    expect(await service.drain().catch((error: unknown) => error)).toBe(failure);
    expect(state.closed).toBe(true);
    expect(events).not.toContain("runtime_link.stopped");
  });

  test("upgrade authenticated before drain cannot open a late socket", async () => {
    const authStarted = deferred();
    const authContinue = deferred();
    const { broker, state } = stubBroker(1);
    let admitted: boolean | undefined;
    const service = startRuntimeLinkServer({ broker, port: 0, fetch: () => new Response("ok"), drainTimeoutMs: 500,
      gateway: { ...gateway, handleUpgrade: async (request, server) => {
        authStarted.resolve();
        await authContinue.promise;
        admitted = server.upgrade(request, { data: {} as LinkSocketData });
        return new Response(null, { status: admitted ? 200 : 503 });
      } },
    });
    try {
      const response = fetch(new URL(RUNTIME_LINK_WS_PATH, service.server.url));
      await authStarted.promise;
      const stopping = service.drain();
      const refused = await fetch(new URL(RUNTIME_LINK_WS_PATH, service.server.url));
      expect(refused.status).toBe(503);
      expect(refused.headers.get("Retry-After")).toBe("1");
      authContinue.resolve();
      expect((await response).status).toBe(503);
      expect(admitted).toBe(false);
      state.inFlight = 0;
      await stopping;
    } finally { service.server.stop(true); }
  });
});

test("drain authenticates callers, refuses new writes and admits existing-run reconciliation", async () => {
  const forwarded: string[] = [];
  const broker = {
    connected: () => true,
    dialer: () => async (request: { path: string }) => { forwarded.push(request.path); return Response.json({ ok: true }); },
  } as unknown as RuntimeLinkBroker;
  const app = new Hono();
  app.route(RUNTIME_LINK_INTERNAL_PREFIX, runtimeLinkInternalRoutes(testInternalSecrets("api", "test"), broker, NO_RUNTIME_LINK_LOCATOR, { isDraining: () => true }));
  app.onError((error) => new Response(null, { status: error instanceof HttpError ? error.status : 500 }));
  const origin = `${RUNTIME_LINK_INTERNAL_PREFIX}/rt-1/proxy`;
  expect((await app.request(`${origin}/v1/runs`, { method: "POST" })).status).toBe(401);
  const blocked = await app.request(`${origin}/v1/runs`, { method: "POST", headers: { authorization: "Bearer test" } });
  expect(blocked.status).toBe(503);
  expect(blocked.headers.get("X-OpenedBot-Relay-Stage")).toBe("before_dispatch");
  expect(forwarded).toHaveLength(0);
  for (const [method, path] of [["GET", "/v1/runs/run-1"], ["POST", "/v1/runs/run-1/stop"], ["POST", "/p/bot-1/v1/runs/run-1/stop"]]) {
    expect((await app.request(`${origin}${path}`, { method, headers: { authorization: "Bearer test" } })).status).toBe(200);
  }
  expect(forwarded).toHaveLength(3);
});
