import { afterAll, describe, expect, test } from "bun:test";
import { RelayDialError, createRelayTransport, HermesClient } from "@openedbot/hermes";
import {
  decodeBinaryFrame,
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  RELAY_CLOSE_RECONNECT,
  RELAY_CLOSE_REPLACED,
  RELAY_CLOSE_UNAUTHORIZED,
  type RelayTextFrame,
} from "@openedbot/contracts-connector";
import {
  describeLinkClosure,
  LinkConnection,
  pgTextArray,
  RuntimeLinkBroker,
  type LinkEventKind,
  type LinkEventMeta,
  type LinkIdentity,
  type LinkLivenessStore,
} from "../src/application/broker";

/**
 * Le broker face à un hôte réel : un Bun.serve éphémère monte chaque
 * connexion, la lie à un runtime, et le client du test parle le protocole de
 * fil de `docs/CONNECTOR.md` (trames texte JSON, corps `[u32 id][bytes]`).
 */

type LivenessLog = Array<{ write: "connected" | "seen" | "disconnected" | "capabilities" | "toolsets_written" | "capabilities_written"; runtimeId: string; features?: string[]; reason?: string; profile?: string | null }>;
type EventLog = Array<{ runtimeId: string; kind: LinkEventKind; meta: LinkEventMeta }>;

function recordingLiveness(log: LivenessLog, events?: EventLog): LinkLivenessStore {
  return {
    async connected(link, _instanceId, features) {
      log.push({ write: "connected", runtimeId: link.runtimeId, features });
    },
    async capabilities(link, _instanceId, features) {
      log.push({ write: "capabilities", runtimeId: link.runtimeId, features });
    },
    async seen(link) {
      log.push({ write: "seen", runtimeId: link.runtimeId });
    },
    async disconnected(link, _instanceId, reason) {
      log.push({ write: "disconnected", runtimeId: link.runtimeId, reason });
    },
    async toolsetsWritten(link) {
      log.push({ write: "toolsets_written", runtimeId: link.runtimeId });
    },
    async capabilitiesWritten(link, profile) {
      log.push({ write: "capabilities_written", runtimeId: link.runtimeId, profile });
    },
    ...(events
      ? {
          async event(link, kind, meta) {
            events.push({ runtimeId: link.runtimeId, kind, meta });
          },
        }
      : {}),
  };
}

function identity(runtimeId: string): LinkIdentity {
  return { runtimeId, organizationId: "org-1", tokenHash: `hash-${runtimeId}`, expiresAt: null };
}

type HostSocket = {
  ws: WebSocket;
  frames: RelayTextFrame[];
  /** Résolue à chaque nouvelle trame texte ; les tests attendent dessus. */
  waitFrame(predicate: (frame: RelayTextFrame) => boolean, timeoutMs?: number): Promise<RelayTextFrame>;
  waitClose(timeoutMs?: number): Promise<{ code: number }>;
  binary: Array<{ id: number; chunk: Uint8Array }>;
};

type Harness = {
  broker: RuntimeLinkBroker;
  liveness: LivenessLog;
  url: string;
  /** Ouvre un WebSocket et dit `hello`, avec les capacités données s'il y en a. */
  connect(runtimeId: string, features?: string[]): Promise<HostSocket>;
  close(): void;
};

const harnesses: Harness[] = [];

function startHarness(options: { firstResponseTimeoutMs?: number; now?: () => number; seenDebounceMs?: number } = {}): Harness {
  const liveness: LivenessLog = [];
  const broker = new RuntimeLinkBroker({
    instanceId: "api-test",
    liveness: recordingLiveness(liveness),
    pingIntervalMs: 60_000,
    firstResponseTimeoutMs: options.firstResponseTimeoutMs ?? 60_000,
    seenDebounceMs: options.seenDebounceMs,
    now: options.now,
    log: () => {},
  });
  type SocketData = { runtimeId: string; connection: LinkConnection | null };
  const server = Bun.serve<SocketData, string>({
    port: 0,
    fetch(request, bunServer) {
      const runtimeId = new URL(request.url).searchParams.get("runtime") ?? "rt-1";
      if (bunServer.upgrade(request, { data: { runtimeId, connection: null } })) return undefined;
      return new Response("no upgrade", { status: 400 });
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
          // Comme la passerelle : `hello` en premier, ses capacités telles
          // quelles, puis la liaison au registre.
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
  const url = `ws://127.0.0.1:${server.port}`;
  const harness: Harness = {
    broker,
    liveness,
    url,
    async connect(runtimeId, features) {
      const ws = new WebSocket(`${url}/?runtime=${runtimeId}`);
      ws.binaryType = "arraybuffer";
      const frames: RelayTextFrame[] = [];
      const binary: Array<{ id: number; chunk: Uint8Array }> = [];
      const waiters: Array<() => void> = [];
      let closed: { code: number } | null = null;
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") frames.push(decodeTextFrame(event.data));
        else binary.push(decodeBinaryFrame(new Uint8Array(event.data as ArrayBuffer)));
        for (const wake of waiters.splice(0)) wake();
      });
      ws.addEventListener("close", (event) => {
        closed = { code: event.code };
        for (const wake of waiters.splice(0)) wake();
      });
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("connect failed")), { once: true });
      });
      // `hello` d'abord, comme un vrai hôte ; la liaison est acquise quand le
      // liveness store a reçu son `connected` (écrit synchroniquement au bind).
      const connectedBefore = liveness.filter((entry) => entry.write === "connected").length;
      ws.send(encodeTextFrame({
        t: "hello",
        protocol: 1,
        agent: "edge-setup/test",
        ...(features ? { features } : {}),
      }));
      const bindDeadline = Date.now() + 2_000;
      while (liveness.filter((entry) => entry.write === "connected").length === connectedBefore) {
        if (Date.now() > bindDeadline) throw new Error("timeout waiting for bind");
        await Bun.sleep(5);
      }
      const waitFor = async <T>(read: () => T | null, timeoutMs: number, label: string): Promise<T> => {
        const deadline = Date.now() + timeoutMs;
        while (true) {
          const value = read();
          if (value !== null) return value;
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
            setTimeout(resolve, 25);
          });
        }
      };
      return {
        ws,
        frames,
        binary,
        waitFrame: (predicate, timeoutMs = 2_000) =>
          waitFor(() => frames.find(predicate) ?? null, timeoutMs, "frame"),
        waitClose: (timeoutMs = 2_000) => waitFor(() => closed, timeoutMs, "close"),
      };
    },
    close() {
      broker.closeAll();
      server.stop(true);
    },
  };
  harnesses.push(harness);
  return harness;
}

afterAll(() => {
  for (const harness of harnesses) harness.close();
});

function send(host: HostSocket, frame: RelayTextFrame): void {
  host.ws.send(encodeTextFrame(frame));
}

