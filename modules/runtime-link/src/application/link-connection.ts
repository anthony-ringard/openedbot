import { AuditAnchorQueue } from "./audit-anchor-frame";
import { InventorySignal } from "./inventory-signal";
import { firstResponseBudgetMs } from "./link-budgets";
import { forwardedResponseHeaders, headerValue, isCreationRequest } from "./link-relay-headers";
import { RelayDialError, type RelayRequest } from "@openedbot/hermes";
import {
  decodeBinaryFrame,
  encodeTextFrame,
  matchRelayRoute,
  RELAY_CLOSE_REVOKED,
  RELAY_CLOSE_TOO_BIG,
  RELAY_CLOSE_UNAUTHORIZED,
  RELAY_MAX_IN_FLIGHT,
  RELAY_MAX_REQUEST_BODY,
  RELAY_MAX_RESPONSE_BODY,
  type RelayTextFrame,
  withLinkFeatures,
} from "@openedbot/contracts-connector";
import { hashCredential } from "@openedbot/platform-db/credential";
import {
  LinkLeaseLostError,
  type LinkSocket,
  type ConnectionProbe,
  type LinkIdentity,
  type LinkPeer,
  type ConnectionOptions,
} from "./link-types";

const MAX_U32 = 0xffff_ffff;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
/**
 * Tolérance après un `HERMES_PROTOCOL_LIMIT` sur UNE réponse : l'hôte a des
 * fragments déjà en vol quand notre `cancel` lui parvient, et un corps de
 * 4 MiB peut avoir un dernier fragment en route. Ses octets pour un id
 * abandonné sont comptés et ignorés jusqu'à son `end`/`err` ; au-delà de
 * cette borne, l'hôte n'obéit pas au `cancel` et c'est tout le lien qui se
 * ferme 1009: pas avant, sinon une seule grosse réponse coupe les 63 autres
 * requêtes en vol.
 */
const RELAY_MAX_DROPPED_OVERRUN = 8 << 20;
/** Ce qu'on garde d'une réponse de création pour en lire `run_id` : jamais plus. */
const DISPATCH_RESPONSE_CAPTURE_BYTES = 64 << 10;
const REMOTE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

/** Ce que le broker retient d'une création en vol, jusqu'à son enregistrement. */
type CreationCapture = {
  hash: string | null;
  dispatchedAt: Date;
  status: number | null;
  chunks: Uint8Array[];
  size: number;
  recorded: boolean;
};

type PendingRequest = {
  id: number;
  events: boolean;
  responded: boolean;
  /** Le corps de réponse a été clos ou mis en erreur : plus rien à lui livrer. */
  bodySettled: boolean;
  received: number;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  body: ReadableStreamDefaultController<Uint8Array> | null;
  firstResponseTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  /** Posé APRÈS l'envoi du `req` d'un `POST /v1/runs` : rien n'est journalisé pour une requête jamais partie. */
  creation: CreationCapture | null;
};

/**
 * Une connexion WebSocket et ses requêtes en vol.
 *
 * `dispatch` est le `RelayDialer` du transport `relay` : il rend la `Response`
 * dès le `res` de l'hôte, corps en flux alimenté par les trames binaires, et
 * lève une `RelayDialError` datée de son étape sinon.
 */
export class LinkConnection {
  readonly openedAt: number;
  private identity: LinkIdentity | null = null;
  private admitted = true;
  private admission: Promise<void> = Promise.resolve();
  private resolveAdmission: (() => void) | null = null;
  private rejectAdmission: ((error: Error) => void) | null = null;
  claimInFlight: Promise<void> | null = null;

