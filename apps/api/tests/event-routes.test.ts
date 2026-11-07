import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, test } from "bun:test";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import type { Db } from "@openedbot/platform-db";
import type { ApiConfig } from "../src/infrastructure/config";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import {
  createOrderedReplayPump,
  effectiveReplayCursor,
  flushBufferedSseEvents,
  replayGap,
  serializeGap,
  internalEventRoutes,
  replayPagesUntil,
  rowIdentity,
  shouldEmitSseCursor,
} from "../src/routes/events/event-routes";

function event(cursor: number): OrganizationEvent & { cursor: number } {
  return {
    cursor,
    organizationId: "org-1",
    threadId: "thread-1",
    runId: `run-${cursor}`,
    sequence: 0,
    type: "run.completed",
    payload: {},
    occurredAt: "2026-08-25T00:00:00.000Z",
  };
}

describe("SSE cursor policy", () => {
  test("cursor 0 accepts retained events and never regresses ids", () => {
    expect(shouldEmitSseCursor(1, 0)).toBe(true);
    expect(shouldEmitSseCursor(100, 99)).toBe(true);
    expect(shouldEmitSseCursor(99, 100)).toBe(false);
    expect(shouldEmitSseCursor(100, 100)).toBe(false);
    expect(shouldEmitSseCursor(Number.NaN, 0)).toBe(false);
  });

  test("replay livre toutes les pages au-delà de la limite sans saut", async () => {
    const events: Array<OrganizationEvent & { cursor: number }> = Array.from({ length: 2_005 }, (_, index) => ({
      cursor: index + 1,
      organizationId: "org-1",
      threadId: "thread-1",
      runId: `run-${index + 1}`,
      sequence: 0,
      type: "run.completed",
      payload: {},
      occurredAt: "2026-08-25T00:00:00.000Z",
    }));
    const requestedCursors: number[] = [];
    const delivered: OrganizationEvent[] = [];
    const deliveredCount = await replayPagesUntil(0, 2_005, async (cursor) => {
      requestedCursors.push(cursor);
      return events.filter((event) => event.cursor > cursor).slice(0, 1_000);
    }, (event) => delivered.push(event));

    expect(requestedCursors).toEqual([0, 1_000, 2_000]);
    expect(deliveredCount).toBe(events.length);
    expect(delivered.map((event) => event.cursor)).toEqual(events.map((event) => event.cursor));
  });

  test("les événements live mis en attente restent après le replay et dans l'ordre", () => {
    const buffered = [event(12), event(11)];
    const delivered = [9, 10];
    flushBufferedSseEvents(buffered, (entry) => {
      if (typeof entry.cursor === "number") delivered.push(entry.cursor);
    });
    expect(delivered).toEqual([9, 10, 11, 12]);
    expect(buffered).toEqual([]);
  });

  test("un commit réveille immédiatement un replay DB ordonné", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const requestedCursors: number[] = [];
    const delivered: number[] = [];
    const pump = createOrderedReplayPump(10, async (cursor) => {
      requestedCursors.push(cursor);
      return [event(12), event(11)];
    }, (entry) => delivered.push(entry.cursor), {
      schedule: (drain) => scheduled.push(drain),
    });

    pump.wake();
    pump.wake();
    expect(scheduled).toHaveLength(1);
    await scheduled.shift()!();

    expect(requestedCursors).toEqual([10]);
    expect(delivered).toEqual([11, 12]);
  });

  test("le hint worker authentifié réveille le poller sans publier son enveloppe directement", async () => {
    const woken: string[] = [];
    const routes = internalEventRoutes(
      {} as Db,
      testInternalSecrets("api", "worker-secret"),
      new EventHub(),
      (organizationId) => { woken.push(organizationId); },
    );
    const response = await routes.request("http://localhost/publish", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
      body: JSON.stringify(event(42)),
    });

    expect(response.status).toBe(204);
    expect(woken).toEqual(["org-1"]);
  });

  test("LISTEN établi : le hint post-commit n'est plus suivi, les trames pré-commit passent toujours", async () => {
    const tx = () => [{ botId: "bot-1", turnId: "run-1", sessionKey: "session-1" }];
    const db = { begin: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db;
    const hub = new EventHub();
    const received: number[] = [];
    hub.subscribe("org-1", (entry) => { received.push(entry.sequence); });
    const woken: string[] = [];
    let listening = true;
    const routes = internalEventRoutes(db, testInternalSecrets("api", "worker-secret"), hub,
      (organizationId) => { woken.push(organizationId); }, () => !listening);
    const live = { organizationId: "org-1", threadId: "thread-1", runId: "run-1", sequence: 8, leaseGeneration: 4,
      type: "agent.message", payload: { delta: "x" }, occurredAt: "2026-10-25T00:00:00.000Z" };
    const post = () => routes.request("http://localhost/publish", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event(7), live] }),
    });

    expect((await post()).status).toBe(204);
    expect(received).toEqual([8]);
    expect(woken).toEqual([]);
    listening = false;
    expect((await post()).status).toBe(204);
    expect(woken).toEqual(["org-1"]);
  });

  test("un lot pré-commit ne contrôle le bail qu'une fois par run, et publie dans l'ordre", async () => {
    const queries: string[] = [];
    const tx = (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      queries.push(text.includes("for share of run") ? "lease" : "other");
      return text.includes("for share of run")
        ? [{ botId: "bot-1", turnId: "run-1", sessionKey: "session-1" }]
        : [];
    };
    const db = { begin: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db;
    const hub = new EventHub();
    const received: Array<{ sequence: number; cursor?: number | null }> = [];
    hub.subscribe("org-1", (entry) => { received.push(entry); });
    const woken: string[] = [];
    const routes = internalEventRoutes(db, testInternalSecrets("api", "worker-secret"), hub,
      (organizationId) => { woken.push(organizationId); });
    const live = (sequence: number) => ({
      organizationId: "org-1", threadId: "thread-1", runId: "run-1", sequence, leaseGeneration: 4,
      type: "agent.message", payload: { delta: "x" }, occurredAt: "2026-10-25T00:00:00.000Z",
    });
    const response = await routes.request("http://localhost/publish", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event(7), live(1), live(2), live(3)] }),
    });

    expect(response.status).toBe(204);
    expect(queries.filter((entry) => entry === "lease")).toHaveLength(1);
    expect(received.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(received.every((entry) => entry.cursor === undefined || entry.cursor === null)).toBe(true);
    expect(woken).toEqual(["org-1"]);
  });

  test("un bail périmé ne publie aucune trame du lot", async () => {
    const tx = () => [];
    const db = { begin: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db;
    const hub = new EventHub();
    const received: unknown[] = [];
    hub.subscribe("org-1", (entry) => { received.push(entry); });
    const routes = internalEventRoutes(db, testInternalSecrets("api", "worker-secret"), hub, () => {});
    const live = (sequence: number) => ({
      organizationId: "org-1", threadId: "thread-1", runId: "run-1", sequence, leaseGeneration: 3,
      type: "agent.message", payload: {}, occurredAt: "2026-10-25T00:00:00.000Z",
    });
    const response = await routes.request("http://localhost/publish", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ events: [live(1), live(2)] }),
    });
    expect(response.status).toBe(204);
    expect(received).toEqual([]);
  });

  test("la trame live et son rejeu commité partagent la même identité de ligne", () => {
    const base = { ...event(9), runId: "run-1", sequence: 3, type: "agent.message" as const, leaseGeneration: 4 };
    const { cursor: _cursor, ...live } = base;
    expect(rowIdentity(live as OrganizationEvent)).toBe(rowIdentity(base));
    expect(rowIdentity({ ...base, leaseGeneration: 5 })).not.toBe(rowIdentity(base));
    expect(rowIdentity({ ...base, sequence: 4 })).not.toBe(rowIdentity(base));
  });

  test("un commit pendant un SELECT déclenche un seul rattrapage sans chevauchement", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const requestedCursors: number[] = [];
    const delivered: number[] = [];
    let releaseFirst!: (events: Array<OrganizationEvent & { cursor: number }>) => void;
    const firstPage = new Promise<Array<OrganizationEvent & { cursor: number }>>((resolve) => { releaseFirst = resolve; });
    const pump = createOrderedReplayPump(0, async (cursor) => {
      requestedCursors.push(cursor);
      return requestedCursors.length === 1 ? firstPage : [event(3)];
    }, (entry) => delivered.push(entry.cursor), {
      schedule: (drain) => scheduled.push(drain),
    });

    pump.wake();
    const firstDrain = scheduled.shift()!;
    const firstRun = firstDrain();
    await Promise.resolve();
    pump.wake();
    pump.wake();
    expect(scheduled).toHaveLength(0);
    releaseFirst([event(2), event(1)]);
    await firstRun;

    expect(scheduled).toHaveLength(1);
    await scheduled.shift()!();
    expect(requestedCursors).toEqual([0, 2]);
    expect(delivered).toEqual([1, 2, 3]);
  });

  test("une page pleine se draine sans attendre le fallback, mais la fermeture stoppe les réveils", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const requestedCursors: number[] = [];
    const pump = createOrderedReplayPump(0, async (cursor) => {
      requestedCursors.push(cursor);
      return cursor === 0 ? [event(1), event(2)] : [];
    }, () => undefined, {
      pageLimit: 2,
      schedule: (drain) => scheduled.push(drain),
    });

    pump.wake();
    await scheduled.shift()!();
    expect(scheduled).toHaveLength(1);
    await scheduled.shift()!();
    pump.close();
    pump.wake();

    expect(requestedCursors).toEqual([0, 2]);
    expect(scheduled).toHaveLength(0);
  });
});

