import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { RunEvent } from "../../src/domain/hermes-events";
import { DEFERRED_WAKE_MS, flushDeferredWake } from "../../src/application/runner/events";
import { isRunEventsLeaseFence, persistEvents } from "../../src/application/runner/persist";
import { classifyHermesFrame } from "../../src/application/runner/stream";
import type { WorkerConfig } from "../../src/application/worker-config";

const occurredAt = new Date("2026-10-03T12:00:00.000Z");

const config = {
  workerId: "worker-1",
  apiInternalUrl: "http://api.test",
  internalSecrets: testInternalSecrets("worker", "tok"),
} as WorkerConfig;

const context = {
  id: "run-1",
  organizationId: "org-1",
  threadId: "thread-1",
  botId: "bot-1",
  sessionId: "openedbot:org-1:dm:run-1",
  leaseGeneration: 4,
  workflowId: null,
  workflowRootRunId: null,
  provider: null,
  runtimeId: "rt-1",
};

function event(): RunEvent {
  return {
    sequence: 3,
    type: "agent.message",
    payload: { delta: "salut" },
    occurredAt,
  };
}

type Mode = "commit" | "fence" | "crash";

function harness(mode: Mode) {
  const published: Array<Record<string, unknown>> = [];
  let inserts = 0;
  const tx = (strings: TemplateStringsArray) => {
    if (!("raw" in strings)) return strings;
    const text = strings.join("?");
    if (text.includes("insert into run_events")) {
      inserts += 1;
      if (mode === "fence") {
        const error = new Error("run_events_lease_fence");
        Object.assign(error, { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23514", constraint: "run_events_lease_fence" });
        throw error;
      }
      if (mode === "crash") throw new Error("crash before commit");
      expect(published.length).toBeGreaterThan(0);
      expect(published[0]).not.toHaveProperty("cursor");
      return [{
        cursor: "9",
        botId: "bot-1",
        turnId: "run-1",
        sessionKey: context.sessionId,
        leaseGeneration: "4",
      }];
    }
    if (text.includes("pg_advisory_xact_lock")) return [];
    if (text.includes("max(sequence)")) return [];
    if (text.includes("last_hermes_sequence")) return [];
    if (text.includes("select id from runs")) return [{ id: context.id }];
    throw new Error(`unexpected query: ${text}`);
  };
  const db = {
    begin: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as SQL;
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    published.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { db, published, fetchImpl, inserts: () => inserts };
}

describe("fan-out avant le commit", () => {
  test("la trame live part avant l'INSERT, sans curseur, avec l'identité du run", async () => {
    const { db, published, fetchImpl } = harness("commit");
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await persistEvents(db, config, context as never, 3, [event()]);
    } finally {
      globalThis.fetch = original;
    }
    // Un seul POST par flush : le réveil post-commit attend le flush suivant.
    expect(published).toHaveLength(1);
    await flushDeferredWake(config, "run-1", fetchImpl);
    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({
      version: 1,
      organizationId: "org-1",
      threadId: "thread-1",
      runId: "run-1",
      botId: "bot-1",
      turnId: "run-1",
      sessionKey: context.sessionId,
      leaseGeneration: 4,
      sequence: 3,
      type: "agent.message",
      payload: { delta: "salut" },
    });
    expect(published[0]).not.toHaveProperty("cursor");
    expect(published[1]).toMatchObject({ cursor: 9, sequence: 3, turnId: "run-1" });
  });

  test("un DM dont le workflow a un run racine prend ce tour", async () => {
    const { db, published, fetchImpl } = harness("commit");
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await persistEvents(db, config, { ...context, workflowRootRunId: "root-run" } as never, 3, [event()]);
      await flushDeferredWake(config, "run-1", fetchImpl);
    } finally {
      globalThis.fetch = original;
    }
    expect(published[0]).toMatchObject({ turnId: "root-run" });
    expect(published[0]).not.toHaveProperty("cursor");
  });

  test("un crash entre le fan-out et le commit ne réécrit pas le lot", async () => {
    const { db, published, fetchImpl, inserts } = harness("crash");
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await expect(persistEvents(db, config, context as never, 3, [event()])).rejects.toThrow("crash before commit");
    } finally {
      globalThis.fetch = original;
    }
    expect(inserts()).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]).not.toHaveProperty("cursor");
  });

  test("un bail périmé 23514 abandonne le lot, sans second INSERT ni hint", async () => {
    const { db, published, fetchImpl, inserts } = harness("fence");
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await persistEvents(db, config, context as never, 3, [event()]);
    } finally {
      globalThis.fetch = original;
    }
    expect(inserts()).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]).not.toHaveProperty("cursor");
    expect(isRunEventsLeaseFence(Object.assign(new Error("run_events_lease_fence"), {
      code: "23514",
      constraint: "run_events_lease_fence",
    }))).toBe(true);
    expect(isRunEventsLeaseFence(Object.assign(new Error("autre"), { code: "23505" }))).toBe(false);
  });
});

