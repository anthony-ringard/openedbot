import { isUuid } from "@openedbot/contracts-primitives";
import { hasLiveWorkspaceSession } from "@openedbot/identity/application/session-access";
import { Hono } from "hono";
import {
  organizationEventEnvelope,
  type OrganizationEvent,
  type RunEventRecord,
  type StreamCursor,
  type StreamGap as StreamGapFrame,
} from "@openedbot/contracts-events";
import {
  DEFAULT_EVENTS_FALLBACK_POLL_MS,
  DEFAULT_EVENTS_REPLAY_WINDOW_EVENTS,
  DEFAULT_EVENTS_REPLAY_WINDOW_MS,
  type EventsConfig,
} from "../../infrastructure/config";
import { matchInternalBearer, type InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";
import { internalAuthMetrics } from "@openedbot/platform-observability/internal-auth";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { attachTerminalCompletions } from "@openedbot/execution/application/terminal-event-completion";
import { logger } from "@openedbot/platform-observability";
import { SSE_HEARTBEAT_INTERVAL_MS } from "../../interfaces/http/sse-heartbeat";
import { fleetWorkspacesEnabled, type ProductFeatureSource } from "@openedbot/identity/application/entitlements";
import {
  acquireReplayPoller,
  REPLAY_LIMIT,
  shouldEmitSseCursor,
  wakeReplayPoller,
  type CursoredEvent,
} from "./replay-pollers";

export { SSE_HEARTBEAT_INTERVAL_MS };
export { createOrderedReplayPump, shouldEmitSseCursor, type CursoredEvent, type OrderedReplayPump } from "./replay-pollers";

/**
 * Seuil (en octets) de la file d'une connexion. Le rejeu attend qu'elle
 * repasse dessous avant chaque trame : il n'y dépose jamais plus que ce seuil
 * plus une trame, quel que soit le volume rejoué.
 */
export const SSE_QUEUE_HIGH_WATER_BYTES = 64 * 1024;
/**
 * Plafond de cette file pour le push live, qui ne peut pas attendre : au-delà,
 * le client est lent, reçoit `stream.gap` (`slow_consumer`) et la connexion
 * se ferme. Une trame seule plus grosse passe si la file est vide.
 *
 * Sous `Bun.serve` (1.3.14, mesuré), la réponse vide cette file dans un tampon
 * natif sans regarder le socket : `desiredSize` y reste au seuil même face à
 * un pair TCP bloqué. Le plafond borne la file JS et tout consommateur JS
 * (compression, proxy en JS, tests) ; le tampon natif, lui, n'est borné que
 * par `idleTimeout`, qui coupe le flux.
 */
export const SSE_MAX_QUEUED_BYTES = 1024 * 1024;
/**
 * Événements tenus en mémoire faute de pouvoir être écrits (live arrivé
 * pendant le rejeu ou pendant le contrôle d'accès) : même coupure au-delà.
 */
export const SSE_MAX_PENDING_EVENTS = 1_000;

type SlowConsumerReason = "queue_bytes" | "replay_buffer" | "access_buffer";

/** Trames live mémorisées par connexion pour ne pas rejouer leur commit. */
export const SSE_MAX_LIVE_PUSHED = 2_048;

/**
 * Identité d'une ligne `run_events` vue d'une trame, live ou commitée : run,
 * bail, séquence et type. Le bail distingue deux écritures d'une même séquence
 * par deux porteurs successifs.
 */
export function rowIdentity(event: OrganizationEvent): string {
  return `${event.runId}:${event.leaseGeneration ?? ""}:${event.sequence}:${event.type}`;
}

/** Fils au plus par `?threadId=` : au-delà, le flux d'organisation entier coûte moins. */
export const SSE_MAX_THREAD_FILTER = 50;

let slowConsumerClosures = 0;

/** Connexions fermées pour lenteur depuis le démarrage du process. */
export function sseSlowConsumerClosures(): number {
  return slowConsumerClosures;
}

/**
 * Réglages par défaut du flux, identiques à ceux de `readEventsConfig` : les
 * tests et tout appelant sans config lisent les mêmes valeurs que la prod.
 */
const DEFAULT_EVENTS: EventsConfig = {
  fallbackPollMs: DEFAULT_EVENTS_FALLBACK_POLL_MS,
  replayWindowMs: DEFAULT_EVENTS_REPLAY_WINDOW_MS,
  replayWindowEvents: DEFAULT_EVENTS_REPLAY_WINDOW_EVENTS,
};


export function eventRoutes(
  db: Db,
  hub: EventHub,
  events: EventsConfig = DEFAULT_EVENTS,
  agencyEnabled: ProductFeatureSource = false,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/", async (context) => {
    const auth = context.get("auth");
    const organizationId = auth.organizationId;
    const queryCursor = Number(context.req.query("cursor") ?? context.req.header("Last-Event-ID") ?? "0");
    if (!Number.isSafeInteger(queryCursor) || queryCursor < 0) {
      throw new HttpError(400, "CURSOR_INVALID", "Le curseur SSE est invalide.");
    }
    const threadFilter = readThreadFilter(context.req.queries("threadId"));

    let cursor = queryCursor;
    // Plus haut curseur reçu pour ce client, rendu ou non : la borne `to`
    // d'un trou `slow_consumer`.
    let newestSeen = queryCursor;
    // Plus haut curseur écarté par le filtre de fils : annoncé par
    // `stream.cursor` pour que la reprise ne rescanne pas ce qui a été écarté.
    let skippedCursor = 0;
    // Avance sans attendre le battement dès que l'écart mangerait la moitié
    // de la fenêtre de rejeu : sinon une reprise de ce client tomberait sous
    // le plancher et recevrait un `stream.gap` pour des fils qui ne sont pas
    // les siens.
    const cursorAdvanceEvents = Math.max(1, Math.floor(events.replayWindowEvents / 2));
    // Last-Event-ID is the last frame the client has confirmed. Replaying an
    // overlap here made a late poller frame emit a lower `id:` after a newer
    // one; replay strictly after the requested cursor keeps the SSE sequence
    // monotonic. Un curseur à zéro ne rejoue plus tout l'historique retenu :
    // il est ramené à une fenêtre récente (voir `effectiveReplayCursor`).
    const sentCursors = new Set<number>();
    // Trames live (sans curseur) déjà écrites sur CETTE connexion, par
    // identité de ligne. Le rejeu commité d'une de ces trames se réduit à
    // l'avance du curseur. Propre à la connexion : une reprise
    // ou une connexion ouverte entre le push et le commit n'en a aucune et
    // reçoit la trame complète. Borné ; une entrée évincée coûte un doublon
    // que la console absorbe, jamais une perte.
    const livePushed = new Set<string>();
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let releaseReplayPoller = () => {};
    let closed = false;
    let checkingAccess = false;
    let replaying = true;
    const accessBuffer: OrganizationEvent[] = [];
    // Subscribe BEFORE taking the replay watermark. While replay is in
    // progress, buffer live frames so a newer cursor cannot make `push`
    // suppress older replay frames. This also closes the gap when another
    // connection already owns (and advances) the organization's poller.
    const buffered: OrganizationEvent[] = [];
    let accessTimer: ReturnType<typeof setInterval> | null = null;
    let wakeReplay: (() => void) | null = null;

    const cleanup = () => {
      closed = true;
      accessBuffer.length = 0;
      buffered.length = 0;
      unsubscribe();
      unsubscribe = () => {};
      releaseReplayPoller();
      releaseReplayPoller = () => {};
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (accessTimer) clearInterval(accessTimer);
      accessTimer = null;
      wakeReplay?.();
      wakeReplay = null;
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (frame: string) => controller.enqueue(encoder.encode(frame));
        const queuedBytes = () => SSE_QUEUE_HIGH_WATER_BYTES - (controller.desiredSize ?? SSE_QUEUE_HIGH_WATER_BYTES);
        const accepts = (event: OrganizationEvent) => {
          if (matchesThreadFilter(threadFilter, event)) return true;
          if (typeof event.cursor === "number" && Number.isSafeInteger(event.cursor)) {
            skippedCursor = Math.max(skippedCursor, event.cursor);
          }
          if (skippedCursor - cursor >= cursorAdvanceEvents) advanceSkippedCursor();
          return false;
        };
        // Seulement hors rejeu et hors contrôle d'accès : rien d'accepté et
        // de plus ancien n'attend alors d'être écrit, avancer le curseur
        // au-delà ne saute aucun événement de ce client.
        const advanceSkippedCursor = () => {
          if (closed || replaying || checkingAccess || skippedCursor <= cursor) return false;
          if (queuedBytes() >= SSE_QUEUE_HIGH_WATER_BYTES) return false;
          cursor = skippedCursor;
          write(serializeCursor({ organizationId, cursor }));
          return true;
        };
        const noteSeen = (event: OrganizationEvent) => {
          if (typeof event.cursor === "number" && Number.isSafeInteger(event.cursor)) {
            newestSeen = Math.max(newestSeen, event.cursor);
          }
        };
        // Jamais de perte muette : ce qui est déjà en file part, puis le trou
        // `(cursor, newestSeen]`, puis la fin du flux. Le client se reconnecte
        // à son curseur et le rejeu reprend.
        const closeSlowConsumer = (reason: SlowConsumerReason) => {
          if (closed) return;
          const queued = queuedBytes();
          const pendingEvents = accessBuffer.length + buffered.length;
          const from = cursor;
          const to = newestSeen;
          if (to > from) write(serializeGap({ organizationId, from, to, reason: "slow_consumer" }));
          slowConsumerClosures += 1;
          logger.warn({
            event: "sse.slow_consumer_closed",
            organizationId,
            reason,
            queuedBytes: queued,
            pendingEvents,
            from,
            to,
            closedTotal: slowConsumerClosures,
          }, "sse slow consumer closed");
          cleanup();
          controller.close();
        };
        write(": connected\n\n");
        accessTimer = setInterval(() => {
          if (closed || checkingAccess) return;
          checkingAccess = true;
          void fleetWorkspacesEnabled(agencyEnabled, auth)
            .then((enabled) => hasLiveWorkspaceSession(db, auth, enabled))
            .catch(() => false)
            .then((allowed) => {
              checkingAccess = false;
              if (!allowed && !closed) {
                write(`event: stream.revoked\ndata: ${JSON.stringify({ organizationId, code: "WORKSPACE_ACCESS_REVOKED" })}\n\n`);
                cleanup();
                controller.close();
              }
              else if (!closed) {
                for (const event of accessBuffer.splice(0)) push(event);
                advanceSkippedCursor();
                wakeReplay?.();
                wakeReplay = null;
              }
            });
        }, 15_000);
        // `paced` : le rejeu a attendu que la file repasse sous le seuil, la
        // trame ne compte pas contre le plafond (un rejeu trop gros pour lui
        // ferait sinon boucler reconnexion et coupure).
        const push = (event: OrganizationEvent, paced = false) => {
          if (closed || !accepts(event)) return;
          noteSeen(event);
          if (checkingAccess) {
            if (accessBuffer.length >= SSE_MAX_PENDING_EVENTS) closeSlowConsumer("access_buffer");
            else accessBuffer.push(event);
            return;
          }
          const durableCursor = committedCursor(event);
          if (durableCursor !== null && (sentCursors.has(durableCursor) || !shouldEmitSseCursor(durableCursor, cursor))) return;
          const identity = rowIdentity(event);
          if (durableCursor !== null && livePushed.delete(identity)) {
            // Déjà livrée en live sur cette connexion : seul le curseur avance
            // (trame `stream.cursor`, au rythme du filtre de fils et du
            // battement), dans l'ordre du poller.
            sentCursors.add(durableCursor);
            skippedCursor = Math.max(skippedCursor, durableCursor);
            // Same bound as the emitting path: a long-lived connection fed by
            // live frames must not keep one cursor per frame until it closes.
            const horizon = Math.max(cursor, skippedCursor) - REPLAY_LIMIT;
            for (const seen of sentCursors) {
              if (seen < horizon) sentCursors.delete(seen);
            }
            if (skippedCursor - cursor >= cursorAdvanceEvents) advanceSkippedCursor();
            return;
          }
          const frame = encoder.encode(serialize(event));
          const queued = queuedBytes();
          if (!paced && queued > 0 && queued + frame.byteLength > SSE_MAX_QUEUED_BYTES) {
            closeSlowConsumer("queue_bytes");
            return;
          }
          if (durableCursor !== null) {
            sentCursors.add(durableCursor);
            cursor = Math.max(cursor, durableCursor);
            for (const seen of sentCursors) {
              if (seen < cursor - REPLAY_LIMIT) sentCursors.delete(seen);
            }
          }
          controller.enqueue(frame);
          if (durableCursor === null) {
            livePushed.add(identity);
            if (livePushed.size > SSE_MAX_LIVE_PUSHED) livePushed.delete(livePushed.values().next().value!);
          }
        };
        // Ni file pleine, ni contrôle d'accès en vol : le rejeu remplirait
        // sinon `accessBuffer` jusqu'à la coupure.
        const roomForReplay = async () => {
          while (!closed && (checkingAccess || (controller.desiredSize ?? 1) <= 0)) {
            await new Promise<void>((resolve) => { wakeReplay = resolve; });
          }
        };
        unsubscribe = hub.subscribe(organizationId, (event) => {
          if (!replaying) return push(event);
          if (!accepts(event)) return;
          noteSeen(event);
          if (buffered.length >= SSE_MAX_PENDING_EVENTS) closeSlowConsumer("replay_buffer");
          else buffered.push(event);
        });
        const open = async () => {
          const pollerCursor = await maxCursor(db, organizationId);
          const replayCursor = effectiveReplayCursor({
            requestedCursor: queryCursor,
            maxCursor: pollerCursor,
            oldestCursorInWindow: await oldestCursorSince(
              db,
              organizationId,
              new Date(Date.now() - events.replayWindowMs),
            ),
            windowEvents: events.replayWindowEvents,
          });
          cursor = Math.max(cursor, replayCursor);
          newestSeen = Math.max(newestSeen, cursor);
          // Un client qui avait une position et que la borne fait sauter en
          // avant l'apprend AVANT le premier événement : il relit ce que le
          // flux ne lui rendra pas (fil, roster, courrier).
          const gap = replayGap(queryCursor, replayCursor);
          if (gap && !closed) write(serializeGap({ organizationId, ...gap }));
          await replayPagesUntil(
            replayCursor,
            pollerCursor,
            (pageCursor) => (closed ? Promise.resolve([]) : replay(db, organizationId, pageCursor)),
            async (event) => {
              await roomForReplay();
              push(event, true);
            },
          );
          if (closed) return;
          replaying = false;
          flushBufferedSseEvents(buffered, push);
          if (closed) return;
          advanceSkippedCursor();
          releaseReplayPoller = acquireReplayPoller(
            hub, organizationId, pollerCursor, (pageCursor) => replay(db, organizationId, pageCursor), events.fallbackPollMs,
          );
          heartbeat = setInterval(() => {
            if (closed || queuedBytes() >= SSE_QUEUE_HIGH_WATER_BYTES) return;
            // Le contrôle d'accès tombe au même rythme et peut être en vol :
            // il avance alors le curseur lui-même en se terminant.
            if (!advanceSkippedCursor()) write(`: heartbeat ${Date.now()}\n\n`);
          }, SSE_HEARTBEAT_INTERVAL_MS);
        };
        // `start` rend la main tout de suite : `pull` n'est appelé qu'une fois
        // `start` résolu, et c'est lui qui réveille un rejeu en attente.
        void open().catch((error: unknown) => {
          cleanup();
          controller.error(error);
        });
      },
      pull() {
        wakeReplay?.();
        wakeReplay = null;
      },
      cancel() {
        cleanup();
      },
    }, { highWaterMark: SSE_QUEUE_HIGH_WATER_BYTES, size: (chunk) => chunk?.byteLength ?? 0 });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
  return routes;
}

