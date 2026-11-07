import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { readInternalSecrets } from "../platform/config/src/internal-secrets";
import { basename } from "node:path";
import { r2ConfigurationProblems } from "../platform/config/src/blob-driver";
import { assertLegalFile, DEFAULT_LEGAL_MAX_BYTES, MAX_LEGAL_MAX_BYTES } from "../apps/api/src/infrastructure/config";
import {
  ENV_DIR_OF_SCOPE,
  ENV_DIRS,
  ENV_SCHEMA,
  ENV_SCHEMA_BY_NAME,
  envDirOfName,
  envFilePath,
  envNamesOfTier,
  envSchemaEntry,
  envUnusedForRuntimeMode,
  isDeprecatedEnvName,
  isEnvRequired,
  isMalformedPluginEnvName,
  localTemplateEntries,
  productionTemplateEntries,
  requiredEnvNames,
  sortForTemplate,
  type EnvScope,
  type EnvTemplateEntry,
  type EnvVar,
} from "../platform/config/src/env-schema";
import { RUNTIME_MODE } from "../platform/config/src/runtime-mode";
import {
  assertUniqueEnvNames,
  classifyLocalEnvEntry,
  mergeEnvFiles,
  parseEnvLine,
  readEnvFiles,
} from "./lib/env-file";

function usage(): never {
  console.error(`usage: bun scripts/env.ts --check [--production]
       bun scripts/env.ts --audit [--apply]
       bun scripts/env.ts --template --check|--write|--print-production|--write-local
       bun scripts/env.ts --where [NAME]
       bun scripts/env.ts --file-of`);
  process.exit(2);
}