async function answer(host: HostSocket, id: number, body: string, status = 200): Promise<void> {
  send(host, { t: "res", id, status, headers: { "content-type": "application/json" } });
  host.ws.send(encodeBinaryFrame(id, new TextEncoder().encode(body)));
  send(host, { t: "end", id });
}

describe("runtime link broker : multiplexage", () => {
  test("trois requêtes en vol, répondues dans le désordre, retrouvent chacune leur corps", async () => {
    const harness = startHarness();
    const host = await harness.connect("rt-multi");
    const dial = harness.broker.dialer("rt-multi");
    const first = dial({ method: "GET", path: "/health", headers: {}, body: null });
    const second = dial({ method: "GET", path: "/v1/capabilities", headers: {}, body: null });
    const third = dial({ method: "GET", path: "/v1/models", headers: {}, body: null });
    await host.waitFrame((frame) => frame.t === "req" && frame.path === "/v1/models");
    const requests = host.frames.filter((frame) => frame.t === "req");
    expect(requests.map((frame) => frame.id)).toEqual([1, 2, 3]);
    // Réponses dans le désordre : le multiplexage ne mélange rien.
    await answer(host, 3, '{"which":"models"}');
    await answer(host, 1, '{"which":"health"}');
    await answer(host, 2, '{"which":"capabilities"}');
    expect(await (await first).json()).toEqual({ which: "health" });
    expect(await (await second).json()).toEqual({ which: "capabilities" });
    expect(await (await third).json()).toEqual({ which: "models" });
  });

  test("un chemin hors allowlist ne part jamais dans le tuyau", async () => {
    const harness = startHarness();
    const host = await harness.connect("rt-allow");
    const error = await harness.broker.dialer("rt-allow")({ method: "POST", path: "/admin/exec", headers: {}, body: null })
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayDialError);
    expect((error as RelayDialError).code).toBe("HERMES_LINK_PATH_FORBIDDEN");
    expect((error as RelayDialError).stage).toBe("before_dispatch");
    await Bun.sleep(50);
    expect(host.frames.filter((frame) => frame.t === "req")).toHaveLength(0);
  });

  test("a relayed inventory write bumps the toolset epoch once the host answered, a read does not", async () => {
    const harness = startHarness();
    const host = await harness.connect("rt-epoch");
    const dial = harness.broker.dialer("rt-epoch");
    const bumps = () => harness.liveness.filter((entry) => entry.write === "toolsets_written");
    const read = dial({ method: "GET", path: "/v1/toolsets", headers: {}, body: null });
    await host.waitFrame((frame) => frame.t === "req" && frame.path === "/v1/toolsets");
    await answer(host, 1, '{"data":[]}');
    await read;
    expect(bumps()).toHaveLength(0);

    const write = dial({ method: "POST", path: "/p/nova/hermes-setup/profiles/nova/toolsets/web", headers: {}, body: null });
    await host.waitFrame((frame) => frame.t === "req" && frame.id === 2);
    await Bun.sleep(20);
    expect(bumps()).toHaveLength(0);
    await answer(host, 2, '{"enabled":true}');
    await write;
    expect(bumps()).toEqual([{ write: "toolsets_written", runtimeId: "rt-epoch" }]);
  });

  test("a relayed skill switch marks its profile once the host answered, before the caller sees the answer (0163)", async () => {
    const harness = startHarness();
    const host = await harness.connect("rt-capabilities");
    const dial = harness.broker.dialer("rt-capabilities");
    const marks = () => harness.liveness.filter((entry) => entry.write === "capabilities_written");
    const write = dial({ method: "POST", path: "/p/nova/hermes-setup/profiles/nova/skills/claude-code", headers: {}, body: null });
    await host.waitFrame((frame) => frame.t === "req" && frame.id === 1);
    await Bun.sleep(20);
    expect(marks()).toHaveLength(0);
    await answer(host, 1, '{"enabled":false}');
    await write;
    expect(marks()).toEqual([{ write: "capabilities_written", runtimeId: "rt-capabilities", profile: "nova" }]);
    // A skill is not a toolset: the worker's toolset cache is left alone.
    expect(harness.liveness.filter((entry) => entry.write === "toolsets_written")).toHaveLength(0);
  });
});

describe("runtime link broker : annulation et délais", () => {
  test("un abort envoie cancel à l'hôte et rejette la requête", async () => {
    const harness = startHarness();
    const host = await harness.connect("rt-cancel");
    const controller = new AbortController();
    // Handler attaché immédiatement : un rejet sans consommateur est compté
    // comme échec de test par Bun.
    const outcome = harness.broker.dialer("rt-cancel")(
      { method: "GET", path: "/health", headers: {}, body: null },
      controller.signal,
    ).then(() => null, (caught: unknown) => caught);
    await host.waitFrame((frame) => frame.t === "req");
    controller.abort("test");
    const cancel = await host.waitFrame((frame) => frame.t === "cancel");
    expect(cancel.t === "cancel" && cancel.id).toBe(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(RelayDialError);
    expect((error as RelayDialError).stage).toBe("after_dispatch");
  });

  test("sans premier res dans le délai, la requête échoue after_dispatch et l'hôte reçoit cancel", async () => {
    const harness = startHarness({ firstResponseTimeoutMs: 150 });
    const host = await harness.connect("rt-timeout");
    const pending = harness.broker.dialer("rt-timeout")({ method: "GET", path: "/health", headers: {}, body: null });
    const error = await pending.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayDialError);
    expect((error as RelayDialError).code).toBe("LINK_TIMEOUT");
    expect((error as RelayDialError).stage).toBe("after_dispatch");
    await host.waitFrame((frame) => frame.t === "cancel");
  });
});