/** Curseur durable, ou `null` tant que la ligne n'est pas committée. */
export function committedCursor(event: { cursor?: number }): number | null {
  return typeof event.cursor === "number" && Number.isSafeInteger(event.cursor) ? event.cursor : null;
}

/**
 * Curseur à partir duquel rejouer, quel que soit celui que le client demande.
 *
 * Deux planchers, et on garde le plus haut : le plus ancien événement de la
 * fenêtre temporelle (rejoué lui-même, d'où le `- 1`) et les N derniers
 * événements de l'organisation. Sans fenêtre non vide, rien n'est rejoué :
 * le client prend le flux là où il en est. Un curseur demandé n'est jamais
 * rabaissé (le rejeu reste strictement après lui) ; s'il est SOUS le plancher,
 * il est relevé et `replayGap` le dit au client.
 */
export function effectiveReplayCursor(input: {
  requestedCursor: number;
  /** `max(cursor)` de l'organisation au moment de la connexion. */
  maxCursor: number;
  /** Plus petit curseur dont `occurred_at` tombe dans la fenêtre ; `null` si aucun. */
  oldestCursorInWindow: number | null;
  windowEvents: number;
}): number {
  const { requestedCursor, maxCursor, oldestCursorInWindow, windowEvents } = input;
  const timeFloor = oldestCursorInWindow === null ? maxCursor : oldestCursorInWindow - 1;
  const countFloor = maxCursor - Math.max(0, windowEvents);
  return Math.max(0, requestedCursor, timeFloor, countFloor);
}