async function runCheck(): Promise<void> {
  // Which variables are required per environment and runtime mode lives in
  // platform/config/src/env-schema.ts (`requiredWhen`). This script only
  // keeps the value validators (key length, HTTPS, legal files).
  const mode = process.argv.includes("--production") ? "production" : "development";
  // One file for the monorepo (ENV_DIR_OF_SCOPE): validate it, and say
  // which file a missing or wrong value belongs to.
  const path = basename(process.env.ENV_FILE?.trim() || ".env.local");
  const files = await readEnvFiles(path);
  if (!files.length) {
    throw new Error(`No ${path} found. Run \`make setup\`, or copy each .env.example next to it.`);
  }
  const { values, sourceOf } = mergeEnvFiles(files);

  /** Where a variable must be set, for an error message that is actionable. */
  function fileOf(name: string): string {
    return sourceOf.get(name) ?? envFilePath(envDirOfName(name) ?? ".", path);
  }

  // The runtime mode only matters in development: production is `external`
  // by construction and its required set does not depend on it.
  const runtimeMode = mode === "development" ? RUNTIME_MODE : undefined;
  const required = requiredEnvNames(mode, runtimeMode);

  for (const name of required) {
    if (!values[name]?.trim()) throw new Error(`${name} is required in ${fileOf(name)}.`);
  }
  // Plug-in variables are declared by shape (ENV_SCHEMA_PATTERNS): a
  // misspelled one would silently never reach its plug-in.
  const malformed = Object.keys(values).filter(isMalformedPluginEnvName);
  if (malformed.length) {
    throw new Error(`${malformed.join(", ")}: not a plug-in variable; expected OPENEDBOT_PLUGINS or OPENEDBOT_PLUGIN_<ID>__<KEY>.`);
  }
  // Le nom de la base est écrit deux fois, dans les DSN de l'API et du worker,
  // qui ont chacun leur rôle PostgreSQL ; les scripts (db-migrate, db-reset)
  // le lisent dans celui de l'API. Les deux doivent désigner la même base :
  // sinon `make db-migrate` migre une base et le worker tourne sur une autre.
  assertSameDatabase(values);

  // La PWA appelle `/api` sur sa propre origine en développement et Vite relaie
  // vers l'API : une valeur locale ferait sortir le navigateur du proxy et
  // casserait CORS et les cookies. Ce n'est pas un réglage optionnel.
  if (mode === "development" && values.VITE_API_ORIGIN?.trim()) {
    throw new Error("VITE_API_ORIGIN must stay empty in development: the SPA calls /api on its own origin, proxied by Vite.");
  }
  // Same rule as createTransactionalEmailSender, which the worker runs at boot
  // (modules/notifications/src/application/email.ts): one transport at most,
  // and a sender as soon as there is one. Checked in every environment, so a
  // development file that would crash the worker fails here instead.
  const transactionalEmailTransports = [
    "TRANSACTIONAL_EMAIL_ENDPOINT", "TRANSACTIONAL_EMAIL_SMTP_URL", "TRANSACTIONAL_EMAIL_BREVO_API_KEY",
    "TRANSACTIONAL_EMAIL_RESEND_API_KEY",
  ].filter((name) => values[name]?.trim());
  if (transactionalEmailTransports.length > 1) {
    throw new Error(`Transactional email accepts exactly one transport; ${transactionalEmailTransports.join(" and ")} are set together.`);
  }
  if (transactionalEmailTransports.length && !values.TRANSACTIONAL_EMAIL_FROM?.trim()) {
    throw new Error(`TRANSACTIONAL_EMAIL_FROM is required in ${fileOf("TRANSACTIONAL_EMAIL_FROM")} with ${transactionalEmailTransports[0]}: the worker refuses to start without a sender.`);
  }
  assertEncryptionKey(values.RUNTIME_TOKEN_ENCRYPTION_KEY!, "RUNTIME_TOKEN_ENCRYPTION_KEY");
  for (const [index, key] of (values.RUNTIME_TOKEN_ENCRYPTION_PREVIOUS_KEYS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean).entries()) {
    assertEncryptionKey(key, `RUNTIME_TOKEN_ENCRYPTION_PREVIOUS_KEYS[${index}]`);
  }

  if (mode === "production") {
    if (values.BLOB_DRIVER && values.BLOB_DRIVER !== "r2" && values.BLOB_DRIVER !== "file") {
      throw new Error("BLOB_DRIVER must be r2 or file.");
    }
    // The internal secrets, as each process reads them (S1b): every role it holds
    // has its own variable, no dev value, all distinct.
    for (const process of ["api", "worker", "link-gateway"] as const) readInternalSecrets(process, "production", values);
    if (values.METRICS_INTERNAL_TOKEN === "openedbot-metrics-dev-token") {
      throw new Error("METRICS_INTERNAL_TOKEN must be a distinct production secret.");
    }
    const alertWebhook = new URL(values.ALERT_WEBHOOK_URL!);
    if (alertWebhook.protocol !== "https:" || alertWebhook.username || alertWebhook.password) {
      throw new Error("ALERT_WEBHOOK_URL must be an HTTPS URL without embedded credentials.");
    }
    if (!values.API_PUBLIC_URL?.startsWith("https://")) throw new Error("Production API_PUBLIC_URL must use HTTPS.");
    if (!values.WEB_APP_URL?.startsWith("https://")) throw new Error("Production WEB_APP_URL must use HTTPS.");
    for (const origin of values.CORS_ALLOWED_ORIGINS?.split(",") ?? []) {
      if (origin.trim() && !origin.trim().startsWith("https://")) {
        throw new Error(`CORS_ALLOWED_ORIGINS must list HTTPS origins only; got ${origin.trim()}.`);
      }
    }
    // Un R2 incomplet ou neutralisé fait basculer l'API sur le volume ; un R2 réel doit être en HTTPS.
    if (values.BLOB_DRIVER !== "file" && r2ConfigurationProblems(values).length === 0
      && !values.R2_ENDPOINT?.startsWith("https://")) {
      throw new Error("Production R2_ENDPOINT must use HTTPS.");
    }
    const transactionalEmailEndpoint = values.TRANSACTIONAL_EMAIL_ENDPOINT?.trim() || "";
    const transactionalEmailSmtp = values.TRANSACTIONAL_EMAIL_SMTP_URL?.trim() || "";
    const transactionalEmailResendBase = values.TRANSACTIONAL_EMAIL_RESEND_BASE_URL?.trim() || "https://api.resend.com";
    if (!transactionalEmailTransports.length) {
      throw new Error("Production transactional email requires TRANSACTIONAL_EMAIL_BREVO_API_KEY, TRANSACTIONAL_EMAIL_RESEND_API_KEY, TRANSACTIONAL_EMAIL_ENDPOINT or TRANSACTIONAL_EMAIL_SMTP_URL.");
    }
    let resendBase: URL;
    try {
      resendBase = new URL(transactionalEmailResendBase);
    } catch {
      throw new Error("TRANSACTIONAL_EMAIL_RESEND_BASE_URL must be an HTTPS URL without embedded credentials.");
    }
    if (resendBase.protocol !== "https:" || resendBase.username || resendBase.password) {
      throw new Error("TRANSACTIONAL_EMAIL_RESEND_BASE_URL must be an HTTPS URL without embedded credentials.");
    }
    if (transactionalEmailEndpoint) {
      const parsed = new URL(transactionalEmailEndpoint);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("TRANSACTIONAL_EMAIL_ENDPOINT must be an HTTPS URL without embedded credentials.");
      }
      if (!values.TRANSACTIONAL_EMAIL_TOKEN?.trim()) {
        throw new Error("TRANSACTIONAL_EMAIL_TOKEN is required with TRANSACTIONAL_EMAIL_ENDPOINT.");
      }
    }
    if (transactionalEmailSmtp) {
      let smtp: URL;
      try {
        smtp = new URL(transactionalEmailSmtp);
      } catch {
        throw new Error("TRANSACTIONAL_EMAIL_SMTP_URL must be a smtp:// or smtps:// URL.");
      }
      if (smtp.protocol !== "smtp:" && smtp.protocol !== "smtps:") {
        throw new Error("TRANSACTIONAL_EMAIL_SMTP_URL must use smtp:// or smtps://.");
      }
    }
    if (!values.FILES_CDN_URL?.startsWith("https://")) throw new Error("Production FILES_CDN_URL must use HTTPS.");
    if (values.DEV_HERMES_URL?.startsWith("http://")) {
      throw new Error("Production configuration must not contain a plaintext Hermes URL.");
    }
    const legalMaxBytes = values.LEGAL_MAX_BYTES ? Number(values.LEGAL_MAX_BYTES) : DEFAULT_LEGAL_MAX_BYTES;
    if (!Number.isSafeInteger(legalMaxBytes) || legalMaxBytes < 1 || legalMaxBytes > MAX_LEGAL_MAX_BYTES) {
      throw new Error(`LEGAL_MAX_BYTES must be an integer between 1 and ${MAX_LEGAL_MAX_BYTES}.`);
    }
    const legalDirectory = values.LEGAL_DOCUMENTS_DIR?.trim();
    for (const [slug, name] of [["mentions", "LEGAL_MENTIONS_FILE"], ["privacy", "LEGAL_PRIVACY_FILE"], ["terms", "LEGAL_TERMS_FILE"]] as const) {
      const filePath = values[name]?.trim() || (legalDirectory ? `${legalDirectory}/${slug}.md` : "");
      if (!filePath) throw new Error(`${name} (or LEGAL_DOCUMENTS_DIR) is required in ${fileOf(name)}.`);
      assertLegalFile(filePath, legalMaxBytes, slug);
    }
  }
  console.info(`${files.map((file) => file.path).join(", ")}: ${mode} configuration is valid.`);

  /** The database a `postgres://` DSN points at, or null when unreadable. */
  function databaseOfDsn(dsn: string | undefined): string | null {
    const value = dsn?.trim();
    if (!value) return null;
    try {
      const name = new URL(value).pathname.replace(/^\//u, "");
      return name || null;
    } catch {
      return null;
    }
  }

  function assertSameDatabase(values: Record<string, string | undefined>): void {
    const declared = databaseOfDsn(values.API_DATABASE_URL) ?? "openedbot";
    const database = databaseOfDsn(values.WORKER_DATABASE_URL);
    if (database && database !== declared) {
      throw new Error(
        `WORKER_DATABASE_URL points at the database "${database}" while API_DATABASE_URL points at "${declared}". ` +
          "Migrations and the worker would use different databases.",
      );
    }
  }

  function assertEncryptionKey(value: string, name: string): void {
    if (Uint8Array.from(Buffer.from(value, "base64")).byteLength !== 32) {
      throw new Error(`${name} must decode to 32 bytes.`);
    }
  }
}

