import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import { EventHub } from "../../modules/notifications/src/application/event-hub";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { persistEvents } from "../../modules/execution/src/application/runner";
import { HermesEventNormalizer } from "../../modules/execution/src/domain/hermes-events";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import { eventRoutes, internalEventRoutes } from "../../apps/api/src/routes/events/event-routes";
import { acceptLiveEvent, createLiveDedupe } from "../../apps/console/src/lib/stream/thread-stream-live";
import { withDisposablePostgres } from "./disposable-postgres";

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

function within<T>(promise: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

type SseFrame = { id: number | null; event: string; data: Record<string, unknown> };
type SseReader = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  text: string;
};

async function openSse(app: Hono<{ Variables: AppVariables }>, organizationId: string, cursor = 0): Promise<SseReader> {
  const response = await app.request(`http://fast-path.integration/api/events?cursor=${cursor}`, {
    headers: { Accept: "text/event-stream", "X-Test-Organization": organizationId },
  });
  assert(response.status === 200, `SSE status ${response.status}`);
  assert(response.headers.get("content-type")?.startsWith("text/event-stream"), "SSE content type missing");
  assert(response.body, "SSE body missing");
  const stream: SseReader = { reader: response.body.getReader(), decoder: new TextDecoder(), text: "" };
  try {
    const first = await within(stream.reader.read(), "SSE connected frame");
    assert(!first.done && first.value, "SSE closed before connected frame");
    stream.text += stream.decoder.decode(first.value, { stream: true });
    assert(stream.text.includes(": connected\n\n"), "SSE did not send its connected frame");
    stream.text = stream.text.replace(": connected\n\n", "");
    return stream;
  } catch (error) {
    await within(stream.reader.cancel(), "SSE opening cleanup", 1_000).catch(() => undefined);
    throw error;
  }
}

async function nextSseFrame(stream: SseReader): Promise<SseFrame> {
  for (;;) {
    const boundary = stream.text.indexOf("\n\n");
    if (boundary >= 0) {
      const raw = stream.text.slice(0, boundary);
      stream.text = stream.text.slice(boundary + 2);
      if (!raw || raw.split("\n").every((line) => line.startsWith(":"))) continue;
      const lines = raw.split("\n");
      const idLine = lines.find((line) => line.startsWith("id:"));
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      assert(eventLine && dataText, "SSE frame is missing its event or data");
      const id = idLine ? Number(idLine.slice(3).trim()) : null;
      assert(id === null || Number.isSafeInteger(id), "SSE cursor is not a safe integer");
      const data = JSON.parse(dataText) as Record<string, unknown>;
      return { id, event: eventLine.slice(6).trim(), data };
    }
    const chunk = await stream.reader.read();
    if (chunk.done) throw new Error("SSE closed before the expected event");
    stream.text += stream.decoder.decode(chunk.value, { stream: true });
  }
}

async function assertNoFrame(pending: Promise<unknown>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      pending.then((value) => ({ kind: "frame" as const, value }), (error: unknown) => ({ kind: "error" as const, error })),
      new Promise<{ kind: "wait" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "wait" }), 60); }),
    ]);
  assert(result.kind === "wait", `${label}: an unexpected event was received`);
  } finally {
    clearTimeout(timer);
  }
}