export type StreamGap = { from: number; to: number };

/**
 * Ce que la borne a fait sauter à un client qui AVAIT une position. Un
 * curseur à zéro n'est pas une position : ce client n'a rien et charge son
 * état par HTTP de toute façon : lui annoncer un trou ne ferait que
 * déclencher ces mêmes lectures une seconde fois.
 */
export function replayGap(requestedCursor: number, replayCursor: number): StreamGap | null {
  if (requestedCursor <= 0 || replayCursor <= requestedCursor) return null;
  return { from: requestedCursor, to: replayCursor };
}

/**
 * `?threadId=` répété (UUID, au plus `SSE_MAX_THREAD_FILTER`) ; absent :
 * `null`, tout le flux de l'organisation. Le filtre ne fait que restreindre
 * un flux déjà borné à l'organisation : l'accès reste celui de la session.
 */
export function readThreadFilter(values: string[] | undefined): ReadonlySet<string> | null {
  if (!values || values.length === 0) return null;
  if (values.length > SSE_MAX_THREAD_FILTER || values.some((value) => !isUuid(value))) {
    throw new HttpError(400, "THREAD_FILTER_INVALID", "Le filtre de fils du flux est invalide.");
  }
  return new Set(values.map((value) => value.toLowerCase()));
}

/**
 * Un événement sans fil (`threadId: null`) concerne toute l'organisation et
 * passe tout filtre. `run_events.thread_id` étant `not null` (0005), aucun
 * n'est produit aujourd'hui : la règle tient le contrat, qui l'admet.
 */
