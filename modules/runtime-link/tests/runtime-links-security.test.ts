import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, spyOn, test } from "bun:test";
import { LINK_CONTROL_FORWARD_TIMEOUT_MS, RUNTIME_LINK_RELAY_STAGE_HEADER } from "../src/application/instances";
import {
  LINK_CONTROL_CALL_TIMEOUT_MS,
  LINK_TOKEN_UNCONFIRMED_HOLD_HOURS,
  SESSION_RECONCILIATION_BATCH,
  LINK_SESSIONS_INVENTORY_TIMEOUT_MS,
  reconcileRuntimeSessions,
  rotateStaleLinkTokens,
  type LinkFetch,
} from "../src/application/runtime-links";

type Captured = { sql: string; values: unknown[] };

/**
 * Une base factice : les runtimes dus sont rendus tels quels, chaque
 * écriture est journalisée, et l'update de rotation rend l'ancien hash.
 */
function fakeDb(captured: Captured[], options: { due?: Array<{ id: string; organizationId: string }>; known?: string[]; held?: boolean } = {}): Bun.SQL {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join("?");
    captured.push({ sql, values });
    if (sql.includes("from runtimes")) return Promise.resolve(options.due ?? []);
    if (sql.includes("link_token_previous_hash = link_token_hash")) return Promise.resolve([{ previousHash: "old-hash" }]);
    if (sql.includes("link_token_rotation_unconfirmed_at = now()")) return Promise.resolve(options.held ? [{ id: "held" }] : []);
    if (sql.includes("hermes_session_id as id from threads")) return Promise.resolve((options.known ?? []).map((id) => ({ id })));
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
}

const control = { apiInternalUrl: "http://127.0.0.1:8790", internalSecrets: testInternalSecrets("worker", "worker-token")};
const due = [{ id: "8f3b2c1d-1111-4222-8333-444455556666", organizationId: "org-1" }];

/**
 * Un relais vivant au bail mais muet (instance gelée, route sans retour) :
 * comme un vrai `fetch`, la requête ne se termine que si son signal part ;
 * sans signal, rien ne peut jamais la terminer.
 */
const silentRelay: LinkFetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal;
  if (!signal) return;
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

/**
 * Joue `pass` avec des échéances réelles de 20 ms au lieu de celles de
 * production, pour que le test reste rapide, et rend les durées que la passe a
 * demandées à `AbortSignal.timeout`. Une passe encore en cours après 1 s est
 * restée suspendue : l'issue vaut alors `"still waiting"`.
 */
async function withShortTimeouts<T>(pass: () => Promise<T>): Promise<{ outcome: T | "still waiting"; requested: number[] }> {
  const requested: number[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    requested.push(ms);
    return realTimeout(20);
  });
  try {
    const outcome = await Promise.race([pass(), Bun.sleep(1_000).then(() => "still waiting" as const)]);
    return { outcome, requested };
  } finally {
    timeout.mockRestore();
  }
}

