/**
 * Noms de fonctionnalités annoncés par l'hôte dans `hello.features` et
 * `capabilities.features` : le SEUL endroit, côté TypeScript, où ces chaînes
 * sont écrites. Le reste du dépôt importe ces constantes
 * (`@openedbot/contracts-connector`, ou `@openedbot/contracts-connector/features`
 * pour le navigateur).
 *
 * Jumeau Go : `HostFeatures` et `LinkFeatures` de
 * `edge-setup/internal/connector/frames.go`. Un test lit ce fichier Go et
 * compare les deux listes, ordre compris (`platform/hermes/tests/transport/
 * relay-features.test.ts`) : un nom ajouté d'un seul côté le fait échouer.
 *
 * Toute fonctionnalité inconnue est ignorée par l'autre partie, jamais
 * refusée : c'est ce qui permet à un hôte et à un openedbot d'âges
 * différents de rester liés.
 */

/** Les quatre routes `/hermes-setup/providers/…` (dépôt d'un credential fournisseur par le lien). */
export const RELAY_FEATURE_PROVIDER_MANAGEMENT = "provider_management";
/** La sonde strictement lecture seule `/hermes-setup/usage`. */
export const RELAY_FEATURE_PROVIDER_USAGE = "provider_usage";
/** `GET /hermes-setup/toolsets` et l'écriture par toolset. */
export const RELAY_FEATURE_TOOLSET_MANAGEMENT = "toolset_management";
/** L'inventaire MCP, les serveurs HTTP personnalisés et les installations du catalogue. */
export const RELAY_FEATURE_MCP_MANAGEMENT = "mcp_management";
/** Les quatre routes OAuth MCP. */
export const RELAY_FEATURE_MCP_OAUTH = "mcp_oauth";
/** La lecture d'état du gateway et le verbe de redémarrage. */
export const RELAY_FEATURE_GATEWAY_RESTART = "gateway_restart";
/**
 * La lecture nommée des profils Hermes déjà présents
 * (`GET /hermes-setup/profiles` et l'avatar borné). Pas d'écriture de profil.
 */
export const RELAY_FEATURE_PROFILE_INVENTORY = "profile_inventory";
/** Création, renommage et suppression de profils (multiplexage disponible). */
export const RELAY_FEATURE_PROFILE_MANAGEMENT = "profile_management";
/** Les capacités (toolsets, MCP) d'un profil nommé. */
export const RELAY_FEATURE_PROFILE_CAPABILITIES = "profile_capabilities";
/** Écriture d'une clé d'API fournisseur dans un profil nommé. */
export const RELAY_FEATURE_PROFILE_CREDENTIALS = "profile_credentials";
/** La mémoire d'un profil (`GET`/`POST /hermes-setup/profiles/{slug}/memory`) par le magasin amont. */
export const RELAY_FEATURE_PROFILE_MEMORY = "profile_memory";
/** L'hôte soumet les écritures à l'accord de l'opérateur (politique d'approbation). */
export const RELAY_FEATURE_APPROVAL_POLICY = "approval_policy";
/** `GET /hermes-setup/sessions-inventory` (identifiants de session par profil, bornés). */
export const RELAY_FEATURE_SESSIONS_INVENTORY = "sessions_inventory";
/** La lecture fixe, métadonnées seulement, de la carte A2A en boucle locale. */
export const RELAY_FEATURE_A2A_CARD = "a2a_card";
/** La lecture bornée des métadonnées assainies du journal A2A. */
export const RELAY_FEATURE_A2A_AUDIT = "a2a_audit";
/** La politique A2A de l'hôte. */
export const RELAY_FEATURE_A2A_MANAGEMENT = "a2a_management";
/**
 * `GET /hermes-setup/model-context` : la fenêtre de contexte que ce runtime
 * applique au modèle configuré. Un hôte plus ancien ne l'annonce pas :
 * l'appelant retombe alors sur sa propre table de fenêtres par modèle.
 */
export const RELAY_FEATURE_MODEL_CONTEXT = "model_context";
/** Le rapport, lecture seule, des imports de SDK fournisseur de l'hôte. */
export const RELAY_FEATURE_PROVIDER_SDKS = "provider_sdks";
/** Recherche et inspection dans le hub de skills. */
export const RELAY_FEATURE_SKILLS_HUB = "skills_hub";
/** `POST /hermes-setup/profiles/models` : un même modèle écrit dans plusieurs profils en une fois. */
export const RELAY_FEATURE_PROFILE_MODEL_BATCH = "profile_model_batch";
/** Les skills fournies d'un profil, désactivables à sa création. */
export const RELAY_FEATURE_PROFILE_BUNDLED_SKILLS = "profile_bundled_skills";
/**
 * Le champ `profile` du départ OAuth MCP : le jeton va dans le home du profil
 * nommé, le seul que lisent les runs du bot. Sans elle, une autorisation ne
 * pourrait être faite qu'à la racine : le catalogue d'un bot n'est proposé qu'avec elle.
 */
export const RELAY_FEATURE_MCP_OAUTH_PROFILE = "mcp_oauth_profile";
/**
 * Déconnexion d'un serveur MCP d'un seul profil : retrait de sa configuration
 * et de ses jetons sur l'hôte. Sans elle, un bot connecté ne peut être que désactivé.
 */
