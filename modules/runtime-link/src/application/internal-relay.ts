import { RelayDialError } from "@openedbot/hermes";
import {
  matchRelayRoute,
  RELAY_CLOSE_UNAUTHORIZED,
  RELAY_FORWARDED_REQUEST_HEADERS,
  RELAY_FORWARDED_RESPONSE_HEADERS,
  RELAY_MAX_REQUEST_BODY,
  RELAY_TRACEPARENT_HEADER,
} from "@openedbot/contracts-connector";
import { logEvent } from "@openedbot/platform-observability";
import { parseTraceparent, type TraceContext } from "@openedbot/platform-observability/trace-context";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { matchInternalBearer, type InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";
import { internalAuthMetrics } from "@openedbot/platform-observability/internal-auth";
import { jsonBody } from "@openedbot/platform-config/http-body";
import { SSE_HEARTBEAT_INTERVAL_MS } from "@openedbot/platform-config/sse-heartbeat";
import { relayFailureStatus, type RuntimeLinkBroker } from "./broker";
import { parseProbeGeneration, type LinkProbeResult } from "@openedbot/runtimes/domain/link-probe";
import {
  loopResponse,
  RUNTIME_LINK_INTERNAL_PREFIX,
  relayHopped,
  RUNTIME_LINK_RELAY_STAGE_HEADER,
  runtimeLinkLocator,
  unavailableResponse,
  type RuntimeLinkLocator,
} from "./instances";

/**
 * Les deux routes du relais interne, sans routeur : un module métier ne
 * connaît pas Hono. L'API et la passerelle du lien montent chacune ces
 * gestionnaires sous `RUNTIME_LINK_INTERNAL_PREFIX` (`/:runtimeId/proxy/*`
 * et `/:runtimeId/control`). Leurs corps sont ceux de l'ancien
 * `runtime-link-routes.ts` d'apps/api, inchangés.
 */

/** Ce que les gestionnaires lisent du contexte Hono, et rien de plus. */
export type InternalRelayContext = {
  req: {
    header(name: string): string | undefined;
    param(name: "runtimeId"): string;
    readonly url: string;
    readonly method: string;
    readonly raw: Request;
  };
  json(object: { pushed: boolean; uncertain?: true } | LinkProbeResult): Response;
};

export type InternalRelayHandlers = {
  proxy(context: InternalRelayContext): Promise<Response>;
  control(context: InternalRelayContext): Promise<Response>;
  probe(context: InternalRelayContext): Promise<Response>;
};

/**
 * Le relais interne : le worker pousse ici la requête gateway d'un runtime
 * `connector`, avec le même bearer que `/internal/events/publish`. Corps
 * relayé dans les deux sens, en flux ; une panne du LIEN est distinguée d'une
 * réponse du gateway par `X-OpenedBot-Relay-Stage`, que le dialer du worker relit
 * pour classer la certitude de livraison.
 *
 * Si le lien n'est pas ouvert ICI, la requête est forwardée à l'instance
 * propriétaire (`X-OpenedBot-Relay-Hop: 1`). Un second hop est refusé 508.
 */
export function runtimeLinkInternalRelay(
  internal: InternalSecretsWith<"relay">,
  broker: RuntimeLinkBroker | null,
  locator: RuntimeLinkLocator = runtimeLinkLocator(),
  options: { isDraining?: () => boolean } = {},
): InternalRelayHandlers {
  const proxy = async (context: InternalRelayContext): Promise<Response> => {
    const accepted = matchInternalBearer(internal, "relay", context.req.header("Authorization"));
    internalAuthMetrics.recordBearer("relay", accepted ? "role" : "refused", "proxy");
    if (!accepted) throw new HttpError(401, "WORKER_AUTH_INVALID", "Authentification worker invalide.");
    const runtimeId = context.req.param("runtimeId");
    const url = new URL(context.req.url);
    const prefix = `${RUNTIME_LINK_INTERNAL_PREFIX}/${runtimeId}/proxy`;
    if (!url.pathname.startsWith(prefix)) {
      return relayFailure(400, "HERMES_LINK_BAD_REQUEST", "Chemin de relais invalide.", "before_dispatch");
    }
    const path = `${url.pathname.slice(prefix.length)}${url.search}`;
    const method = context.req.method.toUpperCase();
    // A malformed traceparent is ignored (W3C): neither journaled nor relayed.
    const trace = parseTraceparent(context.req.header(RELAY_TRACEPARENT_HEADER));
    const journal = relayJournal(runtimeId, method, path, trace);
    if (!matchRelayRoute(method, path)) {
      return journal(relayFailure(403, "HERMES_LINK_PATH_FORBIDDEN", "Le lien connecteur ne relaie pas cette route.", "before_dispatch"));
    }
    // Existing run reconciliation and control remain usable during bounded drain.
    if (options.isDraining?.() && method !== "GET" && method !== "HEAD"
      && !(method === "POST" && /^(?:\/p\/[a-z0-9][a-z0-9_-]{0,62})?\/v1\/runs\/[A-Za-z0-9._~-]{1,128}\/(stop|approval)$/.test(path.split("?")[0]!))) {
      return journal(relayFailure(503, "LINK_DRAINING", "La passerelle termine les travaux en cours.", "before_dispatch"));
    }
    const hopped = relayHopped((name) => context.req.header(name));
    if (!broker?.connected(runtimeId)) {
      if (hopped) return journal(loopResponse());
      const location = await locator.locate(runtimeId);
      if (location.kind === "remote") return journal(await locator.forwardProxy(runtimeId, context.req.raw), "forwarded");
      return journal(unavailableResponse(location.kind === "unavailable" ? location.detail : "no_link"));
    }
    const declaredLength = Number(context.req.header("content-length") ?? "");
    if (Number.isSafeInteger(declaredLength) && declaredLength > RELAY_MAX_REQUEST_BODY) {
      return journal(relayFailure(413, "HERMES_PROTOCOL_LIMIT", "Le corps de la requête dépasse la borne du lien.", "before_dispatch"));
    }
    const headers: Record<string, string> = {};
    context.req.raw.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (RELAY_FORWARDED_REQUEST_HEADERS.has(lower) && lower !== RELAY_TRACEPARENT_HEADER) headers[lower] = value;
    });
    if (trace) headers[RELAY_TRACEPARENT_HEADER] = context.req.header(RELAY_TRACEPARENT_HEADER)!.trim();
    const body = method === "GET" || method === "HEAD" ? null : context.req.raw.body;

    let response: Response;
    try {
      response = await broker.dialer(runtimeId)({ method, path, headers, body }, context.req.raw.signal);
    } catch (error) {
      if (error instanceof RelayDialError) {
        return journal(relayFailure(relayFailureStatus(error.stage), error.code ?? "LINK_FAILED", error.message, error.stage));
      }
      throw error;
    }
    const responseHeaders = new Headers({ "Cache-Control": "no-store, no-transform" });
    response.headers.forEach((value, name) => {
      if (RELAY_FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
    });
    const contentType = response.headers.get("content-type") ?? "";
    const streaming = response.body && contentType.toLowerCase().startsWith("text/event-stream");
    const relayed = !response.body ? null
      : streaming ? withSseKeepalive(response.body, SSE_HEARTBEAT_INTERVAL_MS) : withSafeCancel(response.body);
    return journal(new Response(relayed, { status: response.status, headers: responseHeaders }));
  };

  /**
   * Trames de contrôle poussées vers l'hôte (`link.rotate`, fermeture) quand
   * la requête publique est arrivée sur une autre instance que le propriétaire.
   */
  const control = async (context: InternalRelayContext): Promise<Response> => {
    const accepted = matchInternalBearer(internal, "relay", context.req.header("Authorization"));
    internalAuthMetrics.recordBearer("relay", accepted ? "role" : "refused", "control");
    if (!accepted) throw new HttpError(401, "WORKER_AUTH_INVALID", "Authentification worker invalide.");
    const runtimeId = context.req.param("runtimeId");
    const hopped = relayHopped((name) => context.req.header(name));
    const body = await jsonBody(context.req.raw);
    if (!broker?.connected(runtimeId)) {
      if (hopped) return loopResponse();
      const location = await locator.locate(runtimeId);
      if (location.kind === "remote") {
        if (body.kind === "close") {
          const code = typeof body.code === "number" ? body.code : RELAY_CLOSE_UNAUTHORIZED;
          const reason = typeof body.reason === "string" ? body.reason : "LINK_ROTATED";
          const pushed = await locator.forwardClose(runtimeId, code, reason);
          return context.json({ pushed });
        }
        if (body.kind === "rotate" && typeof body.linkToken === "string" && typeof body.runtimeId === "string") {
          const pushed = await locator.forwardRotate(runtimeId, {
            t: "link.rotate",
            runtimeId: body.runtimeId,
            linkToken: body.linkToken,
          });
          // Le saut a pu livrer la trame : le worker ne doit pas défaire la rotation.
          return context.json(pushed === "unknown" ? { pushed: false, uncertain: true } : { pushed });
        }
        return relayFailure(400, "HERMES_LINK_BAD_REQUEST", "Trame de contrôle invalide.", "before_dispatch");
      }
      return unavailableResponse(location.kind === "unavailable" ? location.detail : "no_link");
    }
    if (body.kind === "close") {
      const code = typeof body.code === "number" ? body.code : RELAY_CLOSE_UNAUTHORIZED;
      const reason = typeof body.reason === "string" ? body.reason : "LINK_ROTATED";
      return context.json({ pushed: broker.closeLink(runtimeId, code, reason) });
    }
    if (body.kind === "rotate" && typeof body.linkToken === "string" && typeof body.runtimeId === "string") {
      const pushed = broker.notifyRotation(runtimeId, {
        t: "link.rotate",
        runtimeId: body.runtimeId,
        linkToken: body.linkToken,
      });
      return context.json({ pushed });
    }
    return relayFailure(400, "HERMES_LINK_BAD_REQUEST", "Trame de contrôle invalide.", "before_dispatch");
  };

  /**
   * « Vérifier le lien » : la sonde tourne sur l'instance qui tient la
   * socket. Contrairement à `control`, l'appelant attend le verdict (pong,
   * raccrochage 4005, génération changée) ; `forwardProbe` le borne.
   */
  const probe = async (context: InternalRelayContext): Promise<Response> => {
    const accepted = matchInternalBearer(internal, "relay", context.req.header("Authorization"));
    internalAuthMetrics.recordBearer("relay", accepted ? "role" : "refused", "probe");
    if (!accepted) throw new HttpError(401, "WORKER_AUTH_INVALID", "Authentification worker invalide.");
    const runtimeId = context.req.param("runtimeId");
    const hopped = relayHopped((name) => context.req.header(name));
    const body = await jsonBody(context.req.raw);
    const expectedGeneration = parseProbeGeneration(body.generation);
    if (broker?.connected(runtimeId)) return context.json(await broker.probeLink(runtimeId, expectedGeneration));
    if (hopped) return loopResponse();
    const location = await locator.locate(runtimeId);
    if (location.kind === "remote") return context.json(await locator.forwardProbe(runtimeId, expectedGeneration));
    return context.json({ outcome: location.kind === "unavailable" && location.detail === "instance_dead" ? "owner_unavailable" : "no_link" });
  };
  return { proxy, control, probe };
}

