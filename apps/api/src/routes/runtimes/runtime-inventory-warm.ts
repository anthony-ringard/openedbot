import { Hono } from "hono";
import { isUuid } from "@openedbot/contracts-primitives";
import { logger } from "@openedbot/platform-observability";
import { readThrough, type RuntimeReadKind } from "@openedbot/runtimes/application/runtime-read-snapshots";
import { matchInternalBearer, type InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";
import { internalAuthMetrics } from "@openedbot/platform-observability/internal-auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import type { IntegrationRouteContext } from "./runtime-integration-context";
import { keepIntegrations, liveIntegrationsRead } from "./runtime-integration-inventory-routes";
import { keepMcp, liveMcpRead } from "./runtime-integration-mcp-routes";

/**
 * Le réchauffage de l'inventaire d'un runtime, sur signal de son hôte.
 *
 * Le connecteur envoie `inventory.changed` quand les fichiers derrière
 * l'inventaire bougent (toolsets, serveurs et connexions MCP, skills) et une
 * fois à chaque connexion. Le broker l'inscrit (`runtimes.inventory_changed_at`)
 * puis appelle `warm` : on relit l'hôte ici, en arrière-plan, avec la même
 * composition que les routes, et l'instantané est à jour avant que
 * Réglages › Connecteurs ne s'ouvre. Rien ne bloque une requête : une lecture
 * ratée est journalisée, et la route sert alors l'ancien instantané en le
 * relisant elle-même.
 *
 * Par runtime, une seule relecture à la fois ; un signal reçu pendant celle-ci
 * en programme UNE autre, qui part à la fin : la dernière modification n'est
 * jamais perdue, et une rafale ne coûte jamais plus de deux lectures.
 */
export type InventoryWarmer = {
  warm(organizationId: string, runtimeId: string): void;
  /** Tests : attend la fin des relectures en cours. */
  idle(): Promise<void>;
};

const WARMED_KINDS: readonly RuntimeReadKind[] = ["integrations", "mcp"];

export function createInventoryWarmer(ctx: IntegrationRouteContext): InventoryWarmer {
  const { db, config, readRuntime, snapshots } = ctx;
  const running = new Map<string, Promise<void>>();
  const pending = new Set<string>();

  const readOnce = async (organizationId: string, runtimeId: string): Promise<void> => {
    const runtime = await readRuntime(db, config, organizationId);
    // Le runtime actif a changé, ou le lien est tombé entre-temps : la
    // prochaine connexion enverra son propre signal.
    if (!runtime || runtime.id !== runtimeId) return;
    const reads = await Promise.allSettled([
      readThrough(snapshots, {
        organizationId, runtimeId, kind: "integrations", fresh: true,
        keep: keepIntegrations, read: liveIntegrationsRead(ctx, runtime),
      }),
      readThrough(snapshots, {
        organizationId, runtimeId, kind: "mcp", fresh: true,
        keep: keepMcp, read: liveMcpRead(ctx, runtime),
      }),
    ]);
    reads.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.warn({ event: "runtime.inventory_warm_failed", runtimeId, kind: WARMED_KINDS[index], error: String(result.reason) }, "runtime inventory warm read failed");
      }
    });
  };

  const run = (organizationId: string, runtimeId: string): Promise<void> => {
    const key = `${organizationId}\u0000${runtimeId}`;
    const work = (async () => {
      do {
        pending.delete(key);
        try {
          await readOnce(organizationId, runtimeId);
        } catch (error) {
          // `readRuntime` lève quand le lien est injoignable : rien à relire.
          logger.warn({ event: "runtime.inventory_warm_failed", runtimeId, error: String(error) }, "runtime inventory warm failed");
        }
      } while (pending.has(key));
    })().finally(() => running.delete(key));
    running.set(key, work);
    return work;
  };

  return {
    warm(organizationId, runtimeId) {
      const key = `${organizationId}\u0000${runtimeId}`;
      if (running.has(key)) {
        pending.add(key);
        return;
      }
      void run(organizationId, runtimeId);
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
  };
}

/**
 * `POST /internal/runtime-inventory/changed` : le signal d'une passerelle de
 * lien séparée (`RUNTIME_LINK_MODE=separate`), qui reçoit `inventory.changed`
 * dans son propre processus et n'a pas la composition de l'inventaire. Même
 * secret : celui du signal d'inventaire (`INVENTORY_INTERNAL_TOKEN`), pas celui
 * des événements. Le corps ne nomme qu'un runtime : la
 * relecture passe par `readRuntime`, sous le tenant de l'organisation, et ne
 * fait rien si ce runtime n'en est plus le runtime actif.
 */
export function internalInventoryRoutes(internal: InternalSecretsWith<"inventory">, warmer: InventoryWarmer): Hono {
  const routes = new Hono();
  routes.post("/changed", async (context) => {
    const accepted = matchInternalBearer(internal, "inventory", context.req.header("Authorization"));
    internalAuthMetrics.recordBearer("inventory", accepted ? "role" : "refused", "/internal/runtime-inventory/changed");
    if (!accepted) throw new HttpError(401, "WORKER_AUTH_INVALID", "Authentification interne invalide.");
    const body = await jsonBody(context.req.raw) as { organizationId?: unknown; runtimeId?: unknown };
    if (typeof body.organizationId !== "string" || !isUuid(body.organizationId)
      || typeof body.runtimeId !== "string" || !isUuid(body.runtimeId)) {
      throw new HttpError(400, "INVENTORY_SIGNAL_INVALID", "Le signal d’inventaire est invalide.");
    }
    warmer.warm(body.organizationId, body.runtimeId);
    return context.body(null, 202);
  });
  return routes;
}
