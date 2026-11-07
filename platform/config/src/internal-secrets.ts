import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The secrets the API, the worker and the link gateway share for their internal
 * calls: one per role (ADR 0001, section 4.7, S1b), instead of the single
 * `WORKER_INTERNAL_TOKEN` that used to be the bearer of every internal route and
 * the HMAC key of run keys.
 *
 *   events     worker -> API `/internal/events/publish`
 *   relay      worker, API, gateway -> the relay routes `/internal/runtime-links/*`
 *              (proxy, dial, control, probe, hops between instances)
 *   inventory  gateway -> API `/internal/runtime-inventory/changed`
 *   runKey     the HMAC master secret of the run keys of the MCP tools (never a bearer)
 *
 * A process holds only the roles it uses (`PROCESS_INTERNAL_ROLES`): the type of
 * its secrets has no field for the others, so the gateway cannot sign a run key
 * nor publish an event.
 *
 * In production every role a process holds has its own variable. The former
 * single `WORKER_INTERNAL_TOKEN` (and the `INTERNAL_TOKENS_EMIT` of the cut-over)
 * is no longer read: a process that still finds one refuses to start, so a host
 * that skipped the migration fails loudly instead of running half-configured
 * (CHANGELOG: the migration of a self-hosted install).
 *
 * Rotating `RUN_KEY_SECRET`: `RUN_KEY_PREVIOUS_SECRET` reads (never signs) the
 * run keys of runs created before `RUN_KEY_PREVIOUS_CREATED_BEFORE`, the runs
 * signed with the previous secret that may still be alive (API only).
 */

export const INTERNAL_ROLES = ["events", "relay", "inventory", "runKey"] as const;
export type InternalRole = (typeof INTERNAL_ROLES)[number];

export const INTERNAL_ROLE_VARIABLES: Readonly<Record<InternalRole, string>> = {
  events: "EVENTS_INTERNAL_TOKEN",
  relay: "RELAY_INTERNAL_TOKEN",
  inventory: "INVENTORY_INTERNAL_TOKEN",
  runKey: "RUN_KEY_SECRET",
};
/** Variables of the cut-over, no longer read: their presence stops the process. */
export const RETIRED_INTERNAL_VARIABLES = ["WORKER_INTERNAL_TOKEN", "INTERNAL_TOKENS_EMIT"] as const;
export const RUN_KEY_PREVIOUS_SECRET_VARIABLE = "RUN_KEY_PREVIOUS_SECRET";
export const RUN_KEY_PREVIOUS_CREATED_BEFORE_VARIABLE = "RUN_KEY_PREVIOUS_CREATED_BEFORE";

export const PROCESS_INTERNAL_ROLES = {
  api: ["events", "relay", "inventory", "runKey"],
  worker: ["events", "relay", "runKey"],
  "link-gateway": ["relay", "inventory"],
} as const satisfies Record<string, readonly InternalRole[]>;
export type InternalProcess = keyof typeof PROCESS_INTERNAL_ROLES;
export type RolesOf<P extends InternalProcess> = (typeof PROCESS_INTERNAL_ROLES)[P][number];

/** Non-secret placeholders used outside production; every one is refused in production. */
export const DEV_INTERNAL_SECRETS: Readonly<Record<InternalRole, string>> = {
  events: "openedbot-events-dev-token",
  relay: "openedbot-relay-dev-token",
  inventory: "openedbot-inventory-dev-token",
  runKey: "openedbot-run-key-dev-secret",
};
const DEV_METRICS_INTERNAL_TOKEN = "openedbot-metrics-dev-token";
/** The former single development secret, published in old configurations: still refused in production. */
const DEV_FORMER_INTERNAL_TOKEN = "openedbot-worker-dev-token";
const DEV_VALUES = new Set<string>([DEV_FORMER_INTERNAL_TOKEN, DEV_METRICS_INTERNAL_TOKEN, ...Object.values(DEV_INTERNAL_SECRETS)]);