/**
 * La ligne du relais sur la piste d'un run (`runtime_link.relay_request`),
 * seulement pour une requête qui porte un `traceparent` valide : route sans
 * sa query, statut rendu au worker, étape d'une panne du lien, et le couple
 * trace/span que le worker et le connecteur journalisent aussi.
 */
function relayJournal(runtimeId: string, method: string, path: string, trace: TraceContext | null) {
  const startedAt = performance.now();
  return (response: Response, hop?: "forwarded"): Response => {
    if (!trace) return response;
    const stage = response.headers.get(RUNTIME_LINK_RELAY_STAGE_HEADER);
    logEvent("runtime_link.relay_request", {
      runtimeId,
      method,
      path: path.split("?")[0],
      status: response.status,
      ...(stage ? { stage } : {}),
      ...(hop ? { hop } : {}),
      durationMs: Math.round(performance.now() - startedAt),
      traceId: trace.traceId,
      spanId: trace.spanId,
    }, stage ? "warn" : undefined);
    return response;
  };
}

function relayFailure(status: number, code: string, message: string, stage: "before_dispatch" | "after_dispatch"): Response {
  return Response.json(
    { error: { code, message, stage } },
    { status, headers: { [RUNTIME_LINK_RELAY_STAGE_HEADER]: stage, "Cache-Control": "no-store" } },
  );
}