  private readonly diagnosticsInFlight = new Set<string>();
  private readonly inventorySignal: InventorySignal;
  private readonly auditAnchors: AuditAnchorQueue;
  private retiring = false;
  private nextRequestId = 1;
  private readonly inFlight = new Map<number, PendingRequest>();
  /** Réponses abandonnées pour dépassement (id → octets reçus après l'abandon). */
  private readonly dropped = new Map<number, number>();
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Fin de grâce de l'ancien jeton : fermeture programmée au `bind`. */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenWriteAt = 0;
  /** Dernière trame ou dernier pong reçu de l'hôte (horloge `now`). */
  private lastInboundAt = 0;
  /** La sonde en cours : un seul ping à la fois par connexion. */
  private probeInFlight: { nonce: string; sentAt: number; promise: Promise<ConnectionProbe>; settle: (result: ConnectionProbe) => void } | null = null;
  /** L'hôte tel qu'il s'est présenté dans `hello`, pour le journal seulement. */
  agent: string | null = null;
  /** La clé publique Ed25519 annoncée dans `hello.devicePublicKey`, ou rien. */
  devicePublicKey: string | null = null;
  /** L'adresse et le `User-Agent` de la montée, posés au `bind`. */
  peer: LinkPeer = { ip: null, agent: null };
  /**
   * Capacités annoncées dans `hello.features` (ex. `provider_management`) :
   * écrites en base au `bind`, elles disent à l'interface quelles écritures
   * hôte le lien accepte. Jamais supposées : vides si l'hôte n'a rien dit.
   */
  features: string[] = [];
  /**
   * Après `link.issued`, l'hôte ferme cette socket (1000 bye) et redial avec
   * le bearer. Ce close ne doit pas persister `disconnected`, sinon l'écran
   * Runtime reste KO jusqu'à « Vérifier le lien ».
   */
  expectEnrollmentBye = false;

  constructor(
    private readonly socket: LinkSocket,
    private readonly options: ConnectionOptions,
    private readonly onCapabilities: (connection: LinkConnection, features: string[]) => void = () => {},
    private readonly onSeen: (connection: LinkConnection) => void = () => {},
    private readonly onClosed: (connection: LinkConnection, code: number, reason: string) => void = () => {},
  ) {
    this.openedAt = options.now();
    this.inventorySignal = new InventorySignal({ ...options, isClosed: () => this.closed });
    this.auditAnchors = new AuditAnchorQueue(options, () => this.closed);
    this.pingTimer = setInterval(() => {
      if (!this.closed) this.sendFrame({ t: "ping" });
    }, options.pingIntervalMs);
  }

