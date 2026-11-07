import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { organizationEventEnvelope } from "@openedbot/contracts-events";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import type { Db } from "@openedbot/platform-db";
import type { ApiConfig } from "../src/infrastructure/config";
import { eventRoutes, internalEventRoutes } from "../src/routes/events/event-routes";
import { HttpError } from "../src/interfaces/http/http-error";
import type { AppVariables } from "../src/routes/identity/auth";
import { fakeRunEventsDb, type StoredRow } from "./fixtures/run-events-db";
import { acceptLiveEvent, advanceStreamCursor, createLiveDedupe } from "../../console/src/lib/stream/thread-stream-live";

const organizationId = "org-early";
const occurredAt = new Date("2026-10-03T12:00:00.000Z");
const identity = {
  botId: "bot-1",
  turnId: "run-1",
  sessionKey: `openedbot:${organizationId}:dm:run-1`,
};
const base = {
  organizationId,
  threadId: "thread-1",
  runId: "run-1",
  sequence: 3,
  type: "agent.message",
  payload: { delta: "salut" },
};

function sseApp(db: Db, hub: EventHub, replayWindowEvents = 1_000) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(async (context, next) => {
    context.set("auth", { organizationId } as AppVariables["auth"]);
    await next();
  });
  app.route("/", eventRoutes(db, hub, { fallbackPollMs: 60_000, replayWindowMs: 3_600_000, replayWindowEvents }));
  return app;
}

