import type { ConnectorReleaseResponse } from "@openedbot/contracts-api";
import { RELAY_FEATURE_AUTO_UPGRADE } from "@openedbot/contracts-connector/features";

/** La commande qui active la mise à jour automatique sur l'hôte, typée par le contrat. */
export const AUTO_UPGRADE_COMMAND: ConnectorReleaseResponse["autoUpgradeCommand"] = "sudo edge-setup auto-upgrade enable --yes";

/**
 * `true` quand l'hôte annonce `auto_upgrade` : son timer installe seul les
 * releases plus récentes. Faux aussi pour un connecteur trop ancien pour le
 * dire : la console propose alors la commande, sans effet si le timer tourne.
 */
export function hasAutoUpgrade(features: readonly string[] | null | undefined): boolean {
  return Boolean(features?.includes(RELAY_FEATURE_AUTO_UPGRADE));
}