async function runAudit(): Promise<void> {
  /**
   * Reports what is superfluous in the private env files, by name only, and
   * removes it with `--apply`.
   *
   * The monorepo keeps ONE file (see ENV_DIR_OF_SCOPE): this script reads it,
   * refuses a name declared twice, and reports a variable sitting in a file
   * that is no longer read — which `env-template --write-local` then moves.
   */

  const DEV_TEMPLATE = ".env.example";
  const localName = basename(process.env.ENV_FILE?.trim() || ".env.local");
  const apply = process.argv.includes("--apply");

  const templates = await readEnvFiles(DEV_TEMPLATE);
  const { values: templateValues } = mergeEnvFiles(templates);
  for (const template of templates) {
    assertUniqueEnvNames(template.path, template.entries.map((entry) => entry.name));
    const misplaced = template.entries
      .map((entry) => entry.name)
      .filter((name) => {
        const declared = envSchemaEntry(name);
        return !declared || declared.tier !== "local" || ENV_DIR_OF_SCOPE[declared.scope] !== template.dir;
      });
    if (misplaced.length) {
      throw new Error(`${template.path} lists variables that do not belong to it: ${misplaced.join(", ")}`);
    }
  }

  console.info(`${DEV_TEMPLATE}: ${Object.keys(templateValues).length} local variables across ${templates.length} file(s).`);
  console.info(`production variables: ${envNamesOfTier("production").size} declared in the schema (\`make env-prod-list\`).`);

  const locals = await readEnvFiles(localName);
  if (!locals.length) {
    console.info(`${localName}: absent; templates are consistent.`);
    process.exit(0);
  }
  // Refuses a name declared twice across the files.
  mergeEnvFiles(locals);
  const runtimeMode = RUNTIME_MODE;

  const removable: string[] = [];
  const kept: string[] = [];
  const misfiled: string[] = [];

  for (const local of locals) {
    const nextLines: string[] = [];
    for (const line of local.text.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) {
        nextLines.push(line);
        continue;
      }
      const decision = classifyLocalEnvEntry(parsed, runtimeMode);
      if (decision === "remove") {
        removable.push(`${parsed.name} (${local.path})`);
        continue;
      }
      if (decision === "preserve") kept.push(parsed.name);
      const declared = envSchemaEntry(parsed.name);
      const owner = declared ? ENV_DIR_OF_SCOPE[declared.scope] : local.dir;
      if (owner !== local.dir) misfiled.push(`${parsed.name}: ${local.path} -> ${envFilePath(owner, localName)}`);
      nextLines.push(line);
    }

    if (apply && nextLines.join("\n") !== local.text.split(/\r?\n/).join("\n")) {
      const temporary = `${local.path}.tmp`;
      await writeFile(temporary, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, local.path);
    }
  }

  console.info(`${localName}: removable empty or obsolete variables: ${removable.sort().join(", ") || "none"}.`);
  if (kept.length) console.info(`${localName}: preserved non-empty non-local variables: ${[...new Set(kept)].sort().join(", ")}.`);
  for (const line of misfiled.sort()) {
    console.info(`${localName}: in the wrong file, \`bun scripts/env.ts --template --write-local\` moves it — ${line}`);
  }
  if (apply && removable.length) console.info(`${localName}: removed ${removable.length} obsolete or empty non-local variables.`);
}

