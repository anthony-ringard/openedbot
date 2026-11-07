import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { organizationEventEnvelope } from "@openedbot/contracts-events";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import type { Db } from "@openedbot/platform-db";
import type { ApiConfig } from "../src/infrastructure/config";
import { eventRoutes, internalEventRoutes } from "../src/routes/events/event-routes";
import type { AppVariables } from "../src/routes/identity/auth";
import { fakeRunEventsDb as fakeDb, type StoredRow } from "./fixtures/run-events-db";

const organizationId = "org-envelope";

function sseApp(db: Db, hub: EventHub) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(async (context, next) => {
    context.set("auth", { organizationId } as AppVariables["auth"]);
    await next();
  });
  app.route("/", eventRoutes(db, hub, { fallbackPollMs: 60_000, replayWindowMs: 3_600_000, replayWindowEvents: 1_000 }));
  return app;
}

async function nextDataFrame(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }): Promise<string> {
  const decoder = new TextDecoder();
  for (;;) {
    const end = buffer.text.indexOf("\n\n");
    if (end >= 0) {
      const frame = buffer.text.slice(0, end);
      buffer.text = buffer.text.slice(end + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) return data.slice(6);
      continue;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("stream closed before a data frame");
    buffer.text += decoder.decode(chunk.value, { stream: true });
  }
}

const occurredAt = new Date("2026-10-03T12:00:00.000Z");
const identity = {
  botId: "bot-1",
  turnId: "run-root",
  sessionKey: `openedbot:${organizationId}:workflow:wf-1:bot:bot-1`,
};
const base = {
  organizationId, threadId: "thread-1", runId: "run-step", sequence: 4,
  type: "agent.message", payload: { delta: "bonjour" },
};

describe("enveloppe d'événement : live, rejeu et worker", () => {
  test("une même ligne sort identique au push live, au rejeu et à l'écriture worker", async () => {
    const rows: StoredRow[] = [];
    const hub = new EventHub();
    const app = sseApp(fakeDb(rows), hub);

    // Connexion live : ouverte AVANT le commit, rien à rejouer.
    const live = await app.request("http://localhost/?cursor=0");
    const liveReader = live.body!.getReader();
    const liveBuffer = { text: "" };
    // Le flux s'arme (souscription, rejeu vide, poller) avant le premier commit.
    await Bun.sleep(20);

    // Le commit worker : ce que `returning` rend, puis le hint post-commit.
    rows.push({ ...base, ...identity, cursor: "7", leaseGeneration: "2", occurredAt });
    const wake = internalEventRoutes(fakeDb(rows), testInternalSecrets("api", "worker-secret"), hub);
    const workerEnvelope = organizationEventEnvelope({
      ...base, cursor: "7", ...identity, leaseGeneration: "2", occurredAt,
    });
    const hinted = await wake.request("http://localhost/publish", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
      body: JSON.stringify(workerEnvelope),
    });
    expect(hinted.status).toBe(204);
    const liveFrame = await nextDataFrame(liveReader, liveBuffer);

    // Connexion de reprise : ouverte APRÈS le commit, la ligne vient du rejeu.
    const replayed = await app.request("http://localhost/?cursor=0");
    const replayReader = replayed.body!.getReader();
    const replayFrame = await nextDataFrame(replayReader, { text: "" });

    await liveReader.cancel();
    await replayReader.cancel();

    expect(liveFrame).toBe(replayFrame);
    expect(liveFrame).toBe(JSON.stringify(workerEnvelope));
    expect(JSON.parse(liveFrame)).toEqual({
      version: 1, cursor: 7, ...base, ...identity, leaseGeneration: 2,
      occurredAt: "2026-10-03T12:00:00.000Z",
    });
  });

  test("une ligne d'avant 0092 se rejoue avec une identité nulle", async () => {
    const rows: StoredRow[] = [{
      ...base, cursor: "3", botId: null, turnId: null, sessionKey: null, leaseGeneration: null, occurredAt,
    }];
    const app = sseApp(fakeDb(rows), new EventHub());
    const response = await app.request("http://localhost/?cursor=0");
    const reader = response.body!.getReader();
    const frame = JSON.parse(await nextDataFrame(reader, { text: "" }));
    await reader.cancel();
    expect(frame).toMatchObject({ version: 1, cursor: 3, botId: null, turnId: null, leaseGeneration: null });
  });
});