export function matchesThreadFilter(filter: ReadonlySet<string> | null, event: OrganizationEvent): boolean {
  return filter === null || event.threadId === null || filter.has(event.threadId);
}

export function flushBufferedSseEvents(
  buffered: OrganizationEvent[],
  push: (event: OrganizationEvent) => void,
): void {
  const pending = buffered.splice(0);
  const durable: OrganizationEvent[] = [];
  const live: OrganizationEvent[] = [];
  for (const event of pending) {
    if (committedCursor(event) === null) live.push(event);
    else durable.push(event);
  }
  durable.sort((left, right) => committedCursor(left)! - committedCursor(right)!);
  for (const event of durable) push(event);
  for (const event of live) push(event);
}

const MAX_PUBLISH_BATCH = 500;

function isUncommitted(event: OrganizationEvent): boolean {
  const rawCursor = (event as { cursor?: unknown }).cursor;
  return rawCursor === undefined || rawCursor === null;
}

function validatePublishedEvent(event: OrganizationEvent): void {
  const rawCursor = (event as { cursor?: unknown }).cursor;
  const uncommitted = isUncommitted(event);
  if (
    typeof event.organizationId !== "string" ||
    typeof event.runId !== "string" ||
    typeof event.sequence !== "number" ||
    typeof event.type !== "string" ||
    typeof event.occurredAt !== "string" ||
    (!uncommitted && (typeof rawCursor !== "number" || !Number.isSafeInteger(rawCursor)))
  ) {
    throw new HttpError(400, "EVENT_INVALID", "L’enveloppe d’événement est invalide.");
  }
  if (uncommitted && (typeof event.threadId !== "string" || !Number.isSafeInteger(event.leaseGeneration)
    || event.leaseGeneration === null || event.leaseGeneration === undefined || event.leaseGeneration < 0)) {
    throw new HttpError(400, "EVENT_INVALID", "L’identité de bail de l’événement est invalide.");
  }
}