describe("rotation automatique du jeton de lien", () => {
  test("un jeton trop vieux tourne en maintenance quand link.rotate a été poussé, et l'événement le dit", async () => {
    const captured: Captured[] = [];
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const fetchImpl: LinkFetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)), authorization: headers.get("Authorization") });
      return Response.json({ pushed: true });
    };
    const rotated = await rotateStaleLinkTokens(fakeDb(captured, { due }), 24, { ...control, fetchImpl });
    expect(rotated).toBe(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:8790/internal/runtime-links/8f3b2c1d-1111-4222-8333-444455556666/control");
    expect(requests[0]!.authorization).toBe("Bearer worker-token");
    expect(requests[0]!.body).toMatchObject({ kind: "rotate", runtimeId: due[0]!.id });
    const update = captured.find((entry) => entry.sql.includes("link_token_previous_hash = link_token_hash"))!;
    expect(update.sql).toContain("link_token_previous_expires_at = now() + (? * interval '1 minute')");
    expect(update.sql).toContain("link_token_expires_at = ?");
    // Le hash part en base, jamais le jeton lui-même.
    const token = (requests[0]!.body as { linkToken: string }).linkToken;
    expect(JSON.stringify(captured)).not.toContain(token);
    const event = captured.find((entry) => entry.sql.includes("insert into runtime_link_events"))!;
    expect(event.sql).toContain("'rotated'");
    // An object, never a JSON string: Bun encodes a jsonb parameter itself.
    expect(event.values[2]).toEqual({ automatic: true, reason: "max_age" });
  });

  test("la sélection ne vise que des runtimes connectés, sans rotation en cours, au-delà de l'âge", async () => {
    const captured: Captured[] = [];
    await rotateStaleLinkTokens(fakeDb(captured), 24, { ...control, fetchImpl: async () => Response.json({ pushed: true }) });
    const select = captured[0]!.sql;
    expect(select).toContain("link_connected_at is not null");
    expect(select).toContain("link_last_seen_at > now() - interval '45 seconds'");
    expect(select).toContain("link_token_previous_hash is null");
    expect(select).toContain("coalesce(link_token_rotated_at, created_at) < ?");
  });

  test("quand link.rotate ne peut pas être poussé, la rotation est défaite : l'ancien hash revient, rien n'est journalisé", async () => {
    const captured: Captured[] = [];
    const rotated = await rotateStaleLinkTokens(fakeDb(captured, { due }), 24, { ...control, fetchImpl: async () => Response.json({ pushed: false }) });
    expect(rotated).toBe(0);
    const revert = captured.find((entry) => entry.sql.includes("set link_token_hash = ?, link_token_previous_hash = null"))!;
    expect(revert.values[0]).toBe("old-hash");
    expect(captured.some((entry) => entry.sql.includes("insert into runtime_link_events"))).toBe(false);
  });

  test("un refus avant envoi (aucune instance ne tient le lien) défait aussi la rotation", async () => {
    const captured: Captured[] = [];
    const refused = async () => Response.json({ error: { code: "RUNTIME_LINK_UNAVAILABLE" } }, {
      status: 503, headers: { [RUNTIME_LINK_RELAY_STAGE_HEADER]: "before_dispatch" },
    });
    const rotated = await rotateStaleLinkTokens(fakeDb(captured, { due }), 24, { ...control, fetchImpl: refused });
    expect(rotated).toBe(0);
    expect(captured.some((entry) => entry.sql.includes("set link_token_hash = ?, link_token_previous_hash = null"))).toBe(true);
    expect(captured.some((entry) => entry.sql.includes("link_token_rotation_unconfirmed_at = now()"))).toBe(false);
  });

  // L'hôte a pu enregistrer le nouveau jeton avant que la réponse se perde :
  // défaire la rotation le couperait. Les deux jetons restent valables, et la
  // prochaine admission de l'hôte tranche.
  for (const [name, fetchImpl] of [
    ["un relais injoignable", async () => { throw new Error("ECONNRESET"); }],
    ["une erreur serveur non marquée", async () => new Response("", { status: 502 })],
    ["un saut d'instance incertain", async () => Response.json({ pushed: false, uncertain: true })],
    ["une réponse illisible", async () => new Response("<html>", { status: 200 })],
  ] as Array<[string, LinkFetch]>) {
    test(`${name} laisse la rotation en attente de confirmation, sans la défaire`, async () => {
      const captured: Captured[] = [];
      const rotated = await rotateStaleLinkTokens(fakeDb(captured, { due, held: true }), 24, { ...control, fetchImpl });
      expect(rotated).toBe(0);
      expect(captured.some((entry) => entry.sql.includes("set link_token_hash = ?, link_token_previous_hash = null"))).toBe(false);
      const hold = captured.find((entry) => entry.sql.includes("link_token_rotation_unconfirmed_at = now()"))!;
      expect(hold.sql).toContain("link_token_previous_expires_at = now() + (? * interval '1 hour')");
      expect(hold.values[0]).toBe(LINK_TOKEN_UNCONFIRMED_HOLD_HOURS);
      const event = captured.find((entry) => entry.sql.includes("insert into runtime_link_events"))!;
      expect(event.values[2]).toEqual({ automatic: true, reason: "max_age", confirmed: false });
    });
  }

  // Le worker n'a qu'une passe à la fois par job : un relais muet qui la
  // suspendrait arrêterait la rotation pour de bon. L'appel est borné et,
  // comme sur une erreur réseau, l'issue est inconnue : rien n'est défait.
  test("un relais muet : l'appel de contrôle est borné et la rotation attend sa confirmation", async () => {
    const captured: Captured[] = [];
    const { outcome, requested } = await withShortTimeouts(() =>
      rotateStaleLinkTokens(fakeDb(captured, { due, held: true }), 24, { ...control, fetchImpl: silentRelay }));
    expect(outcome).toBe(0);
    expect(requested).toEqual([LINK_CONTROL_CALL_TIMEOUT_MS]);
    // L'appel englobe le saut de l'instance vers le propriétaire : il lui survit.
    expect(LINK_CONTROL_CALL_TIMEOUT_MS).toBeGreaterThan(LINK_CONTROL_FORWARD_TIMEOUT_MS);
    expect(captured.some((entry) => entry.sql.includes("set link_token_hash = ?, link_token_previous_hash = null"))).toBe(false);
    expect(captured.some((entry) => entry.sql.includes("link_token_rotation_unconfirmed_at = now()"))).toBe(true);
  });
});

