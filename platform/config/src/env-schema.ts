import type { EnvScope, EnvTier, EnvVar } from "./env-schema/types";
import { API_ENV } from "./env-schema/api";
import { API_INTEGRATIONS_ENV } from "./env-schema/api-integrations";
import { SCRIPTS_ENV } from "./env-schema/scripts";
import { SHARED_ENV } from "./env-schema/shared";
import { WORKER_ENV } from "./env-schema/worker";
import type { RuntimeMode } from "@openedbot/contracts-api";
import type { RuntimeEnvironment } from "./runtime-mode";

/**
 * The single source of truth for the process environment.
 *
 * Every variable read by the API, the worker, the operator scripts or the
 * Makefile is declared here once. From this list:
 *   - `scripts/env.ts --template` generates `.env.example`, prints the
 *     production template on demand (`make env-prod-list`; no production file
 *     is versioned) and can rewrite `.env.local` in place;
 *   - `scripts/env.ts --check` derives what is required per environment and
 *     runtime mode;
 *   - `scripts/env.ts --audit` derives what is obsolete in `.env.local`;
 *   - `env-schema.test.ts` proves that no source reads a variable that is not
 *     declared here.
 *
 * Adding a variable to a config file without declaring it here fails the
 * unit tests; editing a template by hand fails `env-template --check`.
 */

export type { EnvRequiredWhen, EnvScope, EnvTier, EnvVar } from "./env-schema/types";

/** Every variable, in schema order; each part lives in `env-schema/<part>.ts`. */
export const ENV_SCHEMA: readonly EnvVar[] = [
  ...SHARED_ENV,
  ...API_ENV,
  ...API_INTEGRATIONS_ENV,
  ...WORKER_ENV,
  ...SCRIPTS_ENV,
];

/** Section order of the generated templates. */
export const ENV_SCOPE_ORDER: readonly EnvScope[] = ["shared", "api", "worker", "web", "admin", "scripts"];

/**
 * Where each scope's variables live on disk. ONE file for the whole monorepo,
 * at the repository root: one variable, one file, and one place to look.
 *
 * `scope` has not disappeared : it still orders the sections of that single
 * file (`ENV_SCOPE_ORDER`), so "the web variables" stay a readable block. What
 * changed is the address: an application no longer carries its own `.env.local`
 * next to its code.
 *
 * Ce que cela implique, et qui n'est pas automatique :
 *
 * - Les processus reçoivent leurs variables par l'ENVIRONNEMENT, pas par un
 *   fichier voisin : le Makefile source `ENV_FILES` et exporte (`set -a`) avant
 *   de lancer l'API, le worker et Vite. Lancer `bun run --cwd apps/api dev` à
 *   la main, hors `make`, ne charge plus rien.
 * - Vite continue de voir les noms `VITE_*` : il lit aussi `process.env` pour
 *   son préfixe (vite 7, `loadEnv`), en plus des fichiers de son `envDir`. Le
 *   secret du fichier racine ne rejoint donc pas le bundle : seul le préfixe
 *   passe, et rien ne pointe Vite vers ce fichier.
 */
export const ENV_DIR_OF_SCOPE: Record<EnvScope, string> = {
  shared: ".",
  scripts: ".",
  api: ".",
  worker: ".",
  web: ".",
  admin: ".",
};

/** Every directory holding an env file : la racine, et elle seule. */
export const ENV_DIRS: readonly string[] = [
  ".",
  ...new Set(ENV_SCOPE_ORDER.map((scope) => ENV_DIR_OF_SCOPE[scope]).filter((dir) => dir !== ".")),
];

/** Le fichier d'un dossier ; la racine garde le nom nu. */
export function envFilePath(dir: string, fileName: string): string {
  return dir === "." ? fileName : `${dir}/${fileName}`;
}

/** The directory whose env file owns this variable, or null when undeclared. */
export function envDirOfName(name: string): string | null {
  const entry = envSchemaEntry(name);
  return entry ? ENV_DIR_OF_SCOPE[entry.scope] : null;
}

export const ENV_SCHEMA_BY_NAME: ReadonlyMap<string, EnvVar> = new Map(ENV_SCHEMA.map((entry) => [entry.name, entry]));

/**
 * Families of variables declared by their shape rather than one by one. A
 * pattern never enters a template (no name to write) and is never required.
 */
export type EnvPattern = {
  /** The family as written in docs and messages. */
  label: string;
  pattern: RegExp;
  scope: EnvScope;
  tier: Exclude<EnvTier, "local">;
  doc: string;
  secret?: boolean;
};

/** Prefix shared by the plug-in variables; `OPENEDBOT_PLUGINS` is the list itself. */
export const PLUGIN_ENV_PREFIX = "OPENEDBOT_PLUGIN_";