export const RELAY_FEATURE_MCP_PROFILE_DISCONNECT = "mcp_profile_disconnect";
/**
 * Le gateway réconcilie seul ses serveurs MCP avec la config (à chaque tour de
 * maintenance) : un geste MCP ne demande plus de redémarrage. Un hôte plus
 * ancien ne l'annonce pas, et le redémarrage reste demandé.
 */
export const RELAY_FEATURE_MCP_LIVE_RELOAD = "mcp_live_reload";
/**
 * Le redémarrage du gateway laisse finir les tours en cours ; les nouveaux
 * reçoivent 503 `gateway_draining` et sont remis en file. Un hôte plus ancien
 * redémarre brutalement : la console le dit avant la confirmation.
 */
export const RELAY_FEATURE_GATEWAY_GRACEFUL_RESTART = "gateway_graceful_restart";
/** `GET /hermes-setup/skills` : les skills de la racine lues par l'opérateur (repli de `/v1/skills`). */
export const RELAY_FEATURE_SKILLS_INVENTORY = "skills_inventory";
/** `POST /hermes-setup/profiles/{slug}/toolsets` : plusieurs toolsets d'un profil en une écriture. */
export const RELAY_FEATURE_PROFILE_TOOLSETS_BATCH = "profile_toolsets_batch";
/**
 * Un état, pas une route : le timer de mise à jour automatique de l'hôte est
 * actif, une release edge-setup plus récente s'installe seule. Il peut
 * apparaître ou disparaître pendant un lien : l'hôte renvoie `capabilities`.
 */
export const RELAY_FEATURE_AUTO_UPGRADE = "auto_upgrade";
/**
 * Feature du LIEN (jamais de l'opérateur) : l'hôte tient un audit de création
 * scellé et attend `audit.key` avant de dispatcher une création
 * (`docs/CONNECTOR.md`, « Audit de création chiffré »).
 */
export const RELAY_FEATURE_CREATION_AUDIT_V2 = "creation_audit_v2";

/**
 * Tout nom que l'opérateur de l'hôte peut annoncer, dans l'ordre de priorité
 * de `HostFeatures` (Go) : quand la borne en vigueur est plus petite que la
 * liste, l'hôte retire les derniers.
 */
export const RELAY_HOST_FEATURES = [
  RELAY_FEATURE_PROVIDER_MANAGEMENT,
  RELAY_FEATURE_PROVIDER_USAGE,
  RELAY_FEATURE_TOOLSET_MANAGEMENT,
  RELAY_FEATURE_MCP_MANAGEMENT,
  RELAY_FEATURE_MCP_OAUTH,
  RELAY_FEATURE_GATEWAY_RESTART,
  RELAY_FEATURE_PROFILE_INVENTORY,
  RELAY_FEATURE_PROFILE_MANAGEMENT,
  RELAY_FEATURE_PROFILE_CAPABILITIES,
  RELAY_FEATURE_PROFILE_CREDENTIALS,
  RELAY_FEATURE_PROFILE_MEMORY,
  RELAY_FEATURE_APPROVAL_POLICY,
  RELAY_FEATURE_SESSIONS_INVENTORY,
  RELAY_FEATURE_A2A_CARD,
  RELAY_FEATURE_A2A_AUDIT,
  RELAY_FEATURE_A2A_MANAGEMENT,
  RELAY_FEATURE_MODEL_CONTEXT,
  RELAY_FEATURE_PROVIDER_SDKS,
  RELAY_FEATURE_SKILLS_HUB,
  RELAY_FEATURE_PROFILE_MODEL_BATCH,
  RELAY_FEATURE_PROFILE_BUNDLED_SKILLS,
  RELAY_FEATURE_MCP_OAUTH_PROFILE,
  RELAY_FEATURE_MCP_PROFILE_DISCONNECT,
  RELAY_FEATURE_MCP_LIVE_RELOAD,
  RELAY_FEATURE_GATEWAY_GRACEFUL_RESTART,
  RELAY_FEATURE_SKILLS_INVENTORY,
  RELAY_FEATURE_PROFILE_TOOLSETS_BATCH,
  RELAY_FEATURE_AUTO_UPGRADE,
] as const;

/** Les noms que le lien lui-même ajoute à `hello` (`LinkFeatures`, Go) ; jamais dans `capabilities`. */
export const RELAY_LINK_FEATURES = [RELAY_FEATURE_CREATION_AUDIT_V2] as const;

/**
 * Les features d'un lien après une trame `capabilities` : elle ne porte que
 * celles de l'opérateur, et celles du lien, annoncées dans `hello`, restent
 * vraies pour toute la session.
 */
export function withLinkFeatures(current: readonly string[], operator: readonly string[]): string[] {
  const link = current.filter((name) => (RELAY_LINK_FEATURES as readonly string[]).includes(name));
  return [...link, ...operator.filter((name) => !link.includes(name))];
}

export type RelayHostFeature = (typeof RELAY_HOST_FEATURES)[number];
export type RelayLinkFeature = (typeof RELAY_LINK_FEATURES)[number];
export type RelayFeature = RelayHostFeature | RelayLinkFeature;