/**
 * Le corps non SSE d'une réponse relayée. Une requête abandonnée met la
 * source du broker en erreur; l'annulation HTTP de Bun 1.3 rejette alors une
 * promesse qu'elle ne possède pas, ce qui tue tout le processus gateway.
 * L'annulation est donc absorbée ici, et les vraies erreurs de la source
 * restent propagées au lecteur.
 */
export function withSafeCancel(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else if (value) controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}

/**
 * Un commentaire SSE `: keepalive` quand aucun octet ne passe pendant
 * l'intervalle : le flux gateway peut se taire des minutes entre deux
 * événements, et un proxy sur le chemin worker → API le couperait.
 */
export function withSseKeepalive(source: ReadableStream<Uint8Array>, intervalMs: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastByteAt = Date.now();
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastByteAt < intervalMs) return;
        lastByteAt = Date.now();
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Le flux s'est fermé entre-temps.
        }
      }, Math.max(250, Math.floor(intervalMs / 2)));
      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              lastByteAt = Date.now();
              controller.enqueue(value);
            }
          }
          closed = true;
          controller.close();
        } catch (error) {
          closed = true;
          try {
            controller.error(error);
          } catch {
            // Déjà fermé.
          }
        } finally {
          if (timer) clearInterval(timer);
          timer = null;
        }
      })();
    },
    cancel(reason) {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      // The request abort may already have errored the broker source. Cancelling
      // that errored reader rejects; Bun's HTTP cancellation path does not own
      // that rejection. The reader loop still propagates real errors to readers.
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}