/**
 * Generates the environment templates from the schema.
 *
 *   --check             exit 1 when .env.example differs from what the schema
 *                       generates (diff-like report, no values of any private
 *                       file are read).
 *   --write             regenerate .env.example.
 *   --print-production  write the production template to stdout. Deployment
 *                       values are secret-manager owned, so the repository
 *                       keeps no production file to drift from the schema.
 *   --write-local       rewrite ENV_FILE (default .env.local) in schema
 *                       order, keeping every existing value and applying the
 *                       same removal rules as `env-audit --apply`. Never
 *                       prints a value.
 */

const DEV_TEMPLATE = ".env.example";
const SCHEMA_PATH = "platform/config/src/env-schema.ts";

/**
 * What the file is for, printed at its top. There is exactly one now: the
 * whole monorepo reads the root file, and the sections below say which
 * process reads which block.
 */
const DIR_PURPOSE: Record<string, string> = {
  ".": "The whole monorepo: API, worker, PWA, staff backoffice, Makefile and shell scripts.",
};

/**
 * One banner per workspace of the monorepo, in ENV_SCOPE_ORDER. Depuis que
 * tout tient dans un seul fichier, ces bannières SONT le classement : elles
 * disent quel processus lit quel bloc, à la place des dossiers.
 */
const SCOPE_TITLES: Record<EnvScope, string> = {
  shared: "SHARED  —  API + WORKER",
  api: "API  —  apps/api",
  worker: "WORKER  —  apps/worker",
  web: "WEB  —  apps/console (PWA)",
  admin: "ADMIN  —  staff backoffice (external plug-in)",
  scripts: "SCRIPTS AND MAKEFILE",
};