function pauseAfterRunEventInsert(
  db: Parameters<typeof persistEvents>[0],
  onInsert: () => void,
  release: Promise<void>,
  insertStatement = "insert into run_events",
): Parameters<typeof persistEvents>[0] {
  const originalBegin = db.begin.bind(db) as unknown as (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
  let paused = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "begin") {
        return (callback: (transaction: unknown) => Promise<unknown>) => originalBegin(async (transaction) => {
          const query = transaction as (...args: unknown[]) => unknown;
          const barrierQuery = new Proxy(query, {
            apply: (targetQuery, thisArg, args) => {
              const queryResult = Reflect.apply(targetQuery, thisArg, args);
              const strings = args[0];
              // SQL builders such as tx(ids) are synchronous fragments. Wrapping
              // them in a Promise changes the statement being tested.
              if (!Array.isArray(strings) || !("raw" in strings)) return queryResult;
              const statement = strings.join(" ").toLowerCase();
              // A tagged query can also be a nested SQL fragment. Only the
              // actual INSERT being held may be executed by this barrier.
              if (paused || !statement.includes(insertStatement)) return queryResult;
              return Promise.resolve(queryResult).then(async (result) => {
                paused = true;
                onInsert();
                await release;
                return result;
              });
            },
          });
          return callback(barrierQuery);
        });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Parameters<typeof persistEvents>[0];
}

function eventBody(frame: SseFrame): Record<string, unknown> {
  return {
    organizationId: frame.data.organizationId,
    threadId: frame.data.threadId,
    runId: frame.data.runId,
    botId: frame.data.botId,
    turnId: frame.data.turnId,
    sessionKey: frame.data.sessionKey,
    leaseGeneration: frame.data.leaseGeneration,
    sequence: frame.data.sequence,
    type: frame.data.type,
    payload: frame.data.payload,
    occurredAt: frame.data.occurredAt,
  };
}

async function main(): Promise<void> {
  await withDisposablePostgres("openedbot115_stream", async ({ owner, connect }) => {
    const organizationId = crypto.randomUUID();
    const otherOrganizationId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    const botId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const workerId = `openedbot115-${crypto.randomUUID()}`;
    const sessionId = `openedbot115-session-${crypto.randomUUID()}`;
    const leaseGeneration = 4;

    await owner`insert into organizations (id, slug, name)
      values (${organizationId}, ${`stream-${organizationId.slice(0, 8)}`}, 'Stream test'),
             (${otherOrganizationId}, ${`other-${otherOrganizationId.slice(0, 8)}`}, 'Other stream test')`;
    await owner`insert into sections (id, organization_id, name, position)
      values (${sectionId}, ${organizationId}, 'Integration', 0)`;
    await owner`insert into bots (id, organization_id, section_id, name, slug, position)
      values (${botId}, ${organizationId}, ${sectionId}, 'Fast path test', 'fast-path-test', 0)`;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${threadId}, ${organizationId}, ${botId}, 'Fast path', ${sessionId}, true)`;
    await owner`insert into runs (
      id, organization_id, thread_id, bot_id, input, status, started_at, heartbeat_at,
      lease_owner, lease_expires_at, lease_generation, external_state, step_index, step_kind, execution_session_key
    ) values (
      ${runId}, ${organizationId}, ${threadId}, ${botId}, 'integration event', 'running', now(), now(),
      ${workerId}, now() + interval '2 minutes', ${leaseGeneration}, 'streaming', 0, 'root', ${sessionId}
    )`;

    const apiDb = await connect("openedbot_api");
    const workerDb = await connect("openedbot_worker");
    await workerDb`select set_config('app.organization_id', ${organizationId}, false)`;

    const hub = new EventHub();
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => {
      const selectedOrganization = context.req.header("X-Test-Organization") ?? organizationId;
      context.set("auth", { organizationId: selectedOrganization } as AppVariables["auth"]);
      await next();
    });
    app.route("/api/events", eventRoutes(apiDb, hub, {
      fallbackPollMs: 60_000,
      replayWindowMs: 3_600_000,
      // Two events: the connection advances its cursor as soon as one row is
      // skipped (half the window), not at the heartbeat.
      replayWindowEvents: 2,
    }));
    const internalToken = `integration-${crypto.randomUUID()}`;
    app.route("/internal/events", internalEventRoutes(apiDb, testInternalSecrets("api", internalToken), hub));

    const apiOrigin = "http://fast-path.integration";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith(apiOrigin) ? app.request(url, init) : originalFetch(input, init);
    }) as typeof fetch;

    const live: SseReader[] = [];
    let releaseInsert!: () => void;
    let reachedInsert!: () => void;
    const released = new Promise<void>((resolve) => { releaseInsert = resolve; });
    const insertReached = new Promise<void>((resolve) => { reachedInsert = resolve; });
    let persistence: Promise<void> | undefined;
    let otherTenantPending: Promise<unknown> | undefined;
    const releaseGates: Array<() => void> = [releaseInsert];
    try {
      const stream = await openSse(app, organizationId);
      live.push(stream);
      const otherStream = await openSse(app, otherOrganizationId);
      live.push(otherStream);
      otherTenantPending = nextSseFrame(otherStream);
      void otherTenantPending.catch(() => undefined);

      const events = [1, 2].map((sequence) => ({
        sequence,
        type: "agent.message",
        payload: { delta: `fragment-${sequence}` },
        occurredAt: new Date(Date.now() + sequence),
      }));
      const context = {
        id: runId,
        organizationId,
        threadId,
        botId,
        sessionId,
        leaseGeneration,
        workflowId: null,
        workflowRootRunId: null,
        stepKind: "root",
        groupTurnPosition: null,
        groupId: null,
        groupState: null,
        originRunId: null,
      };
      const workerConfig = {
        workerId,
        apiInternalUrl: apiOrigin,
        internalSecrets: testInternalSecrets("worker", internalToken),
      } as WorkerConfig;
      const blockedWorkerDb = pauseAfterRunEventInsert(workerDb, reachedInsert, released);
      persistence = persistEvents(blockedWorkerDb, workerConfig, context as never, 2, events as never[]);

      await within(insertReached, "real run_events INSERT barrier");
      const earlyFrames = await Promise.all([
        within(nextSseFrame(stream), "first cursorless event"),
        within(nextSseFrame(stream), "second cursorless event"),
      ]);
      assert(earlyFrames.every((frame) => frame.id === null), "A pre-commit event carried an SSE id");
      assert(earlyFrames.every((frame) => frame.event === "agent.message"), "Unexpected pre-commit SSE event type");
      assert(earlyFrames.map((frame) => frame.data.sequence).join(",") === "1,2", "Pre-commit sequence was not ordered");
      assert(earlyFrames.every((frame) => frame.data.organizationId === organizationId), "Pre-commit tenant identity changed");
      assert(earlyFrames.every((frame) => frame.data.runId === runId && frame.data.turnId === runId), "Pre-commit run or turn identity changed");
      assert(earlyFrames.every((frame) => frame.data.botId === botId && frame.data.sessionKey === sessionId), "Pre-commit bot/session identity changed");
      assert(earlyFrames.every((frame) => frame.data.leaseGeneration === leaseGeneration), "Pre-commit lease identity changed");

      const visibleRows = await owner<Array<{ count: number }>>`select count(*)::int as count from run_events where run_id = ${runId}`;
      assert(visibleRows[0]?.count === 0, "The event INSERT became visible before its transaction committed");
      await assertNoFrame(otherTenantPending, "pre-commit fanout");

      releaseInsert();
      await within(persistence, "persistEvents commit");
      const durableRows = await owner<Array<{
        cursor: string;
        sequence: number;
        runId: string;
        botId: string;
        turnId: string;
        sessionKey: string;
        leaseGeneration: string;
        occurredAt: Date;
      }>>`select cursor::text as cursor, sequence, run_id as "runId", bot_id as "botId", turn_id as "turnId",
          session_key as "sessionKey", lease_generation::text as "leaseGeneration", occurred_at as "occurredAt"
        from run_events where organization_id = ${organizationId} and run_id = ${runId} order by cursor`;
      assert(durableRows.length === 2, "The real transaction did not persist both events");
      assert(durableRows[0]!.sequence === 1 && durableRows[1]!.sequence === 2, "Durable sequence is not ordered");
      assert(durableRows.every((row) => row.runId === runId && row.turnId === runId && row.botId === botId), "Durable identity changed");
      assert(durableRows.every((row) => row.sessionKey === sessionId && Number(row.leaseGeneration) === leaseGeneration), "Durable session or lease identity changed");
      for (let index = 0; index < 2; index += 1) {
        assert(earlyFrames[index]!.data.occurredAt === events[index]!.occurredAt.toISOString(),
          "Live timestamp differs from the normalized event");
        assert(durableRows[index]!.occurredAt.toISOString() === events[index]!.occurredAt.toISOString(),
          "PostgreSQL timestamp differs from the live event");
      }

      const cursor1 = Number(durableRows[0]!.cursor);
      const cursor2 = Number(durableRows[1]!.cursor);
      // The connection that already carried both frames live
      // receives their commit as a cursor advance, never a second copy.
      const cursorFrames = await Promise.all([
        within(nextSseFrame(stream), "first durable cursor"),
        within(nextSseFrame(stream), "second durable cursor"),
      ]);
      assert(cursorFrames.every((frame) => frame.event === "stream.cursor"),
        "The live connection received a committed copy of a frame it already carried");
      assert(cursorFrames[0]!.id === cursor1 && cursorFrames[1]!.id === cursor2 && cursor1 < cursor2,
        "Post-commit SSE cursors do not match the ordered PostgreSQL rows");
      // A connection that did not carry them live (opened after the commit,
      // from the start) receives the full committed frames.
      const committedStream = await openSse(app, organizationId, 0);
      live.push(committedStream);
      const durableFrames = await Promise.all([
        within(nextSseFrame(committedStream), "first durable event"),
        within(nextSseFrame(committedStream), "second durable event"),
      ]);
      assert(durableFrames[0]!.id === cursor1 && durableFrames[1]!.id === cursor2,
        "Committed replay cursors do not match the ordered PostgreSQL rows");
      for (let index = 0; index < 2; index += 1) {
        assert(JSON.stringify(eventBody(durableFrames[index]!)) === JSON.stringify(eventBody(earlyFrames[index]!)),
          "Pre-commit and durable envelopes have different run identities or payloads");
      }

      const dedupe = createLiveDedupe();
      const earlyAccepted = acceptLiveEvent(dedupe, earlyFrames[0]!.data as never, organizationId, 0);
      const durableDuplicate = acceptLiveEvent(dedupe, durableFrames[0]!.data as never, organizationId, earlyAccepted.streamCursor);
      assert(earlyAccepted.deliver && !durableDuplicate.deliver && durableDuplicate.streamCursor === cursor1,
        "The durable copy was not deduplicable by the same event identity");
      const earlySecond = acceptLiveEvent(dedupe, earlyFrames[1]!.data as never, organizationId, durableDuplicate.streamCursor);
      const durableSecondDuplicate = acceptLiveEvent(dedupe, durableFrames[1]!.data as never, organizationId, earlySecond.streamCursor);
      assert(earlySecond.deliver && !durableSecondDuplicate.deliver && durableSecondDuplicate.streamCursor === cursor2,
        "The second durable copy was not deduplicable by the same event identity");

      await assertNoFrame(otherTenantPending, "post-commit replay");

      const resumed = await openSse(app, organizationId, cursor1);
      live.push(resumed);
      const afterCursor = await within(nextSseFrame(resumed), "cursor replay");
      assert(afterCursor.id === cursor2 && afterCursor.data.sequence === 2 && afterCursor.data.runId === runId,
        "Cursor replay did not return exactly the next durable event");
      assert(JSON.stringify(eventBody(afterCursor)) === JSON.stringify(eventBody(durableFrames[1]!)),
        "Cursor replay changed the durable envelope or payload");
      const resumedDuplicate = acceptLiveEvent(dedupe, afterCursor.data as never, organizationId, durableSecondDuplicate.streamCursor);
      assert(!resumedDuplicate.deliver && resumedDuplicate.streamCursor === cursor2,
        "A replayed event did not deduplicate with its original live identity");

      const fenceStream = await openSse(app, organizationId, cursor2);
      live.push(fenceStream);
      const fencePending = nextSseFrame(fenceStream);
      // The obsolete publisher must not poison client deduplication with a
      // cursorless copy that the later SQL fence would refuse.
      for (const overrides of [{ leaseGeneration: leaseGeneration - 1 }, { threadId: crypto.randomUUID() },
        { runId: crypto.randomUUID() }, { organizationId: otherOrganizationId }]) {
        const response = await app.request(`${apiOrigin}/internal/events/publish`, {
          method: "POST",
          headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...earlyFrames[0]!.data, sequence: 99, ...overrides }),
        });
        assert(response.status === 204, "Obsolete provisional event was not safely acknowledged");
        await assertNoFrame(fencePending, "obsolete run or lease fanout");
      }
      await fenceStream.reader.cancel();
      await fencePending.catch(() => undefined);

      const sentinel = "fixture-private-credential-value";
      const normalizer = new HermesEventNormalizer(3);
      const privateEvents = [
        ...normalizer.push({ event: "tool.started", run_id: runId, tool: "web", timestamp: 1,
          preview: `search public docs ${JSON.stringify({ apiKey: sentinel })}` }),
        ...normalizer.push({ event: "internal.coordination", run_id: runId, timestamp: 2, privateState: { sentinel } }),
      ];
      await persistEvents(workerDb, workerConfig, context as never, 4, privateEvents);
      const privacyFrames: SseFrame[] = [];
      while (privacyFrames.length < 4) privacyFrames.push(await within(nextSseFrame(stream), "redacted event"));
      assert(!JSON.stringify(privacyFrames).includes(sentinel), "Live or committed fanout leaked private runtime data");
      assert(privacyFrames.some((frame) => JSON.stringify(frame.data.payload).includes("[redacted]")),
        "The live display preview was not redacted");
      const privateRows = await owner<Array<{ cursor: string; payload: unknown; type: string }>>`
        select cursor::text as cursor, payload, type from run_events where run_id = ${runId} and sequence >= 3 order by cursor`;
      assert(privateRows.length === 2 && !JSON.stringify(privateRows).includes(sentinel),
        "Private runtime data reached PostgreSQL");
      const privacyReplay = await openSse(app, organizationId, cursor2);
      live.push(privacyReplay);
      const replayedPrivate = [await within(nextSseFrame(privacyReplay), "redacted preview replay"),
        await within(nextSseFrame(privacyReplay), "private event marker replay")];
      assert(!JSON.stringify(replayedPrivate).includes(sentinel), "Replay leaked private runtime data");
      assert(replayedPrivate.map((frame) => frame.event).join(",") === "tool.call,raw", "Redaction changed event ordering or types");

      if (process.env.OPENEDBOT_TEST_116_CANONICAL_CASE !== "terminal") {
        const approvalRunId = crypto.randomUUID();
        const approvalBotId = crypto.randomUUID();
        const approvalThreadId = crypto.randomUUID();
        const approvalSessionId = `approval-${crypto.randomUUID()}`;
        await owner`insert into bots (id, organization_id, section_id, name, slug, position)
          values (${approvalBotId}, ${organizationId}, ${sectionId}, 'Approval fixture', 'approval-fixture', 1)`;
        await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
          values (${approvalThreadId}, ${organizationId}, ${approvalBotId}, 'Approval fixture', ${approvalSessionId}, true)`;
        await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, lease_owner,
          lease_generation, lease_expires_at, external_state)
          values (${approvalRunId}, ${organizationId}, ${approvalThreadId}, ${approvalBotId}, 'fixture approval', 'running',
            ${workerId}, ${leaseGeneration}, now() + interval '2 minutes', 'streaming')`;
        const approvalStream = await openSse(app, organizationId, Number(privateRows[1]!.cursor));
        live.push(approvalStream);
        const pendingApproval = nextSseFrame(approvalStream);
        void pendingApproval.catch(() => undefined);
        let reachApproval!: () => void;
        let releaseApproval!: () => void;
        const atApproval = new Promise<void>((resolve) => { reachApproval = resolve; });
        const allowApproval = new Promise<void>((resolve) => { releaseApproval = resolve; });
        releaseGates.push(releaseApproval);
        const approvalNormalizer = new HermesEventNormalizer();
        const approval = approvalNormalizer.push({ event: "approval.request", run_id: approvalRunId,
          timestamp: Date.now() / 1_000, command: `fixture action ${JSON.stringify({ token: sentinel })}`,
          description: JSON.stringify({ password: sentinel }), choices: ["once", "deny", { privateState: sentinel }],
          request_id: "fixture-request-1", pattern_key: "recursive delete", pattern_keys: ["recursive delete"] });
        const approvalDb = pauseAfterRunEventInsert(workerDb, reachApproval, allowApproval, "insert into approval_requests");
        persistence = persistEvents(approvalDb, workerConfig, { ...context, id: approvalRunId,
          threadId: approvalThreadId, botId: approvalBotId, sessionId: approvalSessionId } as never, 1, approval);
        void persistence.catch(() => undefined);
        await within(Promise.race([atApproval, persistence.then(() => { throw new Error("Approval receipt barrier was not reached"); })]),
          "approval receipt INSERT");
        await assertNoFrame(pendingApproval, "approval before receipt commit");
        const uncommittedGates = await owner<Array<{ count: number }>>`
          select count(*)::int as count from approval_requests where run_id = ${approvalRunId}`;
        assert(uncommittedGates[0]?.count === 0, "The approval receipt became visible before commit");
        releaseApproval();
        await within(persistence, "approval receipt commit");
        const approvedFrame = await within(pendingApproval, "durable approval event");
        const approvalReceipt = (await owner<Array<{ id: string; status: string; command: string; description: string;
          hermesRequestId: string | null; gateKind: string; gateArgs: Record<string, unknown> | null }>>`
          select id, status, command, description, hermes_request_id as "hermesRequestId", gate_kind as "gateKind",
                 gate_args as "gateArgs"
            from approval_requests where run_id = ${approvalRunId}`)[0];
        const payload = approvedFrame.data.payload as Record<string, unknown>;
        assert(approvedFrame.event === "approval.requested" && approvedFrame.id !== null,
          "Approval was published without its durable cursor");
        assert(approvalReceipt?.id === payload.approvalRequestId && approvalReceipt?.status === "pending",
          "Approval event and SQL receipt have different UUID identities");
        assert(!JSON.stringify([approvedFrame, approvalReceipt]).includes(sentinel),
          "Approval display fields leaked a private credential in the stream or receipt");
        // PERM2-A: the gate identity lands on the receipt, never in the stream.
        assert(approvalReceipt?.hermesRequestId === "fixture-request-1" && approvalReceipt?.gateKind === "terminal_danger"
          && approvalReceipt?.gateArgs?.patternKey === "recursive delete",
          "Approval receipt lost the Hermes gate identity");
        assert(!("gate" in payload), "The gate identity vehicle reached the published approval event");


        const approvalContext = { ...context, id: approvalRunId, threadId: approvalThreadId,
          botId: approvalBotId, sessionId: approvalSessionId };
        const failure = approvalNormalizer.push({ event: "run.failed", run_id: approvalRunId,
          timestamp: Date.now() / 1_000, message: "fixture failure" });
        await persistEvents(workerDb, workerConfig, approvalContext as never, 2, failure);
        const errorFrame = await within(nextSseFrame(approvalStream), "durable run error");
        assert(errorFrame.event === "run.error" && errorFrame.id !== null, "Run error escaped before its durable cursor");
        const errorProjection = await owner<Array<{ cursor: string; status: string; endedAt: string; errorCode: string }>>`
          select event.cursor::text as cursor, run.status, run.ended_at::text as "endedAt", run.error_code as "errorCode"
          from run_events event join runs run on run.id = event.run_id
          where event.run_id = ${approvalRunId} and event.type = 'run.error'`;
        assert(errorProjection.length === 1 && errorProjection[0]?.status === "failed", "Run error was not durably projected");
        await persistEvents(workerDb, workerConfig, approvalContext as never, 2, failure);
        const repeatedError = await owner<Array<{ cursor: string; status: string; endedAt: string; errorCode: string }>>`
          select event.cursor::text as cursor, run.status, run.ended_at::text as "endedAt", run.error_code as "errorCode"
          from run_events event join runs run on run.id = event.run_id
          where event.run_id = ${approvalRunId} and event.type = 'run.error'`;
        assert(JSON.stringify(repeatedError) === JSON.stringify(errorProjection), "Repeated run error changed its cursor or terminal projection");

        // Éditeur d'agent (0099) : en « Tout autoriser », le worker répond
        // « once » à la place de l'opérateur et la ligne dit quelle politique
        // a répondu (0100) ; le journal hash-chaîné reste fermé au worker (0080).
        const bypassBotId = crypto.randomUUID();
        const bypassThreadId = crypto.randomUUID();
        const bypassRunId = crypto.randomUUID();
        const bypassSessionId = `bypass-${crypto.randomUUID()}`;
        await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
          values (${bypassBotId}, ${organizationId}, ${sectionId}, 'Bypass fixture', 'bypass-fixture', 2, 'bypass')`;
        await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
          values (${bypassThreadId}, ${organizationId}, ${bypassBotId}, 'Bypass fixture', ${bypassSessionId}, true)`;
        await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, lease_owner,
          lease_generation, lease_expires_at, external_state)
          values (${bypassRunId}, ${organizationId}, ${bypassThreadId}, ${bypassBotId}, 'fixture bypass', 'running',
            ${workerId}, ${leaseGeneration}, now() + interval '2 minutes', 'streaming')`;
        const bypassApproval = new HermesEventNormalizer().push({ event: "approval.request", run_id: bypassRunId,
          timestamp: Date.now() / 1_000, command: "rm -rf /tmp/fixture", description: "fixture", choices: ["once", "deny"] });
        await persistEvents(workerDb, workerConfig, { ...context, id: bypassRunId, threadId: bypassThreadId,
          botId: bypassBotId, sessionId: bypassSessionId, permissionMode: "bypass" } as never, 1, bypassApproval);
        const bypassReceipt = (await owner<Array<{ status: string; choice: string | null; forwardState: string; policy: string | null; resolvedBy: string | null }>>`
          select status, selected_choice as choice, forward_state as "forwardState",
                 resolved_by_policy as policy, resolved_by::text as "resolvedBy"
            from approval_requests where run_id = ${bypassRunId}`)[0];
        assert(bypassReceipt?.status === "approved" && bypassReceipt.choice === "once" && bypassReceipt.forwardState === "ready",
          "A bypass bot's approval was not answered by the worker");
        assert(bypassReceipt.policy === "bypass" && bypassReceipt.resolvedBy === null,
          "The bypass approval does not say which policy answered it");
        const errorReplay = await openSse(app, organizationId, approvedFrame.id!);
        live.push(errorReplay);
        const replayedError = await within(nextSseFrame(errorReplay), "run error replay");
        assert(JSON.stringify(eventBody(errorFrame)) === JSON.stringify(eventBody(replayedError)),
          "Live error and replay have different canonical envelopes");
      }

      const lastCursor = Number((await owner<Array<{ cursor: string }>>`
        select max(cursor)::text as cursor from run_events where organization_id = ${organizationId}`)[0]!.cursor);
      const terminalStream = await openSse(app, organizationId, lastCursor);
      live.push(terminalStream);
      const pendingTerminal = nextSseFrame(terminalStream);
      void pendingTerminal.catch(() => undefined);
      let reachTerminal!: () => void;
      let releaseTerminal!: () => void;
      const atTerminal = new Promise<void>((resolve) => { reachTerminal = resolve; });
      const allowTerminal = new Promise<void>((resolve) => { releaseTerminal = resolve; });
      releaseGates.push(releaseTerminal);
      const terminal = normalizer.push({ event: "run.completed", run_id: runId, timestamp: 3, output: "fixture complete" });
      persistence = persistEvents(pauseAfterRunEventInsert(workerDb, reachTerminal, allowTerminal), workerConfig,
        context as never, 5, terminal);
      void persistence.catch(() => undefined);
      await within(Promise.race([atTerminal, persistence.then(() => { throw new Error("Terminal barrier was not reached"); })]),
        "terminal INSERT");
      await assertNoFrame(pendingTerminal, "terminal before commit");
      const beforeTerminalCommit = (await owner<Array<{ status: string; messages: number }>>`
        select status, (select count(*)::int from messages where run_id = ${runId} and role = 'assistant') as messages
        from runs where id = ${runId}`)[0];
      assert(beforeTerminalCommit?.status === "running" && beforeTerminalCommit.messages === 0,
        "The terminal projection became visible before its event committed");
      releaseTerminal();
      await within(persistence, "terminal commit");
      const terminalFrame = await within(pendingTerminal, "durable terminal");
      const terminalBefore = (await owner<Array<{ cursor: string; endedAt: string; status: string; messages: number }>>`
        select event.cursor::text as cursor, run.ended_at::text as "endedAt", run.status,
          (select count(*)::int from messages where run_id = ${runId} and role = 'assistant') as messages
        from run_events event join runs run on run.id = event.run_id
        where event.run_id = ${runId} and event.type = 'run.completed'`)[0];
      assert(terminalBefore?.status === "completed" && terminalBefore.messages === 1, "Terminal projection did not create exactly one final message");
      assert(terminalFrame.event === "run.completed" && terminalFrame.id === Number(terminalBefore.cursor),
        "Terminal fanout did not use its committed SQL cursor");
      const terminalReplay = await openSse(app, organizationId, lastCursor);
      live.push(terminalReplay);
      const replayedTerminal = await within(nextSseFrame(terminalReplay), "terminal replay");
      assert(JSON.stringify(eventBody(terminalFrame)) === JSON.stringify(eventBody(replayedTerminal)),
        "Live terminal and replay have different enriched envelopes");
      await persistEvents(workerDb, workerConfig, context as never, 5, terminal);
      const terminalAfter = await owner<Array<{ cursor: string; endedAt: string; status: string; messages: number }>>`
        select event.cursor::text as cursor, run.ended_at::text as "endedAt", run.status,
          (select count(*)::int from messages where run_id = ${runId} and role = 'assistant') as messages
        from run_events event join runs run on run.id = event.run_id
        where event.run_id = ${runId} and event.type = 'run.completed'`;
      assert(terminalAfter.length === 1 && JSON.stringify(terminalAfter[0]) === JSON.stringify(terminalBefore),
        "A replayed terminal changed its cursor, timestamp or final message projection");
      await assertNoFrame(otherTenantPending, "redacted events and terminal");
    } finally {
      for (const release of releaseGates) release();
      await within(persistence?.catch(() => undefined) ?? Promise.resolve(), "Persistence cleanup")
        .catch(() => workerDb.close({ timeout: 1 }));
      globalThis.fetch = originalFetch;
      await Promise.all(live.map((stream) => within(stream.reader.cancel(), "SSE cleanup", 1_000).catch(() => undefined)));
      await within(otherTenantPending?.catch(() => undefined) ?? Promise.resolve(), "Other tenant cleanup", 1_000)
        .catch(() => undefined);
    }
  });
}

await main();
console.log("Fast-path stream integration passed: pre-commit fanout, durable cursors and timestamps, cursor replay, tenant isolation, redacted previews/private diagnostics, durable UUID approval receipt, post-commit idempotent terminal.");