  get link(): LinkIdentity | null {
    return this.identity;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isAdmitted(): boolean { return this.admitted; }
  whenAdmitted(): Promise<void> { return this.admission; }
  admit(): void {
    if (this.closed) return;
    this.admitted = true;
    this.resolveAdmission?.();
    this.resolveAdmission = null;
    this.rejectAdmission = null;
  }
  async reserveGeneration(): Promise<void> {
    if (!this.options.liveness.reserveGeneration || this.identity?.generation) return;
    try {
      const generation = await this.options.liveness.reserveGeneration(this.identity!);
      this.identity = { ...this.identity!, generation };
    } catch (error) {
      this.close(1012, "LINK_CLAIM_FAILED");
      throw error;
    }
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Posé par le broker quand la connexion entre au registre. */
  bind(identity: LinkIdentity, peer?: LinkPeer): void {
    this.identity = { ...identity, generation: undefined };
    if (this.options.liveness.reserveGeneration) {
      this.admitted = false;
      this.admission = new Promise<void>((resolve, reject) => { this.resolveAdmission = resolve; this.rejectAdmission = reject; });
      void this.admission.catch(() => {});
    }
    if (peer) this.peer = peer;
    this.lastSeenWriteAt = this.options.now();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (identity.expiresAt !== null) {
      // Une connexion montée avec l'ancien jeton ne survit pas à la grâce :
      // sans ce timer elle resterait `connected()` au broker alors que la base
      // la dit `disconnected` et que son hash n'ouvre plus rien.
      const delay = Math.max(0, identity.expiresAt - this.options.now());
      this.expiryTimer = setTimeout(() => {
        this.options.log("runtime_link.token_expired", { runtimeId: identity.runtimeId });
        this.close(RELAY_CLOSE_UNAUTHORIZED, "LINK_TOKEN_EXPIRED");
      }, delay);
    }
  }

  /**
   * Une trame de contrôle vers l'hôte. Ne lève jamais : un envoi raté ferme
   * la connexion. Un `0` de Bun (message abandonné) est un envoi raté, une
   * trame de contrôle perdue désynchronise le protocole, le lien ne vaut
   * plus rien ; `-1` (mis en file sous backpressure) est accepté.
   */
  sendFrame(frame: RelayTextFrame): boolean {
    if (this.closed) return false;
    try {
      const outcome = this.socket.send(encodeTextFrame(frame));
      if (outcome === 0) {
        this.options.log("runtime_link.send_failed", { runtimeId: this.identity?.runtimeId ?? null, error: "dropped" });
        this.close(1011, "LINK_SEND_FAILED");
        return false;
      }
      return true;
    } catch (error) {
      this.options.log("runtime_link.send_failed", { runtimeId: this.identity?.runtimeId ?? null, error: String(error) });
      this.close(1011, "LINK_SEND_FAILED");
      return false;
    }
  }

  /**
   * Une requête gateway dans le tuyau. Refus locaux (`before_dispatch`) :
   * lien fermé, 64 en vol, chemin hors allowlist, signal déjà joué.
   */
  dispatch(request: RelayRequest, signal?: AbortSignal): Promise<Response> {
    if (!this.admitted && !this.closed) {
      return Promise.reject(new RelayDialError("The runtime link claim is pending.", "before_dispatch", "LINK_CLAIM_PENDING"));
    }
    if (this.closed) {
      return Promise.reject(new RelayDialError("Le lien connecteur est fermé.", "before_dispatch", "LINK_CLOSED"));
    }
    if (signal?.aborted) {
      return Promise.reject(
        new RelayDialError("La requête a été annulée avant son envoi.", "before_dispatch", "LINK_REQUEST_ABORTED"),
      );
    }
    if (this.inFlight.size >= RELAY_MAX_IN_FLIGHT) {
      return Promise.reject(
        new RelayDialError("Le lien connecteur a trop de requêtes en vol.", "before_dispatch", "LINK_BUSY"),
      );
    }
    const route = matchRelayRoute(request.method, request.path);
    if (!route) {
      return Promise.reject(
        new RelayDialError("Le lien connecteur ne relaie pas cette route.", "before_dispatch", "HERMES_LINK_PATH_FORBIDDEN"),
      );
    }
    const id = this.allocateRequestId();
    const hasBody = request.body !== null;

    return new Promise<Response>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        events: route.events,
        responded: false,
        bodySettled: false,
        received: 0,
        resolve,
        reject,
        body: null,
        firstResponseTimer: null,
        idleTimer: null,
        signal,
        onAbort: null,
        creation: null,
      };
      // Inscrite seulement une fois le `req` accepté : un envoi raté ferme le
      // lien et rejetterait toutes les requêtes en vol `after_dispatch`, alors
      // qu'aucun octet de celle-ci n'est parti (une création serait ambiguë).
      const sent = this.sendFrame({
        t: "req",
        id,
        method: request.method.toUpperCase(),
        path: request.path,
        headers: request.headers,
        body: hasBody ? "stream" : "none",
      });
      if (!sent) {
        reject(new RelayDialError("Le lien connecteur n'a pas accepté la requête.", "before_dispatch", "LINK_CLOSED"));
        return;
      }
      this.inFlight.set(id, pending);
      if (this.options.liveness.dispatched && isCreationRequest(request)) {
        const idempotencyKey = headerValue(request.headers, "idempotency-key");
        pending.creation = {
          hash: idempotencyKey ? hashCredential(idempotencyKey) : null,
          dispatchedAt: new Date(this.options.now()),
          status: null, chunks: [], size: 0, recorded: false,
        };
      }
      if (!route.events) {
        pending.firstResponseTimer = setTimeout(() => {
          this.settle(
            pending,
            new RelayDialError("L'hôte n'a pas répondu dans le délai du lien.", "after_dispatch", "LINK_TIMEOUT"),
            { cancel: true },
          );
        }, firstResponseBudgetMs(request.method, request.path, this.options.firstResponseTimeoutMs));
      }
      if (signal) {
        pending.onAbort = () => {
          this.settle(
            pending,
            new RelayDialError("La requête a été annulée.", "after_dispatch", "LINK_REQUEST_ABORTED"),
            { cancel: true },
          );
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      if (hasBody && request.body !== null) void this.streamRequestBody(pending, request.body);
    });
  }

  /** Une trame de contrôle reçue de l'hôte. `hello` et `link.issued` n'ont pas de sens ici : ignorés. */
  handleText(frame: RelayTextFrame): void {
    this.lastInboundAt = this.options.now();
    switch (frame.t) {
      case "diagnostic": {
        const identity = this.identity;
        const persist = this.options.liveness.diagnostic;
        if (!identity || !this.admitted || this.closed || !persist || this.diagnosticsInFlight.size >= 4
          || this.diagnosticsInFlight.has(frame.eventId)) return;
        this.diagnosticsInFlight.add(frame.eventId);
        void persist(identity, frame, this.options.instanceId).then(() => {
          if (!this.closed) this.sendFrame({ t: "diagnostic.ack", eventId: frame.eventId });
        }).catch(() => {
          // No ACK: the connector retains the event and retries. Never log its payload.
          this.options.log("runtime_link.diagnostic_write_failed", { runtimeId: identity.runtimeId });
        }).finally(() => this.diagnosticsInFlight.delete(frame.eventId));
        return;
      }
      case "link.retire": {
        // Only the current token of an admitted link (proof of possession
        // done at the upgrade) may retire its runtime; once.
        const identity = this.identity;
        const retire = this.options.liveness.retire;
        if (!identity || !this.admitted || this.closed || !retire || identity.expiresAt !== null || this.retiring) return;
        this.retiring = true;
        void retire.call(this.options.liveness, identity, this.options.instanceId).then(() => {
          this.options.log("runtime_link.retired", { runtimeId: identity.runtimeId });
          if (this.closed) return;
          this.sendFrame({ t: "link.retired", runtimeId: identity.runtimeId });
          this.close(RELAY_CLOSE_REVOKED, "LINK_RETIRED");
        }).catch((error) => {
          // No answer: the host reports that openedbot did not confirm.
          this.retiring = false;
          this.options.log("runtime_link.retire_failed", { runtimeId: identity.runtimeId, error: String(error) });
        });
        return;
      }
      case "inventory.changed":
        if (this.identity && this.admitted && !this.closed) this.inventorySignal.receive(this.identity);
        return;
      case "capabilities":
        if (this.closed) return;
        this.features = withLinkFeatures(this.features, frame.features ?? []);
        if (this.identity) this.onCapabilities(this, this.features);
        return;
      case "ping":
        this.sendFrame({ t: "pong" });
        this.touchSeen();
        return;
      case "pong":
        this.touchSeen();
        return;
      case "audit.anchor":
        if (this.identity && this.admitted && !this.closed) this.auditAnchors.push(this.identity, frame);
        return;
      case "res":
        this.handleResponse(frame.id, frame.status, frame.headers ?? {});
        return;
      case "end": {
        // L'hôte a fini de parler d'une réponse abandonnée : son id est libre.
        if (this.dropped.delete(frame.id)) return;
        const pending = this.inFlight.get(frame.id);
        if (!pending) return;
        if (pending.responded) {
          this.closeBody(pending);
          this.finish(pending);
        }
        return;
      }
      case "err": {
        if (this.dropped.delete(frame.id)) return;
        const pending = this.inFlight.get(frame.id);
        if (!pending) return;
        this.settle(pending, new RelayDialError(frame.message ?? frame.code, frame.stage, frame.code));
        return;
      }
      case "cancel": {
        if (this.dropped.delete(frame.id)) return;
        const pending = this.inFlight.get(frame.id);
        if (!pending) return;
        this.settle(pending, new RelayDialError("L'hôte a annulé la requête.", "after_dispatch", "LINK_CANCELLED"));
        return;
      }
      default:
        this.options.log("runtime_link.unexpected_frame", { runtimeId: this.identity?.runtimeId ?? null, type: frame.t });
    }
  }

  /**
   * Un fragment de corps de réponse `[u32 id][bytes]`.
   *
   * Une réponse qui dépasse `RELAY_MAX_RESPONSE_BODY` n'échoue QU'ELLE
   * (`HERMES_PROTOCOL_LIMIT`, `err` + `cancel` à l'hôte) : les autres
   * requêtes en vol continuent. Ses fragments encore en route sont comptés
   * et ignorés jusqu'à son `end`/`err` ; seul un hôte qui insiste au-delà de
   * `RELAY_MAX_DROPPED_OVERRUN` ferme le lien 1009. Une trame indécodable
   * reste ignorée (le décodage ne lève que sur moins de 4 octets).
   */
  handleBinary(bytes: Uint8Array): void {
    this.lastInboundAt = this.options.now();
    let decoded: { id: number; chunk: Uint8Array };
    try {
      decoded = decodeBinaryFrame(bytes);
    } catch {
      return;
    }
    const overrun = this.dropped.get(decoded.id);
    if (overrun !== undefined) {
      const total = overrun + decoded.chunk.byteLength;
      this.dropped.set(decoded.id, total);
      if (total > RELAY_MAX_DROPPED_OVERRUN) {
        this.options.log("runtime_link.dropped_overrun", {
          runtimeId: this.identity?.runtimeId ?? null,
          id: decoded.id,
          bytes: total,
        });
        this.close(RELAY_CLOSE_TOO_BIG, "HERMES_PROTOCOL_LIMIT");
      }
      return;
    }
    const pending = this.inFlight.get(decoded.id);
    if (!pending || !pending.responded || pending.bodySettled) return;
    pending.received += decoded.chunk.byteLength;
    if (pending.received > RELAY_MAX_RESPONSE_BODY) {
      this.sendFrame({
        t: "err",
        id: pending.id,
        code: "HERMES_PROTOCOL_LIMIT",
        message: "response exceeds the stream limit",
        stage: "after_dispatch",
      });
      this.dropped.set(pending.id, 0);
      this.settle(
        pending,
        new RelayDialError("La réponse dépasse la borne du lien.", "after_dispatch", "HERMES_PROTOCOL_LIMIT"),
        { cancel: true },
      );
      return;
    }
    // Copie : le tampon du message WebSocket n'appartient pas au flux.
    const chunk = new Uint8Array(decoded.chunk);
    pending.body?.enqueue(chunk);
    if (pending.creation && pending.creation.size < DISPATCH_RESPONSE_CAPTURE_BYTES) {
      pending.creation.chunks.push(chunk);
      pending.creation.size += chunk.byteLength;
    }
    this.touchSeen();
    if (pending.events) this.armIdleTimer(pending);
  }

  /** Signe de vie observé (pong, réponse) : écrit au plus une fois par fenêtre. */
  touchSeen(): void {
    if (!this.identity || this.closed) return;
    if (!this.admitted) { this.onSeen(this); return; }
    const now = this.options.now();
    if (now - this.lastSeenWriteAt < this.options.seenDebounceMs) return;
    this.lastSeenWriteAt = now;
    const link = this.identity;
    void this.options.liveness.seen(link, this.options.instanceId).then(() => this.onSeen(this)).catch((error) => {
      this.options.log("runtime_link.liveness_failed", { runtimeId: link.runtimeId, instanceId: this.options.instanceId, generation: link.generation ?? null, write: "seen", error: String(error) });
      if (error instanceof LinkLeaseLostError) this.close(1012, "LINK_LEASE_LOST");
    });
  }

  /**
   * Un pong WebSocket. Celui des pings automatiques de Bun n'a pas de charge
   * utile ; celui de `probe` rend son nonce, qui seul mesure la latence.
   */
  handlePong(data?: Uint8Array | string | null): void {
    this.lastInboundAt = this.options.now();
    const probe = this.probeInFlight;
    if (probe && data != null) {
      const payload = typeof data === "string" ? data : new TextDecoder().decode(data);
      if (payload === probe.nonce) probe.settle({ alive: true, rttMs: Math.max(0, this.options.now() - probe.sentAt) });
    }
    this.touchSeen();
  }

  /**
   * Ping natif avec nonce, pong attendu sous `timeoutMs`. Sans pong, la socket
   * n'est dite morte que si RIEN n'est arrivé depuis l'envoi : une trame reçue
   * prouve qu'elle vit, même trop occupée pour répondre à temps.
   */
  probe(timeoutMs: number): Promise<ConnectionProbe> {
    if (this.closed) return Promise.resolve({ alive: false, reason: "closed" });
    if (this.probeInFlight) return this.probeInFlight.promise;
    const ping = this.socket.ping;
    if (!ping) return Promise.resolve({ alive: false, reason: "indeterminate" });
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const sentAt = this.options.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settle: (result: ConnectionProbe) => void = () => {};
    const promise = new Promise<ConnectionProbe>((resolve) => {
      settle = (result) => {
        if (this.probeInFlight?.nonce !== nonce) return;
        this.probeInFlight = null;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
    });
    this.probeInFlight = { nonce, sentAt, promise, settle };
    let outcome: number;
    try {
      outcome = ping.call(this.socket, nonce);
    } catch {
      outcome = 0;
    }
    // Un ping abandonné ne dit rien de l'hôte : la socket est saturée ou partie.
    if (outcome === 0) {
      settle(this.closed ? { alive: false, reason: "closed" } : { alive: false, reason: "indeterminate" });
      return promise;
    }
    timer = setTimeout(() => {
      if (this.closed) settle({ alive: false, reason: "closed" });
      else if (this.lastInboundAt > sentAt) settle({ alive: true, rttMs: null });
      else settle({ alive: false, reason: "timeout" });
    }, timeoutMs);
    return promise;
  }

  /** Ferme la socket et fait échouer tout ce qui est en vol. Idempotent. */
  close(code: number, reason: string): void {
    if (this.closed) return;
    this.markClosed(code, reason);
    try {
      this.socket.close(code, reason);
    } catch {
      // La socket est déjà partie : rien à fermer.
    }
  }

  /** La socket s'est fermée (côté hôte ou après `close`). */
  onSocketClosed(code: number, reason: string): void {
    if (this.closed) return;
    this.markClosed(code, reason);
  }

  private markClosed(code: number, reason: string): void {
    this.rejectAdmission?.(new LinkLeaseLostError());
    this.resolveAdmission = null;
    this.rejectAdmission = null;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.probeInFlight?.settle({ alive: false, reason: "closed" });
    const error = new RelayDialError(
      `Le lien connecteur a été fermé (${code} ${reason}).`,
      "after_dispatch",
      reason || "LINK_CLOSED",
    );
    for (const pending of [...this.inFlight.values()]) this.settle(pending, error);
    this.dropped.clear();
    this.onClosed(this, code, reason);
  }

  private allocateRequestId(): number {
    let id = this.nextRequestId;
    // u32, strictement positif, jamais réutilisé tant qu'il est en vol, ni
    // tant que l'hôte peut encore envoyer des fragments d'une réponse abandonnée.
    for (let attempts = 0; attempts < RELAY_MAX_IN_FLIGHT + this.dropped.size + 1; attempts += 1) {
      if (!this.inFlight.has(id) && !this.dropped.has(id)) break;
      id = id >= MAX_U32 ? 1 : id + 1;
    }
    this.nextRequestId = id >= MAX_U32 ? 1 : id + 1;
    return id;
  }

  private async streamRequestBody(pending: PendingRequest, body: ReadableStream<Uint8Array> | Uint8Array): Promise<void> {
    let sent = 0;
    const push = (chunk: Uint8Array): boolean => {
      sent += chunk.byteLength;
      if (sent > RELAY_MAX_REQUEST_BODY) {
        this.settle(
          pending,
          new RelayDialError("Le corps de la requête dépasse la borne du lien.", "after_dispatch", "HERMES_PROTOCOL_LIMIT"),
          { cancel: true },
        );
        return false;
      }
      if (this.closed || !this.inFlight.has(pending.id)) return false;
      const frame = new Uint8Array(4 + chunk.byteLength);
      new DataView(frame.buffer).setUint32(0, pending.id, false);
      frame.set(chunk, 4);
      // `0` : Bun a abandonné le fragment. Le corps serait tronqué et l'hôte
      // exécuterait un `POST /v1/runs` incomplet clos par un `end` propre.
      // Cette requête seule échoue ; `-1` (mis en file) laisse Bun tamponner
      // jusqu'à `backpressureLimit`, où `closeOnBackpressureLimit` tranche.
      if (this.socket.send(frame) === 0) {
        // Rejet d'abord, trames ensuite : si `cancel` est abandonné à son tour,
        // `sendFrame` ferme 1011 sans reprendre cette requête déjà réglée.
        this.settle(
          pending,
          new RelayDialError("Le lien a abandonné un fragment du corps de la requête.", "after_dispatch", "LINK_SEND_DROPPED"),
        );
        this.sendFrame({ t: "cancel", id: pending.id });
        this.sendFrame({
          t: "err",
          id: pending.id,
          code: "LINK_SEND_DROPPED",
          message: "request body fragment dropped under backpressure",
          stage: "after_dispatch",
        });
        return false;
      }
      return true;
    };
    try {
      if (body instanceof Uint8Array) {
        if (!push(body)) return;
      } else {
        const reader = body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && !push(value)) {
              await reader.cancel().catch(() => undefined);
              return;
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      if (!this.closed && this.inFlight.has(pending.id)) this.sendFrame({ t: "end", id: pending.id });
    } catch (error) {
      this.settle(
        pending,
        new RelayDialError("Le corps de la requête n'a pas pu être relayé.", "after_dispatch", "LINK_REQUEST_BODY_FAILED", { cause: error }),
        { cancel: true },
      );
    }
  }

  private handleResponse(id: number, status: number, rawHeaders: Record<string, string>): void {
    const pending = this.inFlight.get(id);
    if (!pending || pending.responded) return;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      this.settle(
        pending,
        new RelayDialError(`Statut de réponse invalide (${status}).`, "after_dispatch", "LINK_PROTOCOL_ERROR"),
        { cancel: true },
      );
      return;
    }
    // Construits AVANT de marquer la réponse reçue : un en-tête refusé lèverait
    // sinon après `responded`, et la promesse ne serait plus jamais réglée.
    let headers: Headers;
    try {
      headers = forwardedResponseHeaders(rawHeaders);
    } catch (error) {
      this.settle(
        pending,
        new RelayDialError("En-têtes de réponse invalides.", "after_dispatch", "LINK_PROTOCOL_ERROR", { cause: error }),
        { cancel: true },
      );
      return;
    }
    pending.responded = true;
    if (pending.creation) pending.creation.status = status;
    if (pending.firstResponseTimer) clearTimeout(pending.firstResponseTimer);
    pending.firstResponseTimer = null;
    this.touchSeen();
    if (NULL_BODY_STATUSES.has(status)) {
      pending.bodySettled = true;
      pending.resolve(new Response(null, { status, headers }));
      this.finish(pending);
      return;
    }
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        pending.body = controller;
      },
      cancel: () => {
        // Le consommateur a lâché le corps : l'hôte n'a plus besoin de le produire.
        pending.bodySettled = true;
        this.settle(pending, new RelayDialError("Corps abandonné par le consommateur.", "after_dispatch", "LINK_CONSUMER_CANCELLED"), {
          cancel: true,
        });
      },
    });
    if (pending.events) this.armIdleTimer(pending);
    pending.resolve(new Response(body, { status, headers }));
  }

  private armIdleTimer(pending: PendingRequest): void {
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(() => {
      this.settle(
        pending,
        new RelayDialError("Le flux d'événements est resté muet trop longtemps.", "after_dispatch", "LINK_EVENTS_IDLE"),
        { cancel: true },
      );
    }, this.options.eventsIdleTimeoutMs);
  }

  private closeBody(pending: PendingRequest): void {
    if (pending.bodySettled) return;
    pending.bodySettled = true;
    try {
      pending.body?.close();
    } catch {
      // Déjà clos par le consommateur.
    }
  }

  /**
   * Termine une requête sur une erreur : rejet si l'hôte n'a pas encore
   * répondu, erreur de flux sinon. `cancel` prévient l'hôte quand c'est nous
   * qui abandonnons.
   */
  private settle(pending: PendingRequest, error: RelayDialError, options: { cancel?: boolean } = {}): void {
    if (!this.inFlight.has(pending.id)) return;
    if (options.cancel && !this.closed) this.sendFrame({ t: "cancel", id: pending.id });
    if (!pending.responded) {
      pending.reject(error);
    } else if (!pending.bodySettled) {
      pending.bodySettled = true;
      try {
        pending.body?.error(error);
      } catch {
        // Le flux était déjà clos.
      }
    }
    this.finish(pending);
  }

  private finish(pending: PendingRequest): void {
    if (pending.firstResponseTimer) clearTimeout(pending.firstResponseTimer);
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.firstResponseTimer = null;
    pending.idleTimer = null;
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    pending.onAbort = null;
    this.inFlight.delete(pending.id);
    if (pending.creation && !pending.creation.recorded) this.recordDispatch(pending.creation);
  }

  /**
   * Le `req` est parti : quoi qu'il arrive ensuite (réponse, panne du lien,
   * abandon), la création est journalisée UNE fois, avec ce qu'on en sait.
   * Un statut absent est une livraison ambiguë, pas une absence de dispatch.
   */
  private recordDispatch(capture: CreationCapture): void {
    capture.recorded = true;
    const identity = this.identity;
    const persist = this.options.liveness.dispatched;
    if (!identity || !persist) return;
    let remoteId: string | null = null;
    if (capture.status !== null && capture.status >= 200 && capture.status < 300 && capture.size > 0 && capture.size <= DISPATCH_RESPONSE_CAPTURE_BYTES) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(capture.chunks))) as { run_id?: unknown };
        if (typeof parsed.run_id === "string" && REMOTE_ID_PATTERN.test(parsed.run_id)) remoteId = parsed.run_id;
      } catch {
        // Réponse non JSON ou tronquée : le run_id viendra de `runs.hermes_run_id`.
      }
    }
    capture.chunks = [];
    void persist(identity, { idempotencyKeyHash: capture.hash, dispatchedAt: capture.dispatchedAt, status: capture.status, remoteId }, this.options.instanceId)
      .catch((error) => {
        this.options.log("runtime_link.liveness_failed", { runtimeId: identity.runtimeId, write: "dispatched", error: String(error) });
      });
  }
}