// Avant le commit il n'y a pas de curseur. La trame part tout de suite,
// sans `id:` (voir `serialize`) : Last-Event-ID ne saute pas une ligne
// plus basse encore non committée. Le poller ordonné reste le seul
// publieur des lignes durables, pour ne pas inverser 12 et 11.
//
// Le contrôle d'appartenance se fait UNE fois par (run, bail, fil) du lot, pas
// par événement : un flush porte plusieurs trames du même run. Le verrou
// partagé tient jusqu'à la fin du fan-out synchrone du lot, par organisation.
async function fanOutUncommitted(db: Db, hub: EventHub, events: OrganizationEvent[]): Promise<void> {
  const byOrganization = new Map<string, Map<string, OrganizationEvent[]>>();
  for (const event of events) {
    const runs = byOrganization.get(event.organizationId) ?? new Map<string, OrganizationEvent[]>();
    const key = `${event.runId}|${event.threadId}|${event.leaseGeneration}`;
    const group = runs.get(key);
    if (group) group.push(event);
    else runs.set(key, [event]);
    byOrganization.set(event.organizationId, runs);
  }
  for (const [organizationId, runs] of byOrganization) {
    // Keep the run share lock through synchronous fanout: a reclaimed lease
    // cannot race this check and publish a stale provisional delta. The SQL
    // identity also prevents an internal caller from mixing bots or turns.
    await withTenant(db, organizationId, async (tx) => {
      for (const group of runs.values()) {
        const first = group[0]!;
        const rows = await tx<Array<{ botId: string | null; turnId: string; sessionKey: string | null }>>`
          select run.bot_id as "botId", coalesce(workflow.root_run_id, run.id) as "turnId",
                 coalesce(run.execution_session_key, thread.hermes_session_id) as "sessionKey"
            from runs run
            join threads thread on thread.organization_id = run.organization_id and thread.id = run.thread_id
            left join workflows workflow on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
           where run.organization_id = ${organizationId} and run.id = ${first.runId}
             and run.thread_id = ${first.threadId} and run.lease_generation = ${first.leaseGeneration}
             and run.lease_owner is not null and run.lease_expires_at > now()
             and run.status in ('starting','running','awaiting_approval')
             and run.remote_stop_state is distinct from 'requested'
           for share of run
        `;
        if (!rows[0]) continue;
        for (const event of group) hub.publish({ ...event, ...rows[0] });
      }
    });
  }
}