describe("runtime link broker : remplacement et vitalité", () => {
  test("la connexion la plus récente gagne : 4001 pour l'ancienne, err after_dispatch pour ses requêtes", async () => {
    const harness = startHarness();
    const first = await harness.connect("rt-replace");
    const inFlight = harness.broker.dialer("rt-replace")({ method: "GET", path: "/health", headers: {}, body: null })
      .then(() => null, (caught: unknown) => caught);
    await first.waitFrame((frame) => frame.t === "req");
    const second = await harness.connect("rt-replace");
    const closedFirst = await first.waitClose();
    expect(closedFirst.code).toBe(RELAY_CLOSE_REPLACED);
    const error = await inFlight;
    expect(error).toBeInstanceOf(RelayDialError);
    expect((error as RelayDialError).stage).toBe("after_dispatch");
    // La nouvelle connexion sert le runtime.
    const answered = harness.broker.dialer("rt-replace")({ method: "GET", path: "/health", headers: {}, body: null });
    const request = await second.waitFrame((frame) => frame.t === "req");
    await answer(second, request.t === "req" ? request.id : 0, '{"ok":true}');
    expect((await answered).status).toBe(200);
    // L'ancienne fermeture n'écrase pas la vitalité de la remplaçante.
    await Bun.sleep(50);
    expect(harness.liveness.filter((entry) => entry.write === "disconnected")).toHaveLength(0);
  });

  test("la fermeture du lien courant écrit disconnected", async () => {
    const harness = startHarness();
    const host = await harness.connect("rt-close");
    host.ws.close(1000, "bye");
    await host.waitClose();
    await Bun.sleep(50);
    expect(harness.liveness).toEqual([
      { write: "connected", runtimeId: "rt-close", features: [] },
      { write: "disconnected", runtimeId: "rt-close", reason: "L’hôte a fermé le lien (code 1000)." },
    ]);
    expect(harness.broker.connected("rt-close")).toBe(false);
  });

  test("le bye d'enrôlement n'écrit pas disconnected", async () => {
    const harness = startHarness();
    const host = await harness.connect("rt-enroll");
    const connection = harness.broker.connection("rt-enroll");
    expect(connection).not.toBeNull();
    connection!.expectEnrollmentBye = true;
    host.ws.close(1000, "bye");
    await host.waitClose();
    await Bun.sleep(50);
    expect(harness.liveness.filter((entry) => entry.write === "disconnected")).toHaveLength(0);
    expect(harness.broker.connected("rt-enroll")).toBe(false);
  });

  // La raison écrite dans `last_health_error` nomme une fermeture d'openedbot ;
  // une fermeture de l'hôte ne reprend que le code, jamais son texte libre.
  test("describeLinkClosure nomme les fermetures d'openedbot et ne reprend que le code de l'hôte", () => {
    expect(describeLinkClosure(RELAY_CLOSE_REPLACED, "LINK_REPLACED")).toBe("Le lien a été remplacé par une nouvelle instance de l’hôte.");
    expect(describeLinkClosure(RELAY_CLOSE_UNAUTHORIZED, "LINK_ROTATED")).toBe("Le jeton du lien a été tourné ; l’hôte doit se reconnecter.");
    expect(describeLinkClosure(1001, "GATEWAY_SHUTDOWN")).toBe("openedbot a redémarré ; l’hôte ne s’est pas reconnecté depuis.");
    expect(describeLinkClosure(1006, "")).toBe("Le lien s’est interrompu sans trame de fermeture (code 1006).");
    expect(describeLinkClosure(1001, "/var/lib/hermes/panic.log")).toBe("L’hôte a fermé le lien (code 1001).");
    // Une raison qui est un nom de propriété héritée ne rend jamais autre chose qu'une phrase.
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      expect(describeLinkClosure(1000, inherited)).toBe("L’hôte a fermé le lien (code 1000).");
    }
  });

  // Les capacités de l'hôte ne sont jamais supposées : elles arrivent en base
  // telles que `hello` les a dites, et un hôte muet n'en a aucune.
  test("les capacités annoncées dans hello arrivent au liveness store à connected", async () => {
    const harness = startHarness();
    await harness.connect("rt-features", ["provider_management"]);
    expect(harness.liveness).toEqual([
      { write: "connected", runtimeId: "rt-features", features: ["provider_management"] },
    ]);
    await harness.connect("rt-bare");
    expect(harness.liveness.find((entry) => entry.runtimeId === "rt-bare")).toEqual({
      write: "connected",
      runtimeId: "rt-bare",
      features: [],
    });
  });

  test("capabilities refresh the same socket while an inference response is in flight", async () => {
    const harness = startHarness();
    const host = await harness.connect("rt-recovery");
    const pending = harness.broker.dialer("rt-recovery")({ method: "POST", path: "/v1/runs", headers: {}, body: null });
    const request = await host.waitFrame((frame) => frame.t === "req");
    host.ws.send(encodeTextFrame({ t: "capabilities", features: ["provider_management"] }));
    host.ws.send(encodeTextFrame({ t: "ping" }));
    await host.waitFrame((frame) => frame.t === "pong");
    await answer(host, request.t === "req" ? request.id : 0, '{"run_id":"running"}');
    expect(await (await pending).json()).toEqual({ run_id: "running" });
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    expect(harness.liveness).toEqual([
      { write: "connected", runtimeId: "rt-recovery", features: [] },
      { write: "capabilities", runtimeId: "rt-recovery", features: ["provider_management"] },
    ]);
  });

  test("provisional capabilities survive binding and old queued updates cannot overwrite a replacement", async () => {
    const log: LivenessLog = [];
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const liveness = recordingLiveness(log);
    const originalConnected = liveness.connected;
    liveness.connected = async (...args) => { await gate; await originalConnected(...args); };
    const broker = new RuntimeLinkBroker({ instanceId: "api-test", liveness, log: () => {} });
    const first = broker.open({ send: () => 1, close() {} });
    first.handleText({ t: "capabilities", features: ["provider_management"] });
    broker.bind(first, identity("rt-order"));
    first.handleText({ t: "capabilities", features: ["provider_usage"] });
    const replacement = broker.open({ send: () => 1, close() {} });
    replacement.features = ["profile_inventory"];
    broker.bind(replacement, identity("rt-order"));
    first.handleText({ t: "capabilities", features: ["stale"] });
    releaseWrite();
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(log).toEqual([
      { write: "connected", runtimeId: "rt-order", features: ["provider_management"] },
      { write: "connected", runtimeId: "rt-order", features: ["profile_inventory"] },
    ]);
    broker.closeAll();
  });

  test("capabilities replace the operator features and keep the link features of hello", async () => {
    const log: LivenessLog = [];
    const broker = new RuntimeLinkBroker({ instanceId: "api-test", liveness: recordingLiveness(log), log: () => {} });
    const connection = broker.open({ send: () => 1, close() {} });
    connection.features = ["creation_audit_v2", "provider_management"];
    broker.bind(connection, identity("rt-link-features"));
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    connection.handleText({ t: "capabilities", features: ["provider_management", "auto_upgrade"] });
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    connection.handleText({ t: "capabilities", features: ["provider_management"] });
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(log.map((entry) => entry.features)).toEqual([
      ["creation_audit_v2", "provider_management"],
      ["creation_audit_v2", "provider_management", "auto_upgrade"],
      ["creation_audit_v2", "provider_management"],
    ]);
    broker.closeAll();
  });

  test("a stalled capability write coalesces a flood into the latest inventory", async () => {
    const log: LivenessLog = [];
    const liveness = recordingLiveness(log);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    liveness.capabilities = async (link, _instanceId, features) => {
      writes++;
      if (writes === 1) await gate;
      log.push({ write: "capabilities", runtimeId: link.runtimeId, features });
    };
    const broker = new RuntimeLinkBroker({ instanceId: "api-test", liveness, log: () => {} });
    const connection = broker.open({ send: () => 1, close() {} });
    broker.bind(connection, identity("rt-flood"));
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    connection.handleText({ t: "capabilities", features: ["first"] });
    for (let index = 0; index < 1_000; index++) {
      connection.handleText({ t: "capabilities", features: [`feature_${index}`] });
    }
    expect(writes).toBe(1);
    release();
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(log.filter((entry) => entry.write === "capabilities").map((entry) => entry.features))
      .toEqual([["first"], ["feature_999"]]);
    expect(broker.connected("rt-flood")).toBe(true);
    broker.closeAll();
  });

  test("inventory.changed is recorded, then hands the runtime to the application for a background read", async () => {
    const log: LivenessLog = [];
    const liveness = recordingLiveness(log);
    const marked: string[] = [];
    liveness.inventoryChanged = async (link) => { marked.push(link.runtimeId); return true; };
    const warmed: string[] = [];
    const broker = new RuntimeLinkBroker({ instanceId: "api-test", liveness, log: () => {}, onInventoryChanged: (link) => warmed.push(link.runtimeId) });
    const connection = broker.open({ send: () => 1, close() {} });
    broker.bind(connection, identity("rt-inventory"));
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    connection.handleText({ t: "inventory.changed" });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(marked).toEqual(["rt-inventory"]);
    expect(warmed).toEqual(["rt-inventory"]);
    broker.closeAll();
  });

  test("a flood of inventory.changed during a stalled write costs one more write, never one per frame", async () => {
    const liveness = recordingLiveness([]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    liveness.inventoryChanged = async () => {
      writes++;
      if (writes === 1) await gate;
      return true;
    };
    const warmed: string[] = [];
    const broker = new RuntimeLinkBroker({ instanceId: "api-test", liveness, log: () => {}, onInventoryChanged: (link) => warmed.push(link.runtimeId) });
    const connection = broker.open({ send: () => 1, close() {} });
    broker.bind(connection, identity("rt-chatty"));
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    for (let index = 0; index < 500; index++) connection.handleText({ t: "inventory.changed" });
    expect(writes).toBe(1);
    release();
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(writes).toBe(2);
    expect(warmed).toEqual(["rt-chatty", "rt-chatty"]);
    broker.closeAll();
  });

  test("a revoked runtime's inventory.changed marks nothing and starts no read; a failed write is logged, not thrown", async () => {
    const liveness = recordingLiveness([]);
    let fail = false;
    liveness.inventoryChanged = async () => {
      if (fail) throw new Error("database down");
      return false;
    };
    const warmed: string[] = [];
    const logged: string[] = [];
    const broker = new RuntimeLinkBroker({
      instanceId: "api-test",
      liveness,
      log: (event) => logged.push(event),
      onInventoryChanged: (link) => warmed.push(link.runtimeId),
    });
    const connection = broker.open({ send: () => 1, close() {} });
    broker.bind(connection, identity("rt-gone"));
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    connection.handleText({ t: "inventory.changed" });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    fail = true;
    connection.handleText({ t: "inventory.changed" });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(warmed).toEqual([]);
    expect(logged).toContain("runtime_link.inventory_changed_failed");
    expect(broker.connected("rt-gone")).toBe(true);
    broker.closeAll();
  });

  test("a successful heartbeat retries the latest capabilities after a transient database failure", async () => {
    const log: LivenessLog = [];
    const liveness = recordingLiveness(log);
    let attempts = 0;
    liveness.capabilities = async (link, _instanceId, features) => {
      if (++attempts === 1) throw new Error("temporary database failure");
      log.push({ write: "capabilities", runtimeId: link.runtimeId, features });
    };
    const broker = new RuntimeLinkBroker({ instanceId: "api-test", liveness, seenDebounceMs: 0, log: () => {} });
    const connection = broker.open({ send: () => 1, close() {} });
    broker.bind(connection, identity("rt-retry"));
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    connection.handleText({ t: "capabilities", features: ["provider_management"] });
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(attempts).toBe(1);
    connection.handleText({ t: "pong" });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(attempts).toBe(2);
    expect(log.filter((entry) => entry.write === "capabilities")).toEqual([
      { write: "capabilities", runtimeId: "rt-retry", features: ["provider_management"] },
    ]);
    expect(log.filter((entry) => entry.write === "connected")).toHaveLength(1);
    expect(broker.connected("rt-retry")).toBe(true);
    broker.closeAll();
  });

  test("link_last_seen_at est écrit au plus une fois par fenêtre de debounce", () => {
    let nowMs = 1_000_000;
    const liveness: LivenessLog = [];
    const broker = new RuntimeLinkBroker({
      instanceId: "api-test",
      liveness: recordingLiveness(liveness),
      now: () => nowMs,
      seenDebounceMs: 10_000,
      pingIntervalMs: 3_600_000,
      log: () => {},
    });
    const connection = broker.open({ send: () => 1, close() {} });
    broker.bind(connection, identity("rt-seen"));
    // Trois pongs dans la fenêtre : aucune écriture (bind vient d'écrire).
    connection.handleText({ t: "pong" });
    connection.handleText({ t: "pong" });
    connection.handleText({ t: "pong" });
    expect(liveness.filter((entry) => entry.write === "seen")).toHaveLength(0);
    nowMs += 10_001;
    connection.handleText({ t: "pong" });
    connection.handleText({ t: "pong" });
    expect(liveness.filter((entry) => entry.write === "seen")).toHaveLength(1);
    nowMs += 10_001;
    connection.handleText({ t: "pong" });
    expect(liveness.filter((entry) => entry.write === "seen")).toHaveLength(2);
  });
});

