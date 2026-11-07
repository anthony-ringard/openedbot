import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { RelayDialError } from "@openedbot/hermes";
import {
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  RELAY_CLOSE_REVOKED,
  type RelayTextFrame,
} from "@openedbot/contracts-connector";
import type { ApiConfig } from "../src/infrastructure/config";
import { RuntimeLinkBroker, type LinkIdentity, type LinkLivenessStore } from "@openedbot/runtime-link/application/broker";
import {
  createRuntimeLinkLocator,
  instanceAwareDial,
  loopResponse,
  resolveLinkLocation,
  RUNTIME_LINK_INTERNAL_PREFIX,
  RUNTIME_LINK_RELAY_HOP_HEADER,
  RUNTIME_LINK_RELAY_STAGE_HEADER,
  unavailableResponse,
  type LinkLocation,
  type RuntimeLinkLocator,
} from "@openedbot/runtime-link/application/instances";
import {
  runtimeLinkInternalRoutes,
} from "../src/routes/runtimes/runtime-link-routes";
import type { Db } from "@openedbot/platform-db";

const TOKEN = "worker-secret";
const RUNTIME_ID = "5f0f8a3a-1111-4222-8333-444455556666";
const config = testInternalSecrets("api", TOKEN);

const silentLiveness: LinkLivenessStore = {
  connected: async () => {},
  seen: async () => {},
  disconnected: async () => {},
};

function identity(runtimeId: string): LinkIdentity {
  return { runtimeId, organizationId: "org-1", tokenHash: `hash-${runtimeId}`, expiresAt: null };
}

type HostSocket = {
  ws: WebSocket;
  frames: RelayTextFrame[];
  waitFrame(predicate: (frame: RelayTextFrame) => boolean, timeoutMs?: number): Promise<RelayTextFrame>;
};

type Replica = {
  broker: RuntimeLinkBroker;
  url: string;
  connect(runtimeId: string): Promise<HostSocket>;
  close(): void;
};

const replicas: Replica[] = [];

function startReplica(options: { instanceId: string; locator: RuntimeLinkLocator }): Replica {
  const broker = new RuntimeLinkBroker({
    instanceId: options.instanceId,
    liveness: silentLiveness,
    pingIntervalMs: 60_000,
    log: () => {},
  });
  const app = new Hono();
  app.route(RUNTIME_LINK_INTERNAL_PREFIX, runtimeLinkInternalRoutes(config, broker, options.locator));
  type SocketData = { runtimeId: string; connection: ReturnType<RuntimeLinkBroker["open"]> | null };
  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(request, bunServer) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const runtimeId = new URL(request.url).searchParams.get("runtime") ?? RUNTIME_ID;
        if (bunServer.upgrade(request, { data: { runtimeId, connection: null } })) return undefined;
        return new Response("no upgrade", { status: 400 });
      }
      return app.fetch(request);
    },
    websocket: {
      open(ws) {
        ws.data.connection = broker.open(ws);
      },
      message(ws, message) {
        const connection = ws.data.connection;
        if (!connection) return;
        if (typeof message === "string") {
          const frame = decodeTextFrame(message);
          if (frame.t === "hello") {
            connection.agent = frame.agent ?? null;
            connection.features = frame.features ?? [];
            broker.bind(connection, identity(ws.data.runtimeId));
            return;
          }
          connection.handleText(frame);
        } else connection.handleBinary(new Uint8Array(message));
      },
      close(ws, code, reason) {
        if (ws.data.connection) broker.release(ws.data.connection, code, reason);
      },
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const replica: Replica = {
    broker,
    url: origin,
    async connect(runtimeId) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?runtime=${runtimeId}`);
      ws.binaryType = "arraybuffer";
      const frames: RelayTextFrame[] = [];
      const waiters: Array<() => void> = [];
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") frames.push(decodeTextFrame(event.data));
        for (const wake of waiters.splice(0)) wake();
      });
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("connect failed")), { once: true });
      });
      ws.send(encodeTextFrame({ t: "hello", protocol: 1, agent: "edge-setup/test" }));
      const deadline = Date.now() + 2_000;
      while (!broker.connected(runtimeId)) {
        if (Date.now() > deadline) throw new Error("timeout waiting for bind");
        await Bun.sleep(5);
      }
      return {
        ws,
        frames,
        waitFrame: (predicate, timeoutMs = 2_000) => {
          const until = Date.now() + timeoutMs;
          return new Promise((resolve, reject) => {
            const tick = () => {
              const found = frames.find(predicate);
              if (found) return resolve(found);
              if (Date.now() > until) return reject(new Error("timeout waiting for frame"));
              waiters.push(tick);
              setTimeout(tick, 15);
            };
            tick();
          });
        },
      };
    },
    close() {
      broker.closeAll();
      server.stop(true);
    },
  };
  replicas.push(replica);
  return replica;
}

afterAll(() => {
  for (const replica of replicas) replica.close();
});

function stubLocator(locate: (runtimeId: string) => Promise<LinkLocation>, remoteUrl?: string): RuntimeLinkLocator {
  return {
    instanceId: "api-a",
    locate,
    async forwardProxy(runtimeId, request) {
      const location = await locate(runtimeId);
      if (location.kind !== "remote" && !remoteUrl) return unavailableResponse(location.kind === "unavailable" ? location.detail : "no_link");
      const url = location.kind === "remote" ? location.internalUrl : remoteUrl!;
      const incoming = new URL(request.url);
      const prefix = `${RUNTIME_LINK_INTERNAL_PREFIX}/${runtimeId}/proxy`;
      const path = incoming.pathname.startsWith(prefix)
        ? `${incoming.pathname.slice(prefix.length)}${incoming.search}`
        : incoming.pathname;
      const headers = new Headers();
      request.headers.forEach((value, name) => {
        if (name.toLowerCase() === "host" || name.toLowerCase() === RUNTIME_LINK_RELAY_HOP_HEADER.toLowerCase()) return;
        headers.set(name, value);
      });
      headers.set(RUNTIME_LINK_RELAY_HOP_HEADER, "1");
      return fetch(`${url}${RUNTIME_LINK_INTERNAL_PREFIX}/${runtimeId}/proxy${path}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
        redirect: "manual",
        ...(request.body ? { duplex: "half" as const } : {}),
      } as RequestInit);
    },
    forwardDial: async () => {
      throw new Error("forwardDial unused");
    },
    forwardRotate: async () => false,
    forwardClose: async () => false,
    forwardProbe: async () => ({ outcome: "no_link" }),
  };
}