const BANNER_WIDTH = 72;

/** `########## TITLE ##########`, padded to a constant width. */
function banner(title: string): string {
  const label = ` ${title} `;
  const hashes = Math.max(2, BANNER_WIDTH - label.length);
  const left = Math.floor(hashes / 2);
  return `${"#".repeat(left)}${label}${"#".repeat(hashes - left)}`;
}

const GENERATED_FROM = `Generated from ${SCHEMA_PATH} by \`make env-template\`.`;

const ROOT_NOTES = [
  "`make setup` writes DEV_HERMES_URL from its profile: MODE=fake (default) points",
  "at tests/fake-hermes, MODE=external at your runtime. No lab URL is defaulted.",
];

function devHeader(dir: string): string[] {
  return [
    `openedbot local development — ${envFilePath(dir, DEV_TEMPLATE)}.`,
    DIR_PURPOSE[dir] ?? "",
    "",
    ...siblingNote(dir, DEV_TEMPLATE),
    ...(dir === "." ? [...ROOT_NOTES, ""] : []),
    GENERATED_FROM,
    "Edit the schema, never this file; `make test-unit` fails when they differ.",
  ];
}

/**
 * Le renvoi vers les autres fichiers du monorepo — vide tant qu'il n'y en a
 * qu'un. Une liste « le reste est dans : » suivie de rien serait un mensonge
 * de plus à lire à chaque ouverture du fichier.
 */
function siblingNote(dir: string, fileName: string): string[] {
  const siblings = ENV_DIRS.filter((other) => other !== dir).map((other) => envFilePath(other, fileName));
  if (!siblings.length) return [];
  return ["One variable lives in exactly one file; the rest of the monorepo is in:", ...siblings.map((path) => `  ${path}`), ""];
}
const PROD_HEADER = [
  "Production template, printed by `make env-prod-list`. Values are",
  "deployment-owned and must come from a secret manager or a protected",
  "environment file; this repository stores no production file.",
  "",
  GENERATED_FROM,
];