/**
 * Journal du lien (0027) : `connected` / `replaced` / `disconnected`, et la
 * règle hijack : remplacement depuis une autre adresse, ou trois en dix
 * minutes. Sockets factices : ce qui compte est l'adresse posée au `bind`.
 */
describe("runtime link broker : journal du lien et règle hijack", () => {
  function brokerWithEvents(now?: () => number): { broker: RuntimeLinkBroker; events: EventLog } {
    const events: EventLog = [];
    const broker = new RuntimeLinkBroker({
      instanceId: "api-test",
      liveness: recordingLiveness([], events),
      pingIntervalMs: 3_600_000,
      now,
      log: () => {},
    });
    return { broker, events };
  }
  const socket = () => ({ send: () => 1, close() {} });

  test("un remplacement depuis une autre adresse écrit replaced puis hijack_suspected, avec previous_ip", async () => {
    const { broker, events } = brokerWithEvents();
    const first = broker.open(socket());
    broker.bind(first, identity("rt-hijack"), { ip: "203.0.113.9", agent: "hermes-setup/1.2.0" });
    const second = broker.open(socket());
    broker.bind(second, identity("rt-hijack"), { ip: "198.51.100.7", agent: "hermes-setup/1.2.0" });
    await Bun.sleep(0);
    expect(first.isClosed).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(["connected", "replaced", "hijack_suspected"]);
    expect(events[1]!.meta).toEqual({ ip: "198.51.100.7", agent: "hermes-setup/1.2.0", previousIp: "203.0.113.9", instanceId: "api-test", generation: null });
    expect(events[2]!.meta.previousIp).toBe("203.0.113.9");
  });

  test("un remplacement depuis la même adresse n'est pas suspect… jusqu'au troisième en dix minutes", async () => {
    let nowMs = 1_000_000;
    const { broker, events } = brokerWithEvents(() => nowMs);
    const peer = { ip: "203.0.113.9", agent: null };
    broker.bind(broker.open(socket()), identity("rt-flap"), peer);
    nowMs += 60_000;
    broker.bind(broker.open(socket()), identity("rt-flap"), peer);
    nowMs += 60_000;
    broker.bind(broker.open(socket()), identity("rt-flap"), peer);
    await Bun.sleep(0);
    expect(events.map((event) => event.kind)).toEqual(["connected", "replaced", "replaced"]);
    nowMs += 60_000;
    broker.bind(broker.open(socket()), identity("rt-flap"), peer);
    await Bun.sleep(0);
    expect(events.map((event) => event.kind)).toEqual(["connected", "replaced", "replaced", "replaced", "hijack_suspected"]);
    // Onze minutes plus tard, la fenêtre s'est vidée : un remplacement isolé redevient ordinaire.
    nowMs += 11 * 60_000;
    broker.bind(broker.open(socket()), identity("rt-flap"), peer);
    await Bun.sleep(0);
    expect(events.at(-1)!.kind).toBe("replaced");
  });

  test("séquence mixte A→B, B→B, B→B : le premier remplacement inter-adresses compte dans la fenêtre", async () => {
    let nowMs = 1_000_000;
    const { broker, events } = brokerWithEvents(() => nowMs);
    const a = { ip: "203.0.113.9", agent: null };
    const b = { ip: "198.51.100.7", agent: null };
    broker.bind(broker.open(socket()), identity("rt-mixed"), a);
    nowMs += 60_000;
    broker.bind(broker.open(socket()), identity("rt-mixed"), b);
    nowMs += 60_000;
    broker.bind(broker.open(socket()), identity("rt-mixed"), b);
    nowMs += 60_000;
    broker.bind(broker.open(socket()), identity("rt-mixed"), b);
    await Bun.sleep(0);
    expect(events.map((event) => event.kind)).toEqual([
      "connected",
      "replaced", "hijack_suspected", // A→B : adresse différente
      "replaced", // B→B : deuxième dans la fenêtre, pas encore trois
      "replaced", "hijack_suspected", // B→B : troisième en dix minutes
    ]);
  });

  test("une connexion montée avec l'ancien jeton se ferme 4401 LINK_TOKEN_EXPIRED à la fin de la grâce", async () => {
    let nowMs = 1_000_000;
    const { broker, events } = brokerWithEvents(() => nowMs);
    const closed: { last: { code: number; reason: string } | null } = { last: null };
    const connection = broker.open({ send: () => 1, close: (code, reason) => { closed.last = { code: code ?? 0, reason: reason ?? "" }; } });
    // Grâce : 40 ms de temps réel (le délai est calculé depuis `now` injecté).
    broker.bind(connection, { ...identity("rt-grace"), expiresAt: nowMs + 40 });
    expect(broker.connected("rt-grace")).toBe(true);
    await Bun.sleep(10);
    expect(connection.isClosed).toBe(false);
    await Bun.sleep(60);
    expect(connection.isClosed).toBe(true);
    expect(closed.last).toEqual({ code: RELAY_CLOSE_UNAUTHORIZED, reason: "LINK_TOKEN_EXPIRED" });
    expect(broker.connected("rt-grace")).toBe(false);
    // Le jeton courant, lui, ne porte aucun timer.
    const current = broker.open({ send: () => 1, close() {} });
    broker.bind(current, identity("rt-current"));
    await Bun.sleep(60);
    expect(current.isClosed).toBe(false);
    void events;
  });

  test("closeLink ferme le lien ouvert avec le code demandé, et rend false sinon", () => {
    const { broker } = brokerWithEvents();
    const closed: { last: { code: number; reason: string } | null } = { last: null };
    const connection = broker.open({ send: () => 1, close: (code, reason) => { closed.last = { code: code ?? 0, reason: reason ?? "" }; } });
    broker.bind(connection, identity("rt-close-link"));
    expect(broker.closeLink("rt-close-link", RELAY_CLOSE_UNAUTHORIZED, "LINK_ROTATED")).toBe(true);
    expect(closed.last).toEqual({ code: RELAY_CLOSE_UNAUTHORIZED, reason: "LINK_ROTATED" });
    expect(broker.connected("rt-close-link")).toBe(false);
    expect(broker.closeLink("rt-absent", RELAY_CLOSE_UNAUTHORIZED, "LINK_ROTATED")).toBe(false);
  });

  test("la fermeture du lien courant écrit disconnected avec l'adresse, et le store sans event n'est jamais appelé", async () => {
    const { broker, events } = brokerWithEvents();
    const connection = broker.open(socket());
    broker.bind(connection, identity("rt-bye"), { ip: "203.0.113.9", agent: null });
    broker.release(connection, 1000, "bye");
    await Bun.sleep(0);
    expect(events.map((event) => event.kind)).toEqual(["connected", "disconnected"]);
    expect(events[1]!.meta.ip).toBe("203.0.113.9");
    const silent = new RuntimeLinkBroker({ instanceId: "api-test", liveness: recordingLiveness([]), pingIntervalMs: 3_600_000, log: () => {} });
    const other = silent.open(socket());
    silent.bind(other, identity("rt-silent"));
    silent.release(other, 1000, "bye");
  });

  test("notifyRotation pousse link.rotate sur le lien ouvert, et rend false sinon", () => {
    const { broker } = brokerWithEvents();
    const sent: string[] = [];
    const connection = broker.open({ send: (data) => { sent.push(String(data)); return 1; }, close() {} });
    broker.bind(connection, identity("rt-rotate"));
    expect(broker.notifyRotation("rt-rotate", { t: "link.rotate", runtimeId: "rt-rotate", linkToken: "new-token" })).toBe(true);
    expect(decodeTextFrame(sent.at(-1)!)).toEqual({ t: "link.rotate", runtimeId: "rt-rotate", linkToken: "new-token" });
    expect(broker.notifyRotation("rt-absent", { t: "link.rotate", runtimeId: "rt-absent", linkToken: "x" })).toBe(false);
  });
});