function proxyRequest(origin: string, runtimeId: string, path: string, extra: HeadersInit = {}): Promise<Response> {
  return fetch(`${origin}${RUNTIME_LINK_INTERNAL_PREFIX}/${runtimeId}/proxy${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, ...extra },
  });
}

describe("relais inter-instances du lien connecteur", () => {
  test("lien monté sur B, requête entrée par A : forward et 200", async () => {
    const replicaB = startReplica({
      instanceId: "api-b",
      locator: stubLocator(async () => ({ kind: "local" })),
    });
    const host = await replicaB.connect(RUNTIME_ID);
    const replicaA = startReplica({
      instanceId: "api-a",
      locator: stubLocator(
        async () => ({ kind: "remote", instanceId: "api-b", internalUrl: replicaB.url }),
        replicaB.url,
      ),
    });
    const pending = proxyRequest(replicaA.url, RUNTIME_ID, "/health");
    const req = await host.waitFrame((frame) => frame.t === "req");
    expect(req.t === "req" && req.path).toBe("/health");
    const id = req.t === "req" ? req.id : 0;
    host.ws.send(encodeTextFrame({ t: "res", id, status: 200, headers: { "content-type": "application/json" } }));
    host.ws.send(encodeBinaryFrame(id, new TextEncoder().encode('{"ok":true}')));
    host.ws.send(encodeTextFrame({ t: "end", id }));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get(RUNTIME_LINK_RELAY_STAGE_HEADER)).toBeNull();
  });

  test("instance morte : 503 instance_dead, pas un faux disconnected", async () => {
    const replicaA = startReplica({
      instanceId: "api-a",
      locator: stubLocator(async () => ({ kind: "unavailable", detail: "instance_dead" })),
    });
    const response = await proxyRequest(replicaA.url, RUNTIME_ID, "/health");
    expect(response.status).toBe(503);
    expect(response.headers.get(RUNTIME_LINK_RELAY_STAGE_HEADER)).toBe("before_dispatch");
    const body = await response.json() as { error: { code: string; detail: string } };
    expect(body.error.code).toBe("RUNTIME_LINK_UNAVAILABLE");
    expect(body.error.detail).toBe("instance_dead");
  });

  test("boucle : hop déjà présent et lien pas local → 508", async () => {
    const replicaA = startReplica({
      instanceId: "api-a",
      locator: stubLocator(async () => ({ kind: "remote", instanceId: "api-b", internalUrl: "http://127.0.0.1:9" })),
    });
    const response = await proxyRequest(replicaA.url, RUNTIME_ID, "/health", { [RUNTIME_LINK_RELAY_HOP_HEADER]: "1" });
    expect(response.status).toBe(508);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("RUNTIME_LINK_LOOP");
  });

  test("no_link : 503 avec detail explicite", async () => {
    const replicaA = startReplica({
      instanceId: "api-a",
      locator: stubLocator(async () => ({ kind: "unavailable", detail: "no_link" })),
    });
    const response = await proxyRequest(replicaA.url, RUNTIME_ID, "/health");
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string; detail: string } };
    expect(body.error.code).toBe("RUNTIME_LINK_UNAVAILABLE");
    expect(body.error.detail).toBe("no_link");
  });

  // La révocation d'un runtime (DELETE) relaie sa fermeture quand la socket
  // n'est pas locale : toute la chaîne, du locator réel à la trame de
  // fermeture que l'hôte lit (4004 l'arrête, un autre code le fait réessayer).
  test("fermeture 4004 LINK_REVOKED relayée au propriétaire : l'hôte reçoit ce code et cette raison", async () => {
    const owner = startReplica({ instanceId: "api-b", locator: stubLocator(async () => ({ kind: "local" })) });
    const host = await owner.connect(RUNTIME_ID);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      host.ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
    });
    const db = (async () => [{ instanceId: "api-b", internalUrl: owner.url, instanceLive: true }]) as unknown as Db;
    const locator = createRuntimeLinkLocator(db, { instanceId: "api-a", apiInternalUrl: "http://api-a:8790", relay: testInternalSecrets("api", TOKEN)});
    expect(await locator.forwardClose(RUNTIME_ID, RELAY_CLOSE_REVOKED, "LINK_REVOKED")).toBe(true);
    expect(await closed).toEqual({ code: 4004, reason: "LINK_REVOKED" });
    expect(owner.broker.connected(RUNTIME_ID)).toBe(false);
  });
});

describe("resolveLinkLocation", () => {
  function fakeDb(rows: Array<Record<string, unknown>>): Db {
    return ((async () => rows) as unknown as Db);
  }

  test("court-circuit local si link_instance_id est cette instance", async () => {
    const location = await resolveLinkLocation(
      fakeDb([{ instanceId: "api-a", internalUrl: "http://127.0.0.1:8790", instanceLive: true }]),
      RUNTIME_ID,
      "api-a",
    );
    expect(location).toEqual({ kind: "local" });
  });

  test("renvoie l'URL interne d'une instance vivante ailleurs", async () => {
    const location = await resolveLinkLocation(
      fakeDb([{ instanceId: "api-b", internalUrl: "http://10.0.0.2:8790", instanceLive: true }]),
      RUNTIME_ID,
      "api-a",
    );
    expect(location).toEqual({ kind: "remote", instanceId: "api-b", internalUrl: "http://10.0.0.2:8790" });
  });

  test("instance morte ou absente → instance_dead ; pas de ligne → no_link", async () => {
    expect(await resolveLinkLocation(
      fakeDb([{ instanceId: "api-b", internalUrl: "http://10.0.0.2:8790", instanceLive: false }]),
      RUNTIME_ID,
      "api-a",
    )).toEqual({ kind: "unavailable", detail: "instance_dead" });
    expect(await resolveLinkLocation(fakeDb([]), RUNTIME_ID, "api-a")).toEqual({ kind: "unavailable", detail: "no_link" });
    expect(await resolveLinkLocation(
      fakeDb([{ instanceId: null, internalUrl: null, instanceLive: null }]),
      RUNTIME_ID,
      "api-a",
    )).toEqual({ kind: "unavailable", detail: "no_link" });
  });
});

describe("instanceAwareDial", () => {
  // Localiser le lien est une lecture en base avant tout envoi : son échec
  // est daté `before_dispatch`, pour qu'une route ne le prenne pas pour une
  // observation du runtime (le transport classe une erreur sans étape comme
  // survenue après envoi).
  test("un échec de localisation est une RelayDialError before_dispatch", async () => {
    const locator = {
      instanceId: "api-1",
      locate: async () => { throw new Error("postgres: connexion perdue"); },
    } as unknown as RuntimeLinkLocator;
    const dial = instanceAwareDial(() => async () => new Response(), () => false, locator, "rt-1");
    let caught: unknown;
    try {
      await dial({ method: "GET", path: "/v1/models", headers: {}, body: null } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RelayDialError);
    expect((caught as RelayDialError).stage).toBe("before_dispatch");
    expect((caught as RelayDialError).code).toBe("RUNTIME_LINK_LOCATE_FAILED");
  });
});

describe("réponses d'échec du relais", () => {
  test("unavailableResponse porte le detail et l'étape", async () => {
    const response = unavailableResponse("instance_dead");
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { detail: string; stage: string } };
    expect(body.error.detail).toBe("instance_dead");
    expect(body.error.stage).toBe("before_dispatch");
  });

  test("loopResponse est un 508", async () => {
    const response = loopResponse();
    expect(response.status).toBe(508);
  });
});
