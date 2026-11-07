import { describe, expect, test } from "bun:test";
import {
  readInternalSecrets,
  runKeyCohortAllows,
  runKeySigningSecret,
  runKeyVerifiers,
} from "@openedbot/platform-config/internal-secrets";
import { readRoutineRunKeyWith, signRoutineRunKey } from "@openedbot/execution/application/routine-run-key";
import { readBotSettingsRunKeyWith, signBotSettingsRunKey } from "@openedbot/execution/application/bot-settings-run-key";

/**
 * Rotating RUN_KEY_SECRET (ADR 0001, 4.7). A run key lives as long as its run:
 * the API reads keys of the previous secret through RUN_KEY_PREVIOUS_SECRET,
 * for runs created before the bound only, until the database shows no run of
 * that cohort can still present one. That covers an old worker beside a new
 * API; the other direction (a new worker beside an API not yet updated) has no
 * overlap and is refused until the rolling update converges (DEPLOY-NOTES).
 */
const roles = {
  EVENTS_INTERNAL_TOKEN: "e".repeat(64),
  RELAY_INTERNAL_TOKEN: "r".repeat(64),
  INVENTORY_INTERNAL_TOKEN: "i".repeat(64),
};
const OLD = "o".repeat(64);
const NEW = "n".repeat(64);
const BOUND = "2026-11-07T12:00:00Z";
const RUN = "5f0f8a3a-1111-4222-8333-444455556666";
const BEFORE = new Date("2026-11-07T11:00:00Z");
const AFTER = new Date("2026-11-07T13:00:00Z");

const worker = (secret: string) => readInternalSecrets("worker", "production", { ...roles, RUN_KEY_SECRET: secret });
const api = (env: Record<string, string>) => readInternalSecrets("api", "production", { ...roles, ...env });

function accepts(apiEnv: Record<string, string>, signer: string, createdAt: Date): boolean {
  const verifiers = runKeyVerifiers(api(apiEnv));
  const secret = runKeySigningSecret(worker(signer));
  const routine = readRoutineRunKeyWith(verifiers, signRoutineRunKey(secret, RUN));
  const settings = readBotSettingsRunKeyWith(verifiers, signBotSettingsRunKey(secret, RUN));
  const ok = (read: typeof routine) => read !== null && read.runId === RUN && runKeyCohortAllows(read.verifier, createdAt);
  expect(ok(settings)).toBe(ok(routine));
  return ok(routine);
}

describe("RUN_KEY_SECRET rotation", () => {
  const rotating = { RUN_KEY_SECRET: NEW, RUN_KEY_PREVIOUS_SECRET: OLD, RUN_KEY_PREVIOUS_CREATED_BEFORE: BOUND };

  test("while rotating, the API reads keys of both secrets, the previous one for the cohort only", () => {
    expect(accepts(rotating, NEW, AFTER)).toBe(true);
    expect(accepts(rotating, NEW, BEFORE)).toBe(true);
    expect(accepts(rotating, OLD, BEFORE)).toBe(true);
    expect(accepts(rotating, OLD, AFTER)).toBe(false);
  });

  test("a worker still on the old secret beside an API already rotating keeps working for the runs it started", () => {
    expect(accepts(rotating, OLD, BEFORE)).toBe(true);
  });

  test("known limit: an API not yet updated refuses the keys a new worker signs, until it converges", () => {
    expect(accepts({ RUN_KEY_SECRET: OLD }, NEW, AFTER)).toBe(false);
  });

  test("once the previous secret is removed, its keys are refused whatever the run", () => {
    expect(accepts({ RUN_KEY_SECRET: NEW }, OLD, BEFORE)).toBe(false);
    expect(accepts({ RUN_KEY_SECRET: NEW }, NEW, BEFORE)).toBe(true);
  });
});
