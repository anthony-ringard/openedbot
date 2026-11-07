import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, test } from "bun:test";
import type { ApiConfig } from "@openedbot/platform-config/api-config";
import { captureLogEvents } from "@openedbot/platform-observability/log/test-logger";
import type { RelayRequest } from "@openedbot/hermes";
import type { RuntimeLinkBroker } from "../src/application/broker";
import { runtimeLinkInternalRelay, type InternalRelayContext } from "../src/application/internal-relay";
import { NO_RUNTIME_LINK_LOCATOR, RUNTIME_LINK_INTERNAL_PREFIX } from "../src/application/instances";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function relayWith(seen: RelayRequest[]) {
  const broker = {
    connected: () => true,
    dialer: () => async (request: RelayRequest) => { seen.push(request); return Response.json({ ok: true }); },
  } as unknown as RuntimeLinkBroker;
  return runtimeLinkInternalRelay(testInternalSecrets("api", "test"), broker, NO_RUNTIME_LINK_LOCATOR);
}

function context(path: string, headers: Record<string, string>): InternalRelayContext {
  const raw = new Request(`http://gateway.test${RUNTIME_LINK_INTERNAL_PREFIX}/rt-1/proxy${path}`, {
    headers: { authorization: "Bearer test", ...headers },
  });
  return {
    req: {
      header: (name: string) => raw.headers.get(name) ?? undefined,
      param: () => "rt-1",
      url: raw.url,
      method: raw.method,
      raw,
    },
    json: (object) => Response.json(object),
  };
}

describe("internal relay: the run's traceparent", () => {
  test("a well-formed traceparent is relayed to the host and journaled with the relay's outcome", async () => {
    const seen: RelayRequest[] = [];
    const { result, records } = await captureLogEvents(() =>
      relayWith(seen).proxy(context("/v1/runs/run-1/events?since=3", { traceparent: TRACEPARENT })));
    expect(result.status).toBe(200);
    expect(seen[0]!.headers.traceparent).toBe(TRACEPARENT);
    expect(records).toEqual([expect.objectContaining({
      event: "runtime_link.relay_request",
      channel: "runtime_link",
      runtimeId: "rt-1",
      method: "GET",
      path: "/v1/runs/run-1/events",
      status: 200,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    })]);
  });

  test("a route the link refuses is journaled with its stage, and nothing is relayed", async () => {
    const seen: RelayRequest[] = [];
    const { result, records } = await captureLogEvents(() =>
      relayWith(seen).proxy(context("/api/credentials/pool", { traceparent: TRACEPARENT })));
    expect(result.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(records).toEqual([expect.objectContaining({ event: "runtime_link.relay_request", status: 403, stage: "before_dispatch", level: 40 })]);
  });

  test("a malformed or absent traceparent is neither relayed nor journaled, and the request is served as before", async () => {
    for (const headers of [{ traceparent: "00-not-a-trace" }, {} as Record<string, string>]) {
      const seen: RelayRequest[] = [];
      const { result, records } = await captureLogEvents(() => relayWith(seen).proxy(context("/health", headers)));
      expect(result.status).toBe(200);
      expect(seen[0]!.headers).not.toHaveProperty("traceparent");
      expect(records).toEqual([]);
    }
  });
});