describe("runtime link broker : sonde du lien (Vérifier le lien)", () => {
  function probingBroker(): RuntimeLinkBroker {
    return new RuntimeLinkBroker({ instanceId: "api-test", liveness: recordingLiveness([]), pingIntervalMs: 3_600_000, log: () => {} });
  }
  type PingSocket = { pings: string[]; closed: { code: number; reason: string } | null; send(): number; close(code?: number, reason?: string): void; ping(data?: string | Uint8Array): number };
  function pingSocket(): PingSocket {
    const socket: PingSocket = {
      pings: [],
      closed: null,
      send: () => 1,
      close: (code, reason) => { socket.closed = { code: code ?? 0, reason: reason ?? "" }; },
      ping: (data) => { socket.pings.push(String(data)); return 1; },
    };
    return socket;
  }

  test("le pong qui rend le nonce prouve le lien et mesure la latence", async () => {
    const broker = probingBroker();
    const socket = pingSocket();
    const connection = broker.open(socket);
    broker.bind(connection, identity("rt-probe-alive"));
    const probe = broker.probeLink("rt-probe-alive", null, 1_000);
    expect(socket.pings).toHaveLength(1);
    connection.handlePong(new Uint8Array(0));
    connection.handlePong(new TextEncoder().encode(socket.pings[0]!));
    const result = await probe;
    expect(result.outcome).toBe("alive");
    expect(result.outcome === "alive" && typeof result.rttMs).toBe("number");
    expect(socket.closed).toBeNull();
  });

  test("aucun pong ni trame : la connexion sondée est raccrochée 4005 et le lien n'est plus ouvert", async () => {
    const broker = probingBroker();
    const socket = pingSocket();
    const connection = broker.open(socket);
    broker.bind(connection, identity("rt-probe-dead"));
    expect(await broker.probeLink("rt-probe-dead", null, 30)).toEqual({ outcome: "reconnect_requested", generation: null });
    expect(socket.closed).toEqual({ code: RELAY_CLOSE_RECONNECT, reason: "LINK_RECONNECT_REQUESTED" });
    expect(broker.connected("rt-probe-dead")).toBe(false);
    expect(describeLinkClosure(RELAY_CLOSE_RECONNECT, "LINK_RECONNECT_REQUESTED")).toBe("Le lien ne répondait plus au ping ; openedbot l’a fermé pour que l’hôte se reconnecte.");
  });

  test("une trame reçue sans pong : lien occupé mais vivant, rien n'est fermé", async () => {
    const broker = probingBroker();
    const socket = pingSocket();
    const connection = broker.open(socket);
    broker.bind(connection, identity("rt-probe-busy"));
    const probe = broker.probeLink("rt-probe-busy", null, 40);
    await Bun.sleep(5);
    connection.handleText({ t: "pong" });
    expect(await probe).toEqual({ outcome: "alive", generation: null, rttMs: null });
    expect(socket.closed).toBeNull();
  });

  test("remplacée pendant la sonde : la nouvelle connexion n'est jamais fermée", async () => {
    const broker = probingBroker();
    const first = pingSocket();
    const old = broker.open(first);
    broker.bind(old, identity("rt-probe-replaced"));
    const probe = broker.probeLink("rt-probe-replaced", null, 30);
    const second = pingSocket();
    broker.bind(broker.open(second), identity("rt-probe-replaced"));
    expect((await probe).outcome).toBe("generation_changed");
    expect(first.closed?.code).toBe(RELAY_CLOSE_REPLACED);
    expect(second.closed).toBeNull();
    expect(broker.connected("rt-probe-replaced")).toBe(true);
  });

  test("closeIfCurrent refuse une connexion qui ne tient plus le lien", () => {
    const broker = probingBroker();
    const old = broker.open(pingSocket());
    broker.bind(old, identity("rt-fence"));
    const current = broker.open(pingSocket());
    broker.bind(current, identity("rt-fence"));
    expect(broker.closeIfCurrent(old, RELAY_CLOSE_RECONNECT, "LINK_RECONNECT_REQUESTED")).toBe(false);
    expect(current.isClosed).toBe(false);
  });

  test("deux vérifications simultanées partagent un seul ping ; sans lien ici : no_link", async () => {
    const broker = probingBroker();
    const socket = pingSocket();
    const connection = broker.open(socket);
    broker.bind(connection, identity("rt-probe-once"));
    const first = broker.probeLink("rt-probe-once", null, 1_000);
    const second = broker.probeLink("rt-probe-once", null, 1_000);
    expect(socket.pings).toHaveLength(1);
    connection.handlePong(socket.pings[0]!);
    expect((await first).outcome).toBe("alive");
    expect((await second).outcome).toBe("alive");
    expect(await broker.probeLink("rt-absent", null)).toEqual({ outcome: "no_link" });
  });

  test("un ping abandonné par la socket ne dit rien : indeterminate, rien n'est fermé", async () => {
    const broker = probingBroker();
    const socket = { ...pingSocket(), ping: () => 0 };
    const connection = broker.open(socket);
    broker.bind(connection, identity("rt-probe-drop"));
    expect(await broker.probeLink("rt-probe-drop", null, 30)).toEqual({ outcome: "indeterminate", generation: null });
    expect(connection.isClosed).toBe(false);
  });
});