async function runTemplate(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--check") {
    process.exit(await check());
  } else if (mode === "--write") {
    await write();
  } else if (mode === "--print-production") {
    process.stdout.write(productionTemplate());
  } else if (mode === "--write-local") {
    await writeLocal(basename(process.env.ENV_FILE?.trim() || ".env.local"));
  } else {
    console.error("usage: bun scripts/env.ts --template --check | --write | --print-production | --write-local");
    process.exit(2);
  }
}

function render(header: readonly string[], entries: readonly EnvTemplateEntry[]): string {
  const lines: string[] = [
    "#".repeat(BANNER_WIDTH),
    ...header.map((line) => (line ? `# ${line}` : "#")),
    "#".repeat(BANNER_WIDTH),
  ];
  let currentScope: EnvScope | null = null;
  for (const { entry, value } of entries) {
    if (entry.scope !== currentScope) {
      currentScope = entry.scope;
      lines.push("", "#".repeat(BANNER_WIDTH), banner(SCOPE_TITLES[entry.scope]), "#".repeat(BANNER_WIDTH));
    }
    lines.push("", `# ${entry.doc}`, `${entry.name}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function generated(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const dir of ENV_DIRS) {
    files[envFilePath(dir, DEV_TEMPLATE)] = render(devHeader(dir), localTemplateEntries(dir));
  }
  return files;
}

/** The production template, rendered on demand and never written to disk. */
export function productionTemplate(): string {
  return render(PROD_HEADER, productionTemplateEntries());
}

async function check(): Promise<number> {
  let failures = 0;
  for (const [path, expected] of Object.entries(generated())) {
    const file = Bun.file(path);
    const actual = (await file.exists()) ? await file.text() : "";
    if (actual === expected) {
      console.info(`${path}: matches ${SCHEMA_PATH}.`);
      continue;
    }
    failures += 1;
    console.error(`${path}: differs from what ${SCHEMA_PATH} generates (run \`make env-template\`).`);
    for (const line of diffLines(actual, expected)) console.error(line);
  }
  return failures ? 1 : 0;
}

/** Line-level report: `-` lines only in the file, `+` lines only in the schema output. */
function diffLines(actual: string, expected: string): string[] {
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const actualSet = new Set(actualLines);
  const expectedSet = new Set(expectedLines);
  const report: string[] = [];
  actualLines.forEach((line, index) => {
    if (!expectedSet.has(line)) report.push(`- ${index + 1}: ${line}`);
  });
  expectedLines.forEach((line, index) => {
    if (!actualSet.has(line)) report.push(`+ ${index + 1}: ${line}`);
  });
  if (!report.length) report.push("  (same lines, different order or line endings)");
  return report;
}

async function write(): Promise<void> {
  for (const [path, content] of Object.entries(generated())) {
    await Bun.write(path, content);
    console.info(`${path}: written from ${SCHEMA_PATH}.`);
  }
}

async function writeLocal(fileName: string): Promise<void> {
  const files = await readEnvFiles(fileName);
  if (!files.length) throw new Error(`No ${fileName} found in the monorepo; nothing to rewrite.`);
  const existing = mergeEnvFiles(files).values;
  const runtimeMode = RUNTIME_MODE;
  const unusedForMode = envUnusedForRuntimeMode(runtimeMode);

  const removed: string[] = [];
  const added: string[] = [];
  const preserved: string[] = [];
  const moved: string[] = [];
  const byDir = new Map<string, EnvTemplateEntry[]>(ENV_DIRS.map((dir) => [dir, []]));
  const sourceOf = new Map<string, string>();
  for (const file of files) for (const entry of file.entries) sourceOf.set(entry.name, file.dir);

  for (const entry of sortForTemplate(ENV_SCHEMA)) {
    const dir = ENV_DIR_OF_SCOPE[entry.scope];
    const value = existing[entry.name];
    if (value === undefined) {
      // Absent: only a local variable of this runtime mode is (re)introduced,
      // with its template example; nothing else is invented.
      if (entry.tier !== "local" || unusedForMode.has(entry.name)) continue;
      added.push(entry.name);
      byDir.get(dir)!.push({ entry, value: entry.example ?? "" });
      continue;
    }
    const decision = classifyLocalEnvEntry({ name: entry.name, value }, runtimeMode);
    if (decision === "remove") {
      removed.push(entry.name);
      continue;
    }
    if (decision === "preserve") preserved.push(entry.name);
    const from = sourceOf.get(entry.name);
    if (from !== undefined && from !== dir) {
      moved.push(`${entry.name}: ${envFilePath(from, fileName)} -> ${envFilePath(dir, fileName)}`);
    }
    byDir.get(dir)!.push({ entry, value });
  }

  // Unknown to the schema: kept verbatim in the root file, as env-audit does,
  // so that nothing an operator added on purpose disappears silently.
  const unknown: string[] = [];
  for (const file of files) {
    for (const parsed of file.entries) {
      if (envSchemaEntry(parsed.name)) continue;
      if (isDeprecatedEnvName(parsed.name)) {
        removed.push(parsed.name);
        continue;
      }
      const line = `${parsed.name}=${parsed.value}`;
      if (!unknown.includes(line)) unknown.push(line);
    }
  }

  for (const dir of ENV_DIRS) {
    const entries = byDir.get(dir)!;
    const path = envFilePath(dir, fileName);
    // An application with no variable of its own gets no empty file. The root
    // one always exists: the Makefile reads DEV_HERMES_URL from it.
    if (!entries.length && dir !== "." && !unknown.length) {
      if (await Bun.file(path).exists()) {
        await unlink(path);
        console.info(`${path}: removed, no variable belongs to it any more.`);
      }
      continue;
    }
    let content = render(localHeader(dir, fileName), entries);
    if (dir === "." && unknown.length) {
      content += `\n${"#".repeat(BANNER_WIDTH)}\n${banner(`NOT DECLARED IN ${SCHEMA_PATH}`)}\n${"#".repeat(BANNER_WIDTH)}\n\n${unknown.join("\n")}\n`;
    }
    const temporary = `${path}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    console.info(`${path}: ${entries.length} variable(s).`);
  }

  console.info(`runtime mode ${runtimeMode}; removed: ${removed.sort().join(", ") || "none"}.`);
  console.info(`added from the template: ${added.sort().join(", ") || "none"}.`);
  for (const line of moved.sort()) console.info(`moved ${line}`);
  if (preserved.length) console.info(`preserved non-empty non-local variables: ${preserved.sort().join(", ")}.`);
  if (unknown.length) console.info(`kept ${unknown.length} variable(s) unknown to the schema in ${fileName}.`);
}

function localHeader(dir: string, fileName: string): string[] {
  return [
    `openedbot local environment — ${envFilePath(dir, fileName)}. Your values; mode 0600, never committed.`,
    DIR_PURPOSE[dir] ?? "",
    "",
    ...siblingNote(dir, fileName),
    `Sections and order come from ${SCHEMA_PATH}. Rewrite this file with`,
    "`bun scripts/env.ts --template --write-local`, which keeps every value.",
  ];
}

function runWhere(): void {
  /**
   * Answers "where is this variable declared, and which file should hold it?".
   *
   * The monorepo keeps ONE file, and several tiers never appear in it at all —
   * a `default_only` variable has a code default and belongs in no template. Without this, the only way to find out was to read the
   * schema, and "it is in no .env" looks exactly like "it does not exist".
   *
   *   bun scripts/env.ts --where API_PORT        one variable, in full
   *   bun scripts/env.ts --where PORT            every name containing PORT
   *   bun scripts/env.ts --where                 every declared variable, one line each
   *
   *   ENV_FILE   name of the private file (default .env.local).
   */

  const fileName = (process.env.ENV_FILE?.trim() || ".env.local").split("/").pop()!;
  const query = process.argv[2]?.trim().toUpperCase();

  /** Where the variable would sit if it were set, template or private file. */
  function homeOf(entry: EnvVar): string {
    const dir = ENV_DIR_OF_SCOPE[entry.scope];
    switch (entry.tier) {
      case "local":
        return `${envFilePath(dir, ".env.example")} -> ${envFilePath(dir, fileName)}`;
      case "production":
        return `no file: deployment-owned, see \`make env-prod-list\``;
      case "default_only":
        return `no file: code default; if you set it, ${envFilePath(dir, fileName)}`;
    }
  }

  function requiredWhere(entry: EnvVar): string {
    if (!entry.requiredWhen) return "never required";
    const environments = entry.requiredWhen.environment?.join(", ") ?? "any environment";
    const modes = entry.requiredWhen.runtimeMode?.join(", ");
    return `required in ${environments}${modes ? ` (runtime mode ${modes})` : ""}`;
  }

  const matches = query
    ? (ENV_SCHEMA_BY_NAME.has(query) ? [ENV_SCHEMA_BY_NAME.get(query)!] : ENV_SCHEMA.filter((entry) => entry.name.includes(query)))
    : [...ENV_SCHEMA];

  if (!matches.length) {
    console.error(`No declared variable matches ${query}. Declare it in platform/config/src/env-schema.ts.`);
    process.exit(1);
  }

  if (matches.length === 1 && query) {
    const entry = matches[0]!;
    console.info(`${entry.name}`);
    console.info(`  workspace  ${entry.scope}`);
    console.info(`  tier       ${entry.tier}`);
    console.info(`  file       ${homeOf(entry)}`);
    console.info(`  ${requiredWhere(entry)}${entry.secret ? ", secret" : ""}`);
    console.info(`  ${entry.doc}`);
    if (isEnvRequired(entry, "production", undefined)) console.info("  `make env-check --production` demands a value.");
  } else {
    for (const entry of matches) {
      console.info(`${entry.name.padEnd(38)} ${entry.scope.padEnd(8)} ${entry.tier.padEnd(13)} ${homeOf(entry)}`);
    }
    console.info(`\n${matches.length} variable(s). Pass an exact name for the full record.`);
  }
}