describe("réconciliation des sessions Hermes", () => {
  const inventory = { sessions: [{ id: "session-known", profile: "bot-a", createdAt: "2026-09-06T10:00:00Z" }, { id: "ghost-1", profile: "default", createdAt: "2026-09-06T11:00:00Z" }], total: 2, truncated: false };

  test("une session inconnue d'openedbot est journalisée unattributed_session avec des métadonnées bornées", async () => {
    const captured: Captured[] = [];
    const urls: string[] = [];
    const fetchImpl: LinkFetch = async (input) => { urls.push(input); return Response.json(inventory); };
    const result = await reconcileRuntimeSessions(fakeDb(captured, { due, known: ["session-known"] }), { ...control, fetchImpl });
    expect(result).toEqual({ runtimes: 1, unattributed: 1 });
    expect(urls[0]).toBe("http://127.0.0.1:8790/internal/runtime-links/8f3b2c1d-1111-4222-8333-444455556666/proxy/hermes-setup/sessions-inventory");
    expect(captured[0]!.sql).toContain("? = any(link_features)");
    expect(captured[0]!.values).toContain("sessions_inventory");
    const inserted = captured.filter((entry) => entry.sql.includes("insert into runtime_link_events"));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.sql).toContain("'unattributed_session'");
    expect(inserted[0]!.values[2]).toEqual({ sessionId: "ghost-1", profile: "default", createdAt: "2026-09-06T11:00:00Z" });
  });

  test("les vrais identifiants openedbot (openedbot:<org>:<thread>) sont réconciliés, un identifiant hors grammaire jamais", async () => {
    const captured: Captured[] = [];
    const real = "openedbot:0b9c6a1e-0000-4000-8000-000000000001:7d1f0c2a-1111-4222-8333-444455556666";
    const sessions = [{ id: real, profile: "bot-a", createdAt: "2026-09-06T10:00:00Z" }, { id: "../etc/passwd", profile: "x", createdAt: "" }];
    const result = await reconcileRuntimeSessions(fakeDb(captured, { due }), { ...control, fetchImpl: async () => Response.json({ sessions, total: 2, truncated: false }) });
    expect(result.unattributed).toBe(1);
    const known = captured.find((entry) => entry.sql.includes("hermes_session_id as id from threads"))!;
    expect(JSON.stringify(known.values)).toContain(real);
    const inserted = captured.filter((entry) => entry.sql.includes("insert into runtime_link_events"));
    expect(inserted.map((entry) => (entry.values[2] as { sessionId: string }).sessionId)).toEqual([real]);
  });

  test("la passe avance : les runtimes les moins récemment réconciliés d'abord, chacun daté même sans inventaire", async () => {
    const captured: Captured[] = [];
    const next = { id: "9a4c3d2e-2222-4333-8444-555566667777", organizationId: "org-1" };
    await reconcileRuntimeSessions(fakeDb(captured, { due: [...due, next] }), { ...control, fetchImpl: async () => new Response("", { status: 503 }) });
    expect(captured[0]!.sql).toContain("order by link_sessions_reconciled_at asc nulls first, id");
    expect(captured[0]!.values).toEqual(["sessions_inventory", SESSION_RECONCILIATION_BATCH]);
    const stamps = captured.filter((entry) => entry.sql.includes("set link_sessions_reconciled_at = now()"));
    expect(stamps.map((entry) => entry.values[0])).toEqual([due[0]!.id, next.id]);
  });

  test("une session déjà journalisée ou connue par un run n'est pas rejouée", async () => {
    const captured: Captured[] = [];
    const result = await reconcileRuntimeSessions(fakeDb(captured, { due, known: ["session-known", "ghost-1"] }), { ...control, fetchImpl: async () => Response.json(inventory) });
    expect(result.unattributed).toBe(0);
    const known = captured.find((entry) => entry.sql.includes("hermes_session_id as id from threads"))!;
    expect(known.sql).toContain("execution_session_key as id from runs");
    expect(known.sql).toContain("kind = 'unattributed_session'");
  });

  test("un inventaire indisponible n'invente rien", async () => {
    const captured: Captured[] = [];
    const result = await reconcileRuntimeSessions(fakeDb(captured, { due }), { ...control, fetchImpl: async () => new Response("", { status: 503 }) });
    expect(result).toEqual({ runtimes: 1, unattributed: 0 });
    expect(captured.some((entry) => entry.sql.includes("insert into runtime_link_events"))).toBe(false);
  });

  // Les runtimes sont lus l'un après l'autre : un relais muet ne doit pas
  // figer la passe pour ceux qui suivent.
  test("un relais muet est journalisé indisponible et la passe lit les runtimes suivants", async () => {
    const captured: Captured[] = [];
    const next = { id: "9a4c3d2e-2222-4333-8444-555566667777", organizationId: "org-1" };
    const fetchImpl: LinkFetch = (input, init) => input.includes(due[0]!.id) ? silentRelay(input, init) : Promise.resolve(Response.json(inventory));
    const { outcome, requested } = await withShortTimeouts(() =>
      reconcileRuntimeSessions(fakeDb(captured, { due: [...due, next], known: ["session-known"] }), { ...control, fetchImpl }));
    expect(outcome).toEqual({ runtimes: 2, unattributed: 1 });
    expect(requested).toEqual([LINK_SESSIONS_INVENTORY_TIMEOUT_MS, LINK_SESSIONS_INVENTORY_TIMEOUT_MS]);
    const inserted = captured.filter((entry) => entry.sql.includes("insert into runtime_link_events"));
    expect(inserted.map((entry) => entry.values[1])).toEqual([next.id]);
  });
});