describe("link_features : littéral text[] pour Postgres", () => {
  // Bun 1.3.14 lie un tableau JS comme `a,b` (mesuré) : Postgres refuse ce
  // littéral. Le broker écrit donc `{"a","b"}`, casté ::text[] dans la requête.
  test("rend un littéral que Postgres relit, vide compris", () => {
    expect(pgTextArray([])).toBe("{}");
    expect(pgTextArray(["provider_management"])).toBe('{"provider_management"}');
    expect(pgTextArray(["provider_management", "future_feature"])).toBe('{"provider_management","future_feature"}');
  });

  test("cite et échappe chaque élément", () => {
    expect(pgTextArray(['we"ird\\x'])).toBe('{"we\\"ird\\\\x"}');
  });
});

/**
 * Backpressure et dépassement : `ServerWebSocket.send` rend -1 (mis en file),
 * 0 (ABANDONNÉ) ou > 0. Un fragment abandonné ne doit jamais laisser partir un
 * corps tronqué clos par un `end` propre ; une réponse trop grosse ne doit
 * faire échouer qu'elle, pas les 63 autres requêtes en vol.
 */
describe("runtime link broker : backpressure et 1009", () => {
  type FakeSocket = {
    socket: { send(data: string | Uint8Array): number; close(code?: number, reason?: string): void };
    texts: RelayTextFrame[];
    binaries: number;
    closed: { code: number; reason: string } | null;
  };

  /** Une socket factice dont `send` rend ce que le test décide pour chaque trame binaire. */
  function fakeSocket(verdict: (binaryIndex: number) => number): FakeSocket {
    const fake: FakeSocket = { socket: { send: () => 1, close: () => {} }, texts: [], binaries: 0, closed: null };
    fake.socket = {
      send(data) {
        if (typeof data === "string") {
          fake.texts.push(decodeTextFrame(data));
          return data.length;
        }
        fake.binaries += 1;
        return verdict(fake.binaries);
      },
      close(code, reason) {
        fake.closed = { code: code ?? 0, reason: reason ?? "" };
      },
    };
    return fake;
  }

  function fakeBroker(): RuntimeLinkBroker {
    return new RuntimeLinkBroker({
      instanceId: "api-test",
      liveness: recordingLiveness([]),
      pingIntervalMs: 3_600_000,
      firstResponseTimeoutMs: 60_000,
      log: () => {},
    });
  }

  test("un fragment de corps abandonné (send → 0) fait échouer SA requête, err à l'hôte, le lien sert encore", async () => {
    const fake = fakeSocket((index) => (index === 2 ? 0 : 1));
    const broker = fakeBroker();
    const connection = broker.open(fake.socket);
    broker.bind(connection, identity("rt-drop"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"input":"part-1'));
        controller.enqueue(new TextEncoder().encode('part-2"}'));
        controller.close();
      },
    });
    const error = await connection.dispatch({ method: "POST", path: "/v1/runs", headers: {}, body })
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayDialError);
    expect((error as RelayDialError).code).toBe("LINK_SEND_DROPPED");
    expect((error as RelayDialError).stage).toBe("after_dispatch");
    // L'hôte apprend l'abandon pour cet id, et aucun `end` propre ne suit un corps tronqué.
    expect(fake.texts.some((frame) => frame.t === "err" && frame.id === 1 && frame.code === "LINK_SEND_DROPPED")).toBe(true);
    expect(fake.texts.some((frame) => frame.t === "cancel" && frame.id === 1)).toBe(true);
    expect(fake.texts.some((frame) => frame.t === "end")).toBe(false);
    expect(connection.isClosed).toBe(false);
    expect(fake.closed).toBeNull();
    // Une seconde requête sur la même connexion aboutit encore.
    const second = connection.dispatch({ method: "GET", path: "/health", headers: {}, body: null });
    const request = fake.texts.find((frame) => frame.t === "req" && frame.path === "/health");
    expect(request?.t === "req" && request.id).toBe(2);
    connection.handleText({ t: "res", id: 2, status: 200, headers: { "content-type": "application/json" } });
    connection.handleBinary(encodeBinaryFrame(2, new TextEncoder().encode('{"ok":true}')));
    connection.handleText({ t: "end", id: 2 });
    expect(await (await second).json()).toEqual({ ok: true });
  });

  test("cancel/err abandonnés après un fragment abandonné : la requête échoue LINK_SEND_DROPPED, un seul close 1011, pas de récursion", async () => {
    // Tout envoi après le premier fragment est abandonné, texte compris.
    let sends = 0;
    let closes = 0;
    const socket = {
      send: () => (++sends <= 2 ? 1 : 0),
      close: () => {
        closes += 1;
      },
    };
    const broker = fakeBroker();
    const connection = broker.open(socket);
    broker.bind(connection, identity("rt-drop-cascade"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a"));
        controller.enqueue(new TextEncoder().encode("b"));
        controller.close();
      },
    });
    // send #1 = req, #2 = fragment a, #3 = fragment b (0), puis cancel (0) → 1011.
    const error = await connection.dispatch({ method: "POST", path: "/v1/runs", headers: {}, body })
      .then(() => null, (caught: unknown) => caught);
    expect((error as RelayDialError).code).toBe("LINK_SEND_DROPPED");
    expect(connection.isClosed).toBe(true);
    expect(closes).toBe(1);
    expect(connection.inFlightCount).toBe(0);
  });

  test("un premier req abandonné (send → 0) est réglé before_dispatch, les autres en vol after_dispatch", async () => {
    const fake = fakeSocket(() => 1);
    const broker = fakeBroker();
    const connection = broker.open(fake.socket);
    broker.bind(connection, identity("rt-drop-req"));
    const earlier = connection.dispatch({ method: "GET", path: "/health", headers: {}, body: null })
      .then(() => null, (caught: unknown) => caught);
    fake.socket.send = () => 0;
    // Aucun octet de cette création n'est parti : elle se rejoue sans risque.
    const error = await connection.dispatch({ method: "POST", path: "/v1/runs", headers: {}, body: null })
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayDialError);
    expect((error as RelayDialError).stage).toBe("before_dispatch");
    expect(connection.isClosed).toBe(true);
    expect(fake.closed).toEqual({ code: 1011, reason: "LINK_SEND_FAILED" });
    expect(((await earlier) as RelayDialError).stage).toBe("after_dispatch");
    expect(connection.inFlightCount).toBe(0);
  });

  test("un en-tête de réponse invalide (NUL) règle la requête LINK_PROTOCOL_ERROR au lieu de la laisser pendante", async () => {
    const fake = fakeSocket(() => 1);
    const broker = fakeBroker();
    const connection = broker.open(fake.socket);
    broker.bind(connection, identity("rt-bad-header"));
    const pending = connection.dispatch({ method: "GET", path: "/health", headers: {}, body: null });
    connection.handleText({ t: "res", id: 1, status: 200, headers: { "content-type": "application/json\u0000x" } });
    const error = await Promise.race([pending.then(() => null, (caught: unknown) => caught), Bun.sleep(500).then(() => "still pending")]);
    expect(error).toBeInstanceOf(RelayDialError);
    expect((error as RelayDialError).code).toBe("LINK_PROTOCOL_ERROR");
    expect((error as RelayDialError).stage).toBe("after_dispatch");
    expect(fake.texts.some((frame) => frame.t === "cancel" && frame.id === 1)).toBe(true);
    expect(connection.inFlightCount).toBe(0);
    expect(connection.isClosed).toBe(false);
  });

  test("une trame de contrôle abandonnée (send → 0) ferme le lien 1011", () => {
    const fake = fakeSocket(() => 1);
    fake.socket.send = () => 0;
    const broker = fakeBroker();
    const connection = broker.open(fake.socket);
    broker.bind(connection, identity("rt-drop-text"));
    expect(connection.sendFrame({ t: "ping" })).toBe(false);
    expect(connection.isClosed).toBe(true);
    expect(fake.closed).toEqual({ code: 1011, reason: "LINK_SEND_FAILED" });
  });

  test("une réponse au-delà de 4 MiB n'échoue qu'elle : l'autre requête en vol reçoit son corps, le lien reste ouvert", async () => {
    const harness = startHarness();
    const host = await harness.connect("rt-big");
    const dial = harness.broker.dialer("rt-big");
    const big = dial({ method: "GET", path: "/v1/models", headers: {}, body: null });
    const small = dial({ method: "GET", path: "/health", headers: {}, body: null });
    await host.waitFrame((frame) => frame.t === "req" && frame.path === "/health");
    send(host, { t: "res", id: 1, status: 200, headers: { "content-type": "application/octet-stream" } });
    const chunk = new Uint8Array(1 << 20);
    for (let index = 0; index < 5; index += 1) host.ws.send(encodeBinaryFrame(1, chunk));
    const bigResponse = await big;
    const bigError = await bigResponse.arrayBuffer().then(() => null, (caught: unknown) => caught);
    expect(bigError).toBeInstanceOf(RelayDialError);
    expect((bigError as RelayDialError).code).toBe("HERMES_PROTOCOL_LIMIT");
    const err = await host.waitFrame((frame) => frame.t === "err" && frame.id === 1);
    expect(err.t === "err" && err.code).toBe("HERMES_PROTOCOL_LIMIT");
    await host.waitFrame((frame) => frame.t === "cancel" && frame.id === 1);
    // L'hôte clôt sa réponse abandonnée ; puis la seconde requête aboutit.
    send(host, { t: "end", id: 1 });
    await answer(host, 2, '{"ok":true}');
    expect(await (await small).json()).toEqual({ ok: true });
    expect(harness.broker.connected("rt-big")).toBe(true);
    // Le lien n'a pas été fermé 1009.
    await Bun.sleep(50);
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("un hôte qui insiste au-delà de 8 MiB après l'abandon ferme le lien 1009", async () => {
    const fake = fakeSocket(() => 1);
    const broker = fakeBroker();
    const connection = broker.open(fake.socket);
    broker.bind(connection, identity("rt-overrun"));
    const pending = connection.dispatch({ method: "GET", path: "/v1/models", headers: {}, body: null });
    connection.handleText({ t: "res", id: 1, status: 200, headers: {} });
    // Lecteur attaché AVANT le dépassement, comme le worker qui consomme le flux.
    const consumed = (await pending).arrayBuffer().then(() => null, (caught: unknown) => caught);
    const chunk = new Uint8Array(1 << 20);
    for (let index = 0; index < 5; index += 1) connection.handleBinary(encodeBinaryFrame(1, chunk));
    const error = await consumed;
    expect((error as RelayDialError).code).toBe("HERMES_PROTOCOL_LIMIT");
    expect(connection.isClosed).toBe(false);
    // 8 MiB tolérés après l'abandon…
    for (let index = 0; index < 8; index += 1) connection.handleBinary(encodeBinaryFrame(1, chunk));
    expect(connection.isClosed).toBe(false);
    // …le premier octet au-delà ferme 1009.
    connection.handleBinary(encodeBinaryFrame(1, new Uint8Array(1)));
    expect(connection.isClosed).toBe(true);
    expect(fake.closed).toEqual({ code: 1009, reason: "HERMES_PROTOCOL_LIMIT" });
  });

  test("l'id d'une réponse abandonnée n'est pas réattribué tant que l'hôte n'a pas dit end", async () => {
    const fake = fakeSocket(() => 1);
    const broker = fakeBroker();
    const connection = broker.open(fake.socket);
    broker.bind(connection, identity("rt-reuse"));
    // Tous les ids sont épuisés artificiellement en poussant nextRequestId près de la borne u32.
    (connection as unknown as { nextRequestId: number }).nextRequestId = 0xffff_ffff;
    const first = connection.dispatch({ method: "GET", path: "/v1/models", headers: {}, body: null });
    connection.handleText({ t: "res", id: 0xffff_ffff, status: 200, headers: {} });
    const consumed = (await first).arrayBuffer().catch(() => undefined);
    for (let index = 0; index < 5; index += 1) connection.handleBinary(encodeBinaryFrame(0xffff_ffff, new Uint8Array(1 << 20)));
    await consumed;
    (connection as unknown as { nextRequestId: number }).nextRequestId = 0xffff_ffff;
    const second = connection.dispatch({ method: "GET", path: "/health", headers: {}, body: null });
    const request = fake.texts.filter((frame) => frame.t === "req").at(-1);
    expect(request?.t === "req" && request.id).toBe(1);
    connection.handleText({ t: "end", id: 0xffff_ffff });
    connection.handleText({ t: "res", id: 1, status: 204 });
    expect((await second).status).toBe(204);
  });
});