async function nextFrame(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }): Promise<string> {
  const decoder = new TextDecoder();
  for (;;) {
    const end = buffer.text.indexOf("\n\n");
    if (end >= 0) {
      const frame = buffer.text.slice(0, end);
      buffer.text = buffer.text.slice(end + 2);
      if (frame.startsWith(":") || frame.split("\n").every((line) => line.startsWith(":") || line === "")) continue;
      return frame;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("stream closed before a frame");
    buffer.text += decoder.decode(chunk.value, { stream: true });
  }
}

describe("SSE avant commit", () => {
  test("un bail absent ou périmé ne publie pas de trame provisoire", async () => {
    const hub = new EventHub();
    const published: unknown[] = [];
    const unsubscribe = hub.subscribe(organizationId, (entry) => { published.push(entry); });
    try {
      const routes = internalEventRoutes(fakeRunEventsDb([]), testInternalSecrets("api", "worker-secret"), hub);
      routes.onError((error, context) => {
        if (error instanceof HttpError && error.status === 400) return context.json({ error: error.code }, 400);
        throw error;
      });
      const post = (entry: unknown) => routes.request("http://localhost/publish", {
        method: "POST",
        headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      const event = organizationEventEnvelope({ ...base, ...identity, leaseGeneration: 3, occurredAt });
      expect((await post(event)).status).toBe(204);
      expect((await post({ ...event, leaseGeneration: null })).status).toBe(400);
      expect(published).toEqual([]);
    } finally { unsubscribe(); }
  });

  test("la trame provisoire reprend l'identité SQL du run courant", async () => {
    const hub = new EventHub();
    const published: unknown[] = [];
    const unsubscribe = hub.subscribe(organizationId, (entry) => { published.push(entry); });
    try {
      const routes = internalEventRoutes(fakeRunEventsDb([], { liveRun: identity }), testInternalSecrets("api", "worker-secret"), hub);
      const supplied = organizationEventEnvelope({ ...base, botId: "wrong-bot", turnId: "wrong-turn", sessionKey: "wrong-session", leaseGeneration: 4, occurredAt });
      const response = await routes.request("http://localhost/publish", {
        method: "POST",
        headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
        body: JSON.stringify(supplied),
      });
      expect(response.status).toBe(204);
      expect(published).toEqual([{ ...supplied, ...identity }]);
    } finally { unsubscribe(); }
  });

  test("un lot { events } est validé en entier puis diffusé dans l'ordre", async () => {
    const hub = new EventHub();
    const published: Array<{ sequence: number }> = [];
    const unsubscribe = hub.subscribe(organizationId, (entry) => { published.push(entry as { sequence: number }); });
    try {
      const routes = internalEventRoutes(fakeRunEventsDb([], { liveRun: identity }), testInternalSecrets("api", "worker-secret"), hub);
      routes.onError((error, context) => {
        if (error instanceof HttpError && error.status === 400) return context.json({ error: error.code }, 400);
        throw error;
      });
      const post = (entry: unknown) => routes.request("http://localhost/publish", {
        method: "POST",
        headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      const events = [3, 4, 5].map((sequence) => organizationEventEnvelope({ ...base, ...identity, sequence, leaseGeneration: 3, occurredAt }));
      expect((await post({ events })).status).toBe(204);
      expect(published.map((entry) => entry.sequence)).toEqual([3, 4, 5]);
      published.length = 0;
      expect((await post({ events: [events[0], { ...events[1], runId: 7 }] })).status).toBe(400);
      expect((await post({ events: [] })).status).toBe(400);
      expect(published).toEqual([]);
    } finally { unsubscribe(); }
  });

  test("pas d'id avant le commit, id après, et la bulle n'est pas doublée", async () => {
    const rows: StoredRow[] = [];
    const hub = new EventHub();
    // A two-event window makes the cursor advance threshold one event: the
    // `stream.cursor` that replaces the committed replay of an already pushed
    // frame leaves at once instead of on the 15 s heartbeat.
    const app = sseApp(fakeRunEventsDb(rows), hub, 2);
    const live = await app.request("http://localhost/?cursor=0");
    const reader = live.body!.getReader();
    const buffer = { text: "" };
    await Bun.sleep(20);

    const publish = internalEventRoutes(fakeRunEventsDb(rows, { liveRun: identity }), testInternalSecrets("api", "worker-secret"), hub);
    const early = organizationEventEnvelope({
      ...base,
      ...identity,
      leaseGeneration: 4,
      occurredAt,
    });
    expect(early).not.toHaveProperty("cursor");
    const hinted = await publish.request("http://localhost/publish", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
      body: JSON.stringify(early),
    });
    expect(hinted.status).toBe(204);
    const earlyFrame = await nextFrame(reader, buffer);
    expect(earlyFrame.startsWith("id:")).toBe(false);
    expect(earlyFrame.startsWith("event: agent.message\n")).toBe(true);
    const earlyData = JSON.parse(earlyFrame.slice(earlyFrame.indexOf("data: ") + 6));
    expect(earlyData).not.toHaveProperty("cursor");
    expect(earlyData).toMatchObject({ runId: "run-1", sequence: 3 });

    // Crash : rien n'est commité. Une reprise au curseur durable ne rejoue pas la trame.
    const replayApp = sseApp(fakeRunEventsDb(rows), new EventHub());
    const missed = await replayApp.request("http://localhost/?cursor=0");
    const missedReader = missed.body!.getReader();
    const missedChunk = await Promise.race([
      missedReader.read(),
      Bun.sleep(30).then(() => ({ done: false, value: undefined as Uint8Array | undefined })),
    ]);
    const missedText = missedChunk.value ? new TextDecoder().decode(missedChunk.value) : "";
    expect(missedText).not.toContain("agent.message");
    await missedReader.cancel();

    rows.push({ ...base, ...identity, cursor: "9", leaseGeneration: "4", occurredAt });
    const durable = organizationEventEnvelope({
      ...base, ...identity, cursor: "9", leaseGeneration: "4", occurredAt,
    });
    const committed = await publish.request("http://localhost/publish", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
      body: JSON.stringify(durable),
    });
    expect(committed.status).toBe(204);
    // Same connection: the frame already left live, so its commit only moves
    // the resume position (`id: 9`); no second agent.message is written.
    const cursorFrame = await nextFrame(reader, buffer);
    expect(cursorFrame.startsWith("id: 9\nevent: stream.cursor\n")).toBe(true);
    const cursorData = JSON.parse(cursorFrame.slice(cursorFrame.indexOf("data: ") + 6));
    expect(cursorData).toEqual({ organizationId, cursor: 9 });
    await reader.cancel();

    // A resume by cursor never saw the live frame: it gets the full durable
    // frame, with its `id:`.
    const resumedApp = sseApp(fakeRunEventsDb(rows), new EventHub());
    const resumed = await resumedApp.request("http://localhost/?cursor=0");
    const resumedReader = resumed.body!.getReader();
    const durableFrame = await nextFrame(resumedReader, { text: "" });
    await resumedReader.cancel();
    expect(durableFrame.startsWith("id: 9\nevent: agent.message\n")).toBe(true);
    const durableData = JSON.parse(durableFrame.slice(durableFrame.indexOf("data: ") + 6));
    expect(durableData.cursor).toBe(9);
    expect(durableData).toMatchObject({ runId: "run-1", sequence: 3 });

    // The console keeps one dedupe state across reconnections: the resumed
    // copy does not double the bubble, and the cursor reaches 9 either way.
    const state = createLiveDedupe();
    const first = acceptLiveEvent(state, earlyData, organizationId, 0);
    expect(first).toEqual({ deliver: true, streamCursor: 0 });
    expect(advanceStreamCursor(first.streamCursor, cursorData.cursor)).toBe(9);
    const second = acceptLiveEvent(state, durableData, organizationId, first.streamCursor);
    expect(second).toEqual({ deliver: false, streamCursor: 9 });
  });
});