export type InternalSecretSource = "explicit" | "development";
export type InternalSecret = { readonly value: string; readonly source: InternalSecretSource };
export type RunKeyPrevious = { readonly secret: string; readonly createdBefore: Date };

/** The secrets of a process that holds at least the roles `R`. */
export type InternalSecretsWith<R extends InternalRole> = {
  readonly process: InternalProcess;
  readonly roles: { readonly [K in R]: InternalSecret };
  /** API only: the former run-key secret, for the cohort of runs created before the bound. */
  readonly runKeyPrevious: RunKeyPrevious | null;
};
export type InternalSecrets<P extends InternalProcess> = InternalSecretsWith<RolesOf<P>> & { readonly process: P };

type Environment = "development" | "test" | "production";
type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/**
 * Reads the internal secrets of `process`. Throws on any configuration that
 * could make two containers disagree or that weakens a secret in production.
 */
export function readInternalSecrets<P extends InternalProcess>(
  process: P,
  environment: Environment,
  env: Env = Bun.env,
): InternalSecrets<P> {
  const production = environment === "production";
  const retired = RETIRED_INTERNAL_VARIABLES.filter((name) => read(env, name) !== null);
  if (retired.length > 0) {
    throw new Error(
      `${retired.join(" and ")} ${retired.length > 1 ? "are" : "is"} no longer read: the internal secrets are one per role `
      + `(${Object.values(INTERNAL_ROLE_VARIABLES).join(", ")}). Give every role its own value, restart the API, the worker `
      + "and the link gateway together, and keep the runs in progress with RUN_KEY_PREVIOUS_SECRET (the former value) and "
      + `RUN_KEY_PREVIOUS_CREATED_BEFORE (the restart instant) on the API; then remove ${retired.length > 1 ? "them" : "it"} (CHANGELOG).`,
    );
  }
  const roles = {} as Record<InternalRole, InternalSecret>;
  const explicit: Array<[string, string]> = [];
  for (const role of PROCESS_INTERNAL_ROLES[process] as readonly InternalRole[]) {
    const name = INTERNAL_ROLE_VARIABLES[role];
    const own = read(env, name);
    if (own) {
      roles[role] = { value: own, source: "explicit" };
      explicit.push([name, own]);
    } else if (production) {
      throw new Error(`${name} is required in production.`);
    } else {
      roles[role] = { value: DEV_INTERNAL_SECRETS[role], source: "development" };
    }
  }

  let runKeyPrevious: RunKeyPrevious | null = null;
  if (process === "api") {
    const previous = read(env, RUN_KEY_PREVIOUS_SECRET_VARIABLE);
    const before = read(env, RUN_KEY_PREVIOUS_CREATED_BEFORE_VARIABLE);
    if ((previous === null) !== (before === null)) {
      throw new Error(`${RUN_KEY_PREVIOUS_SECRET_VARIABLE} and ${RUN_KEY_PREVIOUS_CREATED_BEFORE_VARIABLE} are set together or not at all.`);
    }
    if (previous && before) {
      const createdBefore = readUtcInstant(before);
      if (!createdBefore) {
        throw new Error(`${RUN_KEY_PREVIOUS_CREATED_BEFORE_VARIABLE} must be a valid UTC instant ending in Z (ISO 8601, e.g. 2026-11-07T12:00:00Z).`);
      }
      if (previous === roles.runKey.value) {
        throw new Error(`${RUN_KEY_PREVIOUS_SECRET_VARIABLE} must differ from the current run-key secret.`);
      }
      runKeyPrevious = { secret: previous, createdBefore };
    }
  }

  if (production) {
    const values: Array<[string, string]> = [...explicit];
    if (runKeyPrevious) values.push([RUN_KEY_PREVIOUS_SECRET_VARIABLE, runKeyPrevious.secret]);
    for (const [name, value] of values) {
      if (DEV_VALUES.has(value)) throw new Error(`${name} must not be a development default in production.`);
    }
    for (let i = 0; i < explicit.length; i += 1) {
      for (let j = i + 1; j < explicit.length; j += 1) {
        if (explicit[i]![1] === explicit[j]![1]) throw new Error(`${explicit[i]![0]} and ${explicit[j]![0]} must be distinct production secrets.`);
      }
      if (runKeyPrevious && explicit[i]![1] === runKeyPrevious.secret) {
        throw new Error(`${RUN_KEY_PREVIOUS_SECRET_VARIABLE} and ${explicit[i]![0]} must be distinct production secrets.`);
      }
    }
    const metrics = read(env, "METRICS_INTERNAL_TOKEN");
    if (metrics && values.some(([, value]) => value === metrics)) {
      throw new Error("METRICS_INTERNAL_TOKEN must be a distinct production secret.");
    }
  }

  return { process, roles: roles as InternalSecrets<P>["roles"], runKeyPrevious } as InternalSecrets<P>;
}