export const ENV_SCHEMA_PATTERNS: readonly EnvPattern[] = [
  // Plug-in variables the core itself documents, before the generic family
  // (first match wins). Still a pattern: a plug-in variable never enters a template.
  {
    label: "OPENEDBOT_PLUGIN_AUDIT__RETENTION_DAYS",
    pattern: /^OPENEDBOT_PLUGIN_AUDIT__RETENTION_DAYS$/,
    scope: "worker",
    tier: "default_only",
    doc:
      "Plug-in `audit`: days an archived, pseudonymized audit row of a deleted tenant is kept (positive integer). " +
      "Unset: every row is archived with no end date, until the legal retention is decided. An invalid value fails the purge.",
  },
  {
    label: "OPENEDBOT_PLUGIN_AUDIT__ANCHOR_ORGANIZATIONS",
    pattern: /^OPENEDBOT_PLUGIN_AUDIT__ANCHOR_ORGANIZATIONS$/,
    scope: "api",
    tier: "default_only",
    doc: "Plug-in `audit`: comma-separated organization ids granted `audit.anchor` (a failed external anchoring blocks their writes). Unset: none.",
  },
  {
    label: "OPENEDBOT_PLUGIN_<ID>__<KEY>",
    // <ID>: the plug-in id upper-cased, `-` as `_` (apps/api pluginConfigPrefix);
    // <KEY>: upper-case words joined by single `_`.
    pattern: /^OPENEDBOT_PLUGIN_[A-Z][A-Z0-9_]{1,39}__[A-Z0-9]+(?:_[A-Z0-9]+)*$/,
    scope: "api",
    tier: "default_only",
    doc: "Configuration of one loaded plug-in; the plug-in receives <KEY> and nothing else of the environment.",
    secret: true,
  },
];

/** The declared entry of a variable: by name first, then by pattern. */
export function envSchemaEntry(name: string): EnvVar | undefined {
  const named = ENV_SCHEMA_BY_NAME.get(name);
  if (named) return named;
  const family = ENV_SCHEMA_PATTERNS.find((entry) => entry.pattern.test(name));
  if (!family) return undefined;
  const entry: EnvVar = { name, scope: family.scope, tier: family.tier, doc: family.doc };
  if (family.secret) entry.secret = true;
  return entry;
}

/** An `OPENEDBOT_PLUGIN_*` name that is neither the plug-in list nor a well-formed plug-in variable. */
export function isMalformedPluginEnvName(name: string): boolean {
  return name.startsWith(PLUGIN_ENV_PREFIX) && !envSchemaEntry(name);
}

/**
 * Prefixes treated as deprecated in `.env.local` whatever the suffix. Empty
 * since DEV-308: `APNS_*` used to be listed here while no APNs dispatcher
 * existed; those names are read again and declared in ENV_SCHEMA.
 */
export const DEPRECATED_ENV_PREFIXES: readonly string[] = [];

/**
 * Noms retirés du schéma parce que plus AUCUNE source ne les lit : vérifié nom
 * par nom sur l'arbre. Ils gardent juste ce qu'il faut pour que
 * `make env-prune` les efface d'un `.env.local` écrit avant leur retrait :
 * sans cette liste ils repasseraient pour « inconnus du schéma », et un
 * inconnu est conservé tel quel plutôt que supprimé.
 *
 * Ce qui les a rendus inutiles :
 *
 * - `WEB_ORIGINS`, `WEB_PUBLIC_URL` : l'origine du client vient de
 *   `WEB_APP_URL` (`platform/config/src/client-env.ts`).
 * - `LEGAL_*` : les documents légaux sont servis depuis le dépôt, plus depuis
 *   un chemin configurable.
 * - `NATIVE_REDIRECT_URIS` : le client Expo a été retiré le 2026-08-28 ;
 *   l'allowlist est fixe (`platform/config/src/api-config.ts`).
 * - `DEV_HERMES_ADMIN_URL/TOKEN`, `DEV_HERMES_DASHBOARD_URL`,
 *   `DEV_BUNDLED_HERMES_URL`, `BOX_TOKEN` : l'administration du runtime ne
 *   passe plus par ces adresses (« Release boundary », CLAUDE.md).
 * - `MIGRATOR_DATABASE_URL` : la tuyauterie de déploiement qui la lisait
 *   (deploy/) a été retirée avec le passage cloud-only ; plus
 *   aucune source ne la lit.
 * - `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_RUNTIME_DOCS_URL`,
 *   `NEXT_PUBLIC_SITE_URL` : lues par l'ancien site `sites/marketing`,
 *   supprimé du dépôt le 2026-10-27 ; aucune source ne les lit plus.
 * - `OPENEDBOT_DATABASE_NAME`, `OPENEDBOT_POSTGRES_PORT` : le nom de la
 *   base et le port se lisent dans API_DATABASE_URL (scripts/db.sh,
 *   dev-reset-data.ts, env-check), qui les portait déjà ; une seconde copie
 *   ne pouvait que diverger.
 * - `REPLACE` : `make link-dev-up REPLACE=1` used to re-enroll an instance
 *   linked elsewhere. `edge-setup link` has no `--replace` any more and always
 *   replaces the link of the instance it targets (`scripts/lib/link-dev.ts`),
 *   so no source reads it.
 * - `WORKER_INTERNAL_TOKEN`, `INTERNAL_TOKENS_EMIT` : le secret interne unique
 *   et le drapeau de sa bascule, remplacés par un secret par rôle (S1b,
 *   platform/config/src/internal-secrets.ts). Un processus qui les trouve
 *   encore refuse de démarrer ; l'audit les retire des fichiers locaux.
 */
