import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, test } from "bun:test";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import { HermesEventNormalizer } from "../../src/domain/hermes-events";
import { publish, publishBatch } from "../../src/application/runner/events";

const config = { apiInternalUrl: "http://api:8790", internalSecrets: testInternalSecrets("worker", "test-token")};
const event: OrganizationEvent = {
  cursor: 42, organizationId: "org-1", threadId: "thread-1", runId: "run-1", sequence: 3,
  type: "message.delta", payload: { delta: "hello" }, occurredAt: "2026-09-05T12:00:00Z",
};

describe("post-commit event hint remains best effort", () => {
  test("API refusal and HTTP failure do not escape into run execution", async () => {
    for (const response of [() => { throw new Error("API restarting"); }, () => new Response(null, { status: 503 })]) {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      await publish(config, event, (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return response();
      }) as typeof fetch);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("http://api:8790/internal/events/publish");
      expect(new Headers(requests[0]!.init?.headers).get("Authorization")).toBe("Bearer test-token");
      expect(JSON.parse(String(requests[0]!.init?.body))).toEqual(event);
    }
  });

  test("an unresponsive API is aborted within the two-second hint deadline", async () => {
    let signal: AbortSignal | null | undefined;
    const started = performance.now();
    await publish(config, event, ((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    }) as typeof fetch);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect((signal as AbortSignal | undefined)?.aborted).toBe(true);
  }, 4_000);
});

describe("publishBatch", () => {
  test("N events go out as one POST with the events in order; one event keeps the single body", async () => {
    const requests: Array<{ init?: RequestInit }> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const events = [1, 2, 3].map((sequence) => ({ ...event, sequence }));
    await publishBatch(config, events, fetchImpl);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ events });
    await publishBatch(config, [event], fetchImpl);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual(event);
  });

  test("a failing batch never throws", async () => {
    await publishBatch(config, [event, event], (async (_url: RequestInfo | URL) => new Response(null, { status: 503 })) as typeof fetch);
  });

  test("each phase is one POST, and the first text event is not held for a later batch", async () => {
    const normalizer = new HermesEventNormalizer(0, { flushFirstDelta: true });
    const first = normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 1, delta: "Hi" });
    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe("agent.message");
    expect(normalizer.hasBufferedDelta).toBe(false);
    expect(normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 2, delta: " there" })).toEqual([]);
    expect(normalizer.hasBufferedDelta).toBe(true);

    const requests: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const uncommitted = { ...event, sequence: 0, type: "agent.message" as const, payload: { text: "Hi" } };
    const committed = [
      { ...event, sequence: 1, type: "agent.message" as const, payload: { text: " there" } },
      { ...event, sequence: 2, type: "run.completed" as const, payload: {} },
    ];
    // Terminaux : le lot commité part tout de suite (pas de report possible).
    await publishBatch(config, [uncommitted], fetchImpl);
    await publishBatch(config, committed, fetchImpl);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0]!)).toEqual(uncommitted);
    expect(JSON.parse(requests[1]!)).toEqual({ events: committed });
  });
});

describe("one secret per internal role (S1b)", () => {
  test("events go out with the events secret, never another role's", async () => {
    const split = { EVENTS_INTERNAL_TOKEN: "events-secret", RELAY_INTERNAL_TOKEN: "relay-secret", RUN_KEY_SECRET: "run-key-secret" };
    let authorization = null as string | null;
    await publish({ apiInternalUrl: "http://api:8790", internalSecrets: testInternalSecrets("worker", split) }, event,
      (async (_url: RequestInfo | URL, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("Authorization");
        return new Response(null, { status: 204 });
      }) as typeof fetch);
    expect(authorization).toBe("Bearer events-secret");
  });
});