/**
 * A UTC instant, explicit and real: `YYYY-MM-DDTHH:MM:SS[.fff]Z` only. No local
 * time (two containers in different time zones would bound the cohort apart),
 * and no date the parser silently normalizes (February 30 becomes March 2).
 */
function readUtcInstant(value: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19) === match[1] ? date : null;
}

/** The `Authorization` value an emitter sends for `role`. */
export function internalBearer<R extends InternalRole>(secrets: InternalSecretsWith<R>, role: R): string {
  return `Bearer ${secrets.roles[role].value}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  // Hash first: timingSafeEqual needs equal lengths, and the length of the secret must not leak.
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

/** Whether an `Authorization` header carries the secret of `role`, and that one only. */
export function matchInternalBearer<R extends InternalRole>(
  secrets: InternalSecretsWith<R>,
  role: R,
  authorization: string | null | undefined,
): boolean {
  return constantTimeEqual(authorization ?? "", `Bearer ${secrets.roles[role].value}`);
}

/** The secret a run key is signed with now. */
export function runKeySigningSecret(secrets: InternalSecretsWith<"runKey">): string {
  return secrets.roles.runKey.value;
}

export type RunKeyVerifier =
  | { secret: string; via: "role" }
  | { secret: string; via: "previous"; createdBefore: Date };

/**
 * The secrets a run key may verify against, in order. A key read through
 * `previous` is valid only for a run created before `createdBefore`: the caller
 * checks it against the run it loads (`runKeyCohortAllows`).
 */
export function runKeyVerifiers(secrets: InternalSecretsWith<"runKey">): RunKeyVerifier[] {
  const verifiers: RunKeyVerifier[] = [{ secret: secrets.roles.runKey.value, via: "role" }];
  const previous = secrets.runKeyPrevious;
  if (previous) {
    verifiers.push({ secret: previous.secret, via: "previous", createdBefore: previous.createdBefore });
  }
  return verifiers;
}

/** Whether a run key read through `verifier` is acceptable for a run created at `runCreatedAt`. */
export function runKeyCohortAllows(verifier: RunKeyVerifier, runCreatedAt: Date): boolean {
  return verifier.via !== "previous" || runCreatedAt.getTime() < verifier.createdBefore.getTime();
}

/** What a process logs at start: the mode, never a value nor a digest of one. */
export function describeInternalSecrets(secrets: InternalSecretsWith<never>): Record<string, unknown> {
  return {
    process: secrets.process,
    roles: Object.fromEntries(Object.entries(secrets.roles as Record<string, InternalSecret>).map(([role, secret]) => [role, secret.source])),
    runKeyPreviousCreatedBefore: secrets.runKeyPrevious?.createdBefore.toISOString() ?? null,
  };
}

/**
 * Internal secrets for tests: every role of `process` with its development value,
 * or the given variables, or one string for every role (tests that send a bearer
 * by hand; only production requires distinct values).
 */
export function testInternalSecrets<P extends InternalProcess>(process: P, overrides: Env | string = {}): InternalSecrets<P> {
  const env = typeof overrides === "string"
    ? Object.fromEntries(Object.values(INTERNAL_ROLE_VARIABLES).map((name) => [name, overrides]))
    : overrides;
  return readInternalSecrets(process, "test", env);
}