/**
 * `POST /internal/events/publish` : les trames pré-commit du worker (deltas
 * sans curseur, qu'aucune table ne porte encore) et ses hints post-commit.
 *
 * Le hint post-commit n'est plus que le REPLI de LISTEN (ADR 0001, S6) : tant
 * que `commitHintsNeeded()` est faux, LISTEN réveille déjà cette réplique et
 * toutes les autres ; le suivre doublerait la lecture. Il reste le chemin de
 * la seule réplique visée par `API_INTERNAL_URL` quand LISTEN est coupé.
 */
export function internalEventRoutes(
  db: Db,
  internal: InternalSecretsWith<"events">,
  hub: EventHub,
  wake: (organizationId: string) => void = (organizationId) => wakeReplayPoller(hub, organizationId),
  commitHintsNeeded: () => boolean = () => true,
): Hono {
  const routes = new Hono();
  routes.post("/publish", async (context) => {
    const accepted = matchInternalBearer(internal, "events", context.req.header("Authorization"));
    internalAuthMetrics.recordBearer("events", accepted ? "role" : "refused", "/internal/events/publish");
    if (!accepted) throw new HttpError(401, "WORKER_AUTH_INVALID", "Authentification worker invalide.");
    // Body: one event (original shape) or a batch `{ events: [...] }`. A batch
    // is validated whole before any fan-out, then delivered in array order.
    const body = await jsonBody(context.req.raw);
    const batch = (body as { events?: unknown }).events;
    let events: OrganizationEvent[];
    if (batch === undefined) {
      events = [body as unknown as OrganizationEvent];
    } else {
      if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_PUBLISH_BATCH
        || batch.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
        throw new HttpError(400, "EVENT_INVALID", "Le lot d’événements est invalide.");
      }
      events = batch as OrganizationEvent[];
    }
    for (const event of events) validatePublishedEvent(event);
    // Un réveil joint à un lot pré-commit est celui du flush précédent : il
    // passe après le fan-out, un seul par organisation suffit (idempotent).
    const uncommitted = events.filter(isUncommitted);
    if (uncommitted.length > 0) await fanOutUncommitted(db, hub, uncommitted);
    if (!commitHintsNeeded()) return context.body(null, 204);
    const woken = new Set<string>();
    for (const event of events) {
      if (isUncommitted(event) || woken.has(event.organizationId)) continue;
      woken.add(event.organizationId);
      wake(event.organizationId);
    }
    return context.body(null, 204);
  });
  return routes;
}

