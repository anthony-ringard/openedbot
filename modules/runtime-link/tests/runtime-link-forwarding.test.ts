import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, spyOn, test } from "bun:test";
import { RelayDialError } from "@openedbot/hermes";
import type { Db } from "@openedbot/platform-db";
import {
  createRuntimeLinkLocator,
  LINK_CONTROL_FORWARD_TIMEOUT_MS,
  RUNTIME_LINK_RELAY_STAGE_HEADER,
} from "../src/application/instances";

const runtimeId = "5f0f8a3a-1111-4222-8333-444455556666";
const db = (async () => [{ instanceId: "gateway-b", internalUrl: "http://gateway-b:8792", instanceLive: true }]) as unknown as Db;
const request = { method: "POST", path: "/v1/runs", headers: {}, body: null } as const;
function locator(fetchImpl: typeof fetch) {
  return createRuntimeLinkLocator(db, { instanceId: "api-a", apiInternalUrl: "http://api-a:8790", relay: testInternalSecrets("api", "test")}, fetchImpl);
}
function proxyRequest() {
  return new Request(`http://api-a:8790/internal/runtime-links/${runtimeId}/proxy/v1/runs`, { method: "POST", body: "{}" });
}

describe("inter-instance dispatch certainty", () => {
  for (const [name, failure, stage] of [
    ["reset after possible dispatch", Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), "after_dispatch"],
    ["unclassified fetch failure", new TypeError("fetch failed"), "after_dispatch"],
    ["misleading error message", new Error("unable to connect after dispatch"), "after_dispatch"],
    ["proven refusal", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), "before_dispatch"],
    ["nested DNS failure", new TypeError("fetch failed", { cause: Object.assign(new Error("DNS"), { code: "ENOTFOUND" }) }), "before_dispatch"],
  ] as const) {
    test(name, async () => {
      const relay = locator((async () => { throw failure; }) as unknown as typeof fetch);
      const error = await relay.forwardDial(runtimeId, request).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RelayDialError);
      expect((error as RelayDialError).stage).toBe(stage);
      const response = await relay.forwardProxy(runtimeId, proxyRequest());
      expect(response.status).toBe(stage === "before_dispatch" ? 503 : 502);
      expect(response.headers.get(RUNTIME_LINK_RELAY_STAGE_HEADER)).toBe(stage);
    });
  }

  test("explicit remote broker rejection preserves its stage", async () => {
    const relay = locator((async () => Response.json({ error: { code: "LINK_BUSY", message: "busy" } }, {
      status: 503, headers: { [RUNTIME_LINK_RELAY_STAGE_HEADER]: "before_dispatch" },
    })) as unknown as typeof fetch);
    const error = await relay.forwardDial(runtimeId, request).catch((error: unknown) => error);
    expect((error as RelayDialError).stage).toBe("before_dispatch");
    expect((error as RelayDialError).code).toBe("LINK_BUSY");
  });

  test("forwardProbe waits for the owner's verdict and never trusts an unknown shape", async () => {
    const posted: Array<{ url: string; body: unknown; hop: string | null }> = [];
    const relay = locator((async (input: string, init: RequestInit) => {
      posted.push({ url: String(input), body: JSON.parse(String(init.body)), hop: new Headers(init.headers).get("X-OpenedBot-Relay-Hop") });
      return Response.json({ outcome: "reconnect_requested", generation: "12" });
    }) as unknown as typeof fetch);
    expect(await relay.forwardProbe(runtimeId, "12")).toEqual({ outcome: "reconnect_requested", generation: "12" });
    expect(posted).toEqual([{ url: `http://gateway-b:8792/internal/runtime-links/${runtimeId}/probe`, body: { generation: "12" }, hop: "1" }]);

    const odd = locator((async () => Response.json({ outcome: "restart_host" })) as unknown as typeof fetch);
    expect(await odd.forwardProbe(runtimeId, null)).toEqual({ outcome: "owner_unavailable" });
    const down = locator((async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); }) as unknown as typeof fetch);
    expect(await down.forwardProbe(runtimeId, null)).toEqual({ outcome: "owner_unavailable" });
  });

  test("body interruption after response headers propagates without a false pre-dispatch response", async () => {
    const failure = new Error("stream interrupted");
    const relay = locator((async () => new Response(new ReadableStream({ start(controller) { controller.error(failure); } }))) as unknown as typeof fetch);
    for (const response of [await relay.forwardDial(runtimeId, request), await relay.forwardProxy(runtimeId, proxyRequest())]) {
      expect(response.status).toBe(200);
      expect(response.headers.get(RUNTIME_LINK_RELAY_STAGE_HEADER)).toBeNull();
      expect(await response.text().catch((error: unknown) => error)).toBe(failure);
    }
  });
});

describe("control frame forward to the owner instance", () => {
  // The owner is alive in the lease table but never answers (frozen process,
  // black-holed route). Like a real fetch, the request only ends when its
  // signal fires; with no signal nothing can ever end it.
  const silentOwner = (async (_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as unknown as typeof fetch;

  test("a silent owner ends a close as not pushed and a rotate as unknown, within the bound", async () => {
    // Real timers, but 20 ms instead of the production bound so the test stays
    // fast; the bound the forward asks for is asserted separately below.
    const requested: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      requested.push(ms);
      return realTimeout(20);
    });
    try {
      const relay = locator(silentOwner);
      const pushes = {
        close: () => relay.forwardClose(runtimeId, 4004, "LINK_REVOKED"),
        rotate: () => relay.forwardRotate(runtimeId, { t: "link.rotate", runtimeId, linkToken: "next-token" }),
      };
      // The frame may have reached the owner: a rotation must not be undone on that.
      const expected = { close: false, rotate: "unknown" };
      for (const [name, push] of Object.entries(pushes)) {
        const outcome = await Promise.race([push(), Bun.sleep(1_000).then(() => "still waiting")]);
        expect([name, outcome]).toEqual([name, expected[name as keyof typeof expected]]);
      }
      expect(requested).toEqual([LINK_CONTROL_FORWARD_TIMEOUT_MS, LINK_CONTROL_FORWARD_TIMEOUT_MS]);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("rotate push outcome through the owner instance", () => {
  const rotate = (fetchImpl: typeof fetch) =>
    locator(fetchImpl).forwardRotate(runtimeId, { t: "link.rotate", runtimeId, linkToken: "next-token" });

  test("only an explicit answer or a pre-dispatch refusal is certain", async () => {
    const cases: Array<[string, () => Response, boolean | "unknown"]> = [
      ["pushed", () => Response.json({ pushed: true }), true],
      ["owner holds no link", () => Response.json({ pushed: false }), false],
      ["owner hop uncertain", () => Response.json({ pushed: false, uncertain: true }), "unknown"],
      ["pre-dispatch refusal", () => Response.json({}, { status: 503, headers: { [RUNTIME_LINK_RELAY_STAGE_HEADER]: "before_dispatch" } }), false],
      ["auth refusal", () => new Response("", { status: 401 }), false],
      ["unmarked server error", () => new Response("", { status: 500 }), "unknown"],
      ["unreadable body", () => new Response("not json", { status: 200 }), "unknown"],
    ];
    for (const [name, response, expected] of cases) {
      expect([name, await rotate((async () => response()) as unknown as typeof fetch)]).toEqual([name, expected]);
    }
    expect(await rotate((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).toBe("unknown");
  });
});