export const DEPRECATED_ENV_NAMES: readonly string[] = [
  "BUNDLED_HERMES_URL",
  "BOX_TOKEN",
  "DEV_BUNDLED_HERMES_TOKEN",
  "DEV_HERMES_DASHBOARD_PASSWORD",
  "DEV_HERMES_DASHBOARD_USERNAME",
  "DEV_BUNDLED_HERMES_URL",
  "DEV_HERMES_ADMIN_TOKEN",
  "DEV_HERMES_ADMIN_URL",
  "DEV_HERMES_DASHBOARD_URL",
  "INTERNAL_TOKENS_EMIT",
  "LEGAL_DOCS_DIR",
  "LEGAL_MENTIONS_PATH",
  "LEGAL_PRIVACY_PATH",
  "LEGAL_TERMS_PATH",
  "MIGRATOR_DATABASE_URL",
  "NATIVE_REDIRECT_URIS",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_RUNTIME_DOCS_URL",
  "NEXT_PUBLIC_SITE_URL",
  "OPENEDBOT_DATABASE_NAME",
  "OPENEDBOT_POSTGRES_PORT",
  "REPLACE",
  "WEB_ORIGINS",
  "WEB_PUBLIC_URL",
  "WORKER_INTERNAL_TOKEN",
];

export function isDeprecatedEnvName(name: string): boolean {
  if (DEPRECATED_ENV_NAMES.includes(name)) return true;
  return DEPRECATED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * A name the core owns: declared here (by name or family) or retired. A pro
 * plug-in may not declare it as one of its deployment variables
 * (`manifest.env`, loader option `reservedEnv`).
 */
export function isCoreEnvName(name: string): boolean {
  return envSchemaEntry(name) !== undefined || isDeprecatedEnvName(name);
}

/** Whether `env-check` demands a non-empty value for this variable. */
export function isEnvRequired(
  entry: EnvVar,
  environment: RuntimeEnvironment,
  runtimeMode: RuntimeMode | undefined,
): boolean {
  const when = entry.requiredWhen;
  if (!when) return false;
  if (when.environment && !when.environment.includes(environment)) return false;
  if (when.runtimeMode && (runtimeMode === undefined || !when.runtimeMode.includes(runtimeMode))) return false;
  return true;
}

export function requiredEnvNames(environment: RuntimeEnvironment, runtimeMode?: RuntimeMode): string[] {
  return ENV_SCHEMA.filter((entry) => isEnvRequired(entry, environment, runtimeMode)).map((entry) => entry.name);
}

/**
 * Variables that only exist for another runtime mode: `env-audit` removes
 * them from `.env.local` whatever their value.
 */
export function envUnusedForRuntimeMode(runtimeMode: RuntimeMode): ReadonlySet<string> {
  return new Set(
    ENV_SCHEMA
      .filter((entry) => {
        const modes = entry.runtimeModes ?? entry.requiredWhen?.runtimeMode;
        return modes !== undefined && !modes.includes(runtimeMode);
      })
      .map((entry) => entry.name),
  );
}

export function envNamesOfTier(tier: EnvTier): ReadonlySet<string> {
  return new Set(ENV_SCHEMA.filter((entry) => entry.tier === tier).map((entry) => entry.name));
}

export type EnvTemplateEntry = { entry: EnvVar; value: string };

/**
 * Variables of `.env.example`, in template order. With `dir`, only those the
 * given directory's file owns.
 */
export function localTemplateEntries(dir?: string): EnvTemplateEntry[] {
  return sortForTemplate(
    ENV_SCHEMA.filter((entry) =>
      entry.tier === "local" && (dir === undefined || ENV_DIR_OF_SCOPE[entry.scope] === dir)),
  ).map((entry) => ({ entry, value: entry.example ?? "" }));
}

/** Variables of the production template, in template order. */
export function productionTemplateEntries(): EnvTemplateEntry[] {
  return sortForTemplate(ENV_SCHEMA.filter((entry) => entry.tier === "production" || entry.productionExample !== undefined))
    .map((entry) => ({
      entry,
      value: entry.tier === "production" ? entry.example ?? "" : entry.productionExample ?? "",
    }));
}

export function sortForTemplate(entries: readonly EnvVar[]): EnvVar[] {
  return [...entries].sort((left, right) => {
    const scopeDelta = ENV_SCOPE_ORDER.indexOf(left.scope) - ENV_SCOPE_ORDER.indexOf(right.scope);
    return scopeDelta !== 0 ? scopeDelta : left.name.localeCompare(right.name, "en");
  });
}