function runFileOf(): void {
  /**
   * Prints `NAME<TAB>path` for every declared variable, for the shell scripts.
   *
   * `scripts/setup.sh` writes generated secrets into the private env files, and
   * since the monorepo keeps one file per workspace it has to know which. Bash
   * cannot import the schema, and asking Bun once per variable would pay a
   * process start each time — so the whole map is emitted in one call.
   *
   *   ENV_FILE   name of the private file (default .env.local).
   */

  const fileName = (process.env.ENV_FILE?.trim() || ".env.local").split("/").pop()!;
  const lines = ENV_SCHEMA.map((entry) => `${entry.name}\t${envFilePath(ENV_DIR_OF_SCOPE[entry.scope], fileName)}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

const args = process.argv.slice(2);
const command = args[0];
if (
  command !== "--check" &&
  command !== "--audit" &&
  command !== "--template" &&
  command !== "--where" &&
  command !== "--file-of"
) {
  usage();
}

process.argv = [process.argv[0]!, process.argv[1]!, ...args.slice(1)];

switch (command) {
  case "--check":
    await runCheck();
    break;
  case "--audit":
    await runAudit();
    break;
  case "--template":
    await runTemplate();
    break;
  case "--where":
    runWhere();
    break;
  case "--file-of":
    runFileOf();
    break;
}
