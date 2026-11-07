import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { persistEvents } from "../../src/application/runner/persist";
import type { WorkerConfig } from "../../src/application/worker-config";
import type { RunEvent } from "../../src/domain/hermes-events";

const organizationId = "00000000-0000-4000-8000-000000000001";
const html = "<!doctype html><html><body>semaine</body></html>";

describe("persistEvents : pièces du runtime", () => {
  test("copie un HTML write_file en attachments et en part du message", async () => {
    const root = await mkdtemp(join(tmpdir(), "openedbot-artifacts-"));
    const messages: unknown[] = [];
    const attachments: unknown[] = [];
    const payloads: unknown[] = [];
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("insert into run_events")) {
        payloads.push(values[5]);
        return Promise.resolve([{
          cursor: "1",
          botId: "bot-1",
          turnId: "run-1",
          sessionKey: "openedbot:org:thread",
          leaseGeneration: "1",
        }]);
      }
      if (sql.includes("insert into messages")) {
        messages.push(values[4]);
        return Promise.resolve([]);
      }
      if (sql.includes("insert into attachments")) {
        attachments.push({
          id: values[0],
          name: values[5],
          contentType: values[6],
          kind: values[7],
          bytes: values[8],
          objectKey: values[3],
        });
        return Promise.resolve([]);
      }
      if (sql.includes("select id from runs")) return Promise.resolve([{ id: "run-1" }]);
      return Promise.resolve([]);
    };
    const db = {
      begin: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as SQL;
    const config = {
      workerId: "worker-1",
      apiInternalUrl: "http://api.test",
      internalSecrets: testInternalSecrets("worker", "tok"),
      blob: { driver: "file" as const, root },
    } as WorkerConfig;
    const context = {
      id: "run-1",
      organizationId,
      threadId: "thread-1",
      botId: "bot-1",
      botName: "Neo",
      botSlug: "neo",
      sessionId: "openedbot:org:thread",
      leaseGeneration: 1,
      workflowId: null,
      workflowRootRunId: null,
      groupId: null,
      groupTurnPosition: null,
      groupState: null,
      stepKind: "root",
      originRunId: null,
      provider: null,
      runtimeId: "rt-1",
    };
    const event: RunEvent = {
      sequence: 1,
      type: "run.completed",
      occurredAt: new Date("2026-10-07T12:00:00.000Z"),
      payload: {
        output: "voici la page",
        turnMessages: [{
          role: "assistant",
          tool_calls: [{
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "/root/actualite-ia-semaine.html", content: html }),
            },
          }],
        }],
      },
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    try {
      await persistEvents(db, config, context as never, 1, [event]);
    } finally {
      globalThis.fetch = original;
    }

    expect(payloads[0]).toEqual({ output: "voici la page" });
    expect(messages[0]).toEqual([
      { type: "text", text: "voici la page" },
      expect.objectContaining({
        type: "attachment",
        name: "actualite-ia-semaine.html",
        contentType: "text/html",
        kind: "document",
        bytes: new TextEncoder().encode(html).byteLength,
      }),
    ]);
    expect(attachments).toHaveLength(1);
    const stored = attachments[0] as {
      id: string;
      objectKey: string;
      name: string;
      contentType: string;
      kind: string;
    };
    expect(stored).toMatchObject({
      name: "actualite-ia-semaine.html",
      contentType: "text/html",
      kind: "document",
    });
    const onDisk = await readFile(join(root, stored.objectKey), "utf8");
    expect(onDisk).toBe(html);
  });
});

describe("persistEvents : revue d'un run sans étape de workflow (0175)", () => {
  async function persistReviewed(context: Record<string, unknown>, event: RunEvent) {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      statements.push({ sql, values });
      if (sql.includes("insert into run_events")) {
        return Promise.resolve([{ cursor: "1", botId: "bot-1", turnId: "run-1", sessionKey: "s", leaseGeneration: "1" }]);
      }
      if (sql.includes("select id from runs")) return Promise.resolve([{ id: "run-1" }]);
      if (sql.includes("gm.position >")) return Promise.resolve([{ botId: "bot-2", position: 2 }]);
      return Promise.resolve([]);
    };
    const db = { begin: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as SQL;
    const config = { workerId: "worker-1", apiInternalUrl: "http://api.test", internalSecrets: testInternalSecrets("worker", "tok")} as WorkerConfig;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    try {
      await persistEvents(db, config, {
        id: "run-1", organizationId, threadId: "thread-1", botId: "bot-1", botName: "Neo", botSlug: "neo",
        sessionId: "s", leaseGeneration: 1, workflowId: "review-1", workflowRootRunId: "run-1",
        groupId: null, groupTurnPosition: null, groupState: null, stepKind: null, originRunId: null,
        provider: null, runtimeId: "rt-1", input: "legacy input", ...context,
      } as never, 1, [event]);
    } finally {
      globalThis.fetch = original;
    }
    const settled = statements.find(({ sql }) => sql.includes("update workflows set status = ?"));
    return { statements, settled };
  }
  const completed = (output: string): RunEvent => ({
    sequence: 1, type: "run.completed", occurredAt: new Date("2026-11-06T12:00:00.000Z"),
    payload: { output, reconciled: true },
  });

  test("un brouillon de persona réconcilié clôt sa revue, sans bulle ni directive", async () => {
    const { statements, settled } = await persistReviewed({ threadId: "draft-thread", stepKind: "persona_draft" },
      completed("Tu es Neo. @trinity vérifie."));
    expect(settled?.values.slice(0, 3)).toEqual(["completed", null, null]);
    expect(settled?.values.slice(-2)).toEqual([organizationId, "review-1"]);
    expect(settled?.sql).toContain("status in ('queued','running','awaiting_approval','reconciling')");
    expect(statements.some(({ sql }) => sql.includes("insert into messages"))).toBe(false);
    expect(statements.some(({ sql }) => sql.includes("insert into runs"))).toBe(false);
  });

  test("un tour de salon hérité réconcilié clôt sa revue, puis le membre suivant parle hors workflow", async () => {
    const { statements, settled } = await persistReviewed({ groupId: "group-1", groupTurnPosition: 1 }, completed("bonjour"));
    expect(settled?.values.slice(0, 3)).toEqual(["completed", null, null]);
    const next = statements.find(({ sql }) => sql.includes("insert into runs"));
    expect(next?.values).toContain("bot-2");
    expect(next?.values).not.toContain("review-1");
  });

  test("un tour de salon hérité réconcilié en échec clôt sa revue en échec", async () => {
    const { settled } = await persistReviewed({ groupId: "group-1", groupTurnPosition: 1 }, {
      sequence: 1, type: "run.error", occurredAt: new Date("2026-11-06T12:00:00.000Z"),
      payload: { message: "Échec Hermes.", errorCode: "HERMES_RUN_FAILED", reconciled: true },
    });
    expect(settled?.values.slice(0, 3)).toEqual(["failed", "HERMES_RUN_FAILED", "Échec Hermes."]);
  });
});