describe("un seul POST par flush", () => {
  test("le réveil du flush N voyage dans le POST pré-commit du flush N+1", async () => {
    const { db, published, fetchImpl } = harness("commit");
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await persistEvents(db, config, context as never, 3, [event()]);
      expect(published).toHaveLength(1);
      await persistEvents(db, config, context as never, 4, [{ ...event(), sequence: 4 }]);
      // Flush 2 : un POST `{ events: [commité du flush 1, live du flush 2] }`.
      expect(published).toHaveLength(2);
      const batch = (published[1] as { events: Array<Record<string, unknown>> }).events;
      expect(batch).toHaveLength(2);
      expect(batch[0]).toMatchObject({ cursor: 9, sequence: 3 });
      expect(batch[1]).toMatchObject({ sequence: 4 });
      expect(batch[1]).not.toHaveProperty("cursor");
      await flushDeferredWake(config, "run-1", fetchImpl);
    } finally {
      globalThis.fetch = original;
    }
    expect(published).toHaveLength(3);
  });

  test("sans flush suivant, le réveil part seul au plus tard après DEFERRED_WAKE_MS", async () => {
    const { db, published, fetchImpl } = harness("commit");
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await persistEvents(db, config, context as never, 3, [event()]);
      expect(published).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, DEFERRED_WAKE_MS + 100));
    } finally {
      globalThis.fetch = original;
    }
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ cursor: 9 });
  });
});

describe("faux Hermes : doublon, trou, reconnexion", () => {
  test("un doublon de séquence est un trou, la reprise reprend après la dernière émise", () => {
    const replaySupported = true;
    const lastPersistedSequence = 0;
    const first = classifyHermesFrame(
      { sequence: 1 },
      { replaySupported, rawSequence: 0, lastPersistedSequence },
    );
    expect(first).toEqual({ action: "emit", rawSequence: 1 });
    const duplicate = classifyHermesFrame(
      { sequence: 1 },
      { replaySupported, rawSequence: first.rawSequence, lastPersistedSequence },
    );
    expect(duplicate.action).toBe("gap");
    const resumed = classifyHermesFrame(
      { sequence: 2 },
      { replaySupported, rawSequence: first.rawSequence, lastPersistedSequence },
    );
    expect(resumed).toEqual({ action: "emit", rawSequence: 2 });
    const backwards = classifyHermesFrame(
      { sequence: 2 },
      { replaySupported, rawSequence: resumed.rawSequence, lastPersistedSequence },
    );
    expect(backwards.action).toBe("gap");
  });

  test("sans rejeu, une séquence déjà persistée est sautée", () => {
    expect(classifyHermesFrame(
      { sequence: 2 },
      { replaySupported: false, rawSequence: 0, lastPersistedSequence: 4 },
    )).toEqual({ action: "skip", rawSequence: 2 });
  });

  test("un journal qui saute ou omet une séquence ne déplace pas le curseur", () => {
    const state = { replaySupported: true, rawSequence: 2, lastPersistedSequence: 2 };
    expect(classifyHermesFrame({ sequence: 4 }, state)).toEqual({ action: "gap", rawSequence: 2 });
    expect(classifyHermesFrame({}, state)).toEqual({ action: "gap", rawSequence: 2 });
  });
});