/** Curseur global max de l'org (0 si aucun événement) pour amorcer le poller. */
async function maxCursor(db: Db, organizationId: string): Promise<number> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<Array<{ max: string | number | null }>>`
      select max(cursor) as max from run_events where organization_id = ${organizationId}
    `;
    return Number(rows[0]?.max ?? 0);
  });
}

/**
 * Plus petit curseur de l'organisation dont `occurred_at` est postérieur à
 * `since` : `null` quand la fenêtre est vide. Une seule requête, à l'ouverture
 * d'une connexion partie de zéro ; jamais sur le chemin du poller.
 */
async function oldestCursorSince(db: Db, organizationId: string, since: Date): Promise<number | null> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<Array<{ min: string | number | null }>>`
      select min(cursor) as min from run_events
       where organization_id = ${organizationId} and occurred_at >= ${since}
    `;
    const value = rows[0]?.min;
    return value === null || value === undefined ? null : Number(value);
  });
}

async function replay(
  db: Db,
  organizationId: string,
  cursor: number,
): Promise<Array<OrganizationEvent & { cursor: number }>> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<RunEventRecord[]>`
      select cursor, organization_id as "organizationId", thread_id as "threadId",
             run_id as "runId", bot_id as "botId", turn_id as "turnId",
             session_key as "sessionKey", lease_generation as "leaseGeneration",
             sequence, type, payload, occurred_at as "occurredAt"
        from run_events
       where organization_id = ${organizationId} and cursor > ${cursor}
       order by cursor asc
       limit ${REPLAY_LIMIT}
    `;
    const events = rows.map(organizationEventEnvelope);
    // Dans la MÊME transaction que la lecture des événements : le message
    // final est écrit avec `run.completed` (une seule transaction côté
    // worker), donc tout ce que cette page annonce comme conclu est déjà
    // lisible ici. Le faire après réouvrirait une fenêtre pour rien.
    const page = await attachTerminalCompletions(tx, organizationId, events);
    return page as Array<OrganizationEvent & { cursor: number }>;
  });
}

/**
 * Lit toutes les pages disponibles jusqu'au curseur capturé avant le replay.
 * Une seule page ici ferait avancer le poller directement au max capturé et
 * abandonnerait silencieusement les événements de la page 2 et suivantes.
 * `emit` peut attendre : c'est par là que le rejeu suit le lecteur.
 */
export async function replayPagesUntil<T extends CursoredEvent>(
  cursor: number,
  capturedCursor: number,
  fetchPage: (cursor: number) => Promise<T[]>,
  emit: (event: T) => unknown,
): Promise<number> {
  let delivered = 0;
  let pageCursor = cursor;
  while (pageCursor < capturedCursor) {
    const page = await fetchPage(pageCursor);
    if (page.length === 0) break;
    for (const event of page) {
      await emit(event);
      delivered += 1;
    }
    const lastCursor = page[page.length - 1]?.cursor;
    // SQL orders by cursor, so a non-advancing page is invalid. Stop rather
    // than looping forever if a degraded/mock data source violates that.
    if (lastCursor === undefined || lastCursor <= pageCursor) break;
    pageCursor = lastCursor;
  }
  return delivered;
}

function serialize(event: OrganizationEvent): string {
  const durableCursor = committedCursor(event);
  const id = durableCursor === null ? "" : `id: ${durableCursor}\n`;
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Sans `id:` : un trou n'avance pas `Last-Event-ID`, le premier événement rejoué le fera. */
export function serializeGap(gap: StreamGapFrame): string {
  return `event: stream.gap\ndata: ${JSON.stringify(gap)}\n\n`;
}

/** Avec `id:` : c'est tout son objet, faire avancer `Last-Event-ID`. */
export function serializeCursor(position: StreamCursor): string {
  return `id: ${position.cursor}\nevent: stream.cursor\ndata: ${JSON.stringify(position)}\n\n`;
}