describe("runtime link broker : réponse de mutation après un flux SSE", () => {
  test("un steer 200 reste livré quand le consommateur annule le corps avant body/end", async () => {
    const texts: RelayTextFrame[] = [];
    const socket = {
      send(data: string | Uint8Array): number {
        if (typeof data === "string") texts.push(decodeTextFrame(data));
        return 1;
      },
      close() {},
    };
    const broker = new RuntimeLinkBroker({
      instanceId: "api-test",
      liveness: recordingLiveness([]),
      pingIntervalMs: 3_600_000,
      firstResponseTimeoutMs: 60_000,
      log: () => {},
    });
    const connection = broker.open(socket);
    broker.bind(connection, identity("rt-steer-response"));
    const transport = createRelayTransport({ runtimeId: "rt-steer-response", dial: broker.dialer("rt-steer-response") });
    const client = new HermesClient({ transport });

    const steer = client.steerRun("run_1", { text: "continue" });
    const events = transport.send("/v1/runs/run_1/events", {}, "safe");
    const requests = texts.filter((frame) => frame.t === "req");
    const mutation = requests.find((frame) => frame.t === "req" && frame.path.endsWith("/steer"));
    const stream = requests.find((frame) => frame.t === "req" && frame.path.endsWith("/events"));
    expect(mutation?.t).toBe("req");
    expect(stream?.t).toBe("req");

    connection.handleText({ t: "res", id: stream!.id, status: 200, headers: { "content-type": "text/event-stream" } });
    const eventResponse = await events;
    const eventReader = eventResponse.body!.getReader();
    connection.handleBinary(encodeBinaryFrame(stream!.id, new TextEncoder().encode("event: run.steered\\ndata: {}\\n\\n")));
    await expect(eventReader.read()).resolves.toMatchObject({ done: false });

    // Le gateway a reçu et répondu au POST ; les trames body/end peuvent encore
    // être dans le tuyau quand steerRun lit le statut puis annule son corps.
    connection.handleText({ t: "res", id: mutation!.id, status: 200, headers: { "content-type": "application/json" } });
    await expect(steer).resolves.toBe(200);
    expect(connection.inFlightCount).toBe(1);

    connection.handleBinary(encodeBinaryFrame(mutation!.id, new TextEncoder().encode('{"accepted":true}')));
    connection.handleText({ t: "end", id: mutation!.id });
    await eventReader.cancel();
  });
});