describe("borne de rejeu", () => {
  test("un curseur demandé au-dessus du plancher n'est jamais rabaissé", () => {
    expect(effectiveReplayCursor({
      requestedCursor: 9_900, maxCursor: 10_000, oldestCursorInWindow: 9_000, windowEvents: 200,
    })).toBe(9_900);
  });

  test("un curseur demandé sous le plancher est relevé, et le trou est annoncé", () => {
    const replayCursor = effectiveReplayCursor({
      requestedCursor: 7, maxCursor: 10_000, oldestCursorInWindow: 9_000, windowEvents: 200,
    });
    expect(replayCursor).toBe(9_800);
    expect(replayGap(7, replayCursor)).toEqual({ from: 7, to: 9_800 });
    expect(serializeGap({ organizationId: "org-1", from: 7, to: 9_800 }))
      .toBe('event: stream.gap\ndata: {"organizationId":"org-1","from":7,"to":9800}\n\n');
  });

  test("pas de trou sans position (cursor=0) ni quand rien n'a été sauté", () => {
    expect(replayGap(0, 9_800)).toBeNull();
    expect(replayGap(9_900, 9_900)).toBeNull();
  });

  test("la fenêtre temporelle rejoue son plus ancien événement, pas ce qui précède", () => {
    expect(effectiveReplayCursor({
      requestedCursor: 0, maxCursor: 500, oldestCursorInWindow: 450, windowEvents: 200,
    })).toBe(449);
  });

  test("le plafond en nombre prime quand la fenêtre temporelle est plus large", () => {
    expect(effectiveReplayCursor({
      requestedCursor: 0, maxCursor: 10_000, oldestCursorInWindow: 100, windowEvents: 200,
    })).toBe(9_800);
  });

  test("une fenêtre vide ne rejoue rien : le client prend le flux au max courant", () => {
    expect(effectiveReplayCursor({
      requestedCursor: 0, maxCursor: 42, oldestCursorInWindow: null, windowEvents: 200,
    })).toBe(42);
  });

  test("une organisation sans événement ou plus jeune que le plafond part de zéro", () => {
    expect(effectiveReplayCursor({
      requestedCursor: 0, maxCursor: 0, oldestCursorInWindow: null, windowEvents: 200,
    })).toBe(0);
    expect(effectiveReplayCursor({
      requestedCursor: 0, maxCursor: 30, oldestCursorInWindow: 1, windowEvents: 200,
    })).toBe(0);
  });
});
