import { describe, expect, test } from "bun:test";
import {
  DEV_INTERNAL_SECRETS,
  describeInternalSecrets,
  internalBearer,
  matchInternalBearer,
  readInternalSecrets,
  runKeyCohortAllows,
  runKeySigningSecret,
  runKeyVerifiers,
} from "../src/internal-secrets";

const split = {
  EVENTS_INTERNAL_TOKEN: "e".repeat(64),
  RELAY_INTERNAL_TOKEN: "r".repeat(64),
  INVENTORY_INTERNAL_TOKEN: "i".repeat(64),
  RUN_KEY_SECRET: "k".repeat(64),
};
const PREVIOUS = "p".repeat(64);

describe("readInternalSecrets", () => {
  test("outside production every role has its own development value, never a shared one", () => {
    const secrets = readInternalSecrets("api", "development", {});
    expect(secrets.roles.events.value).toBe(DEV_INTERNAL_SECRETS.events);
    expect(secrets.roles.relay.value).toBe(DEV_INTERNAL_SECRETS.relay);
    expect(new Set(Object.values(secrets.roles).map((secret) => secret.value)).size).toBe(4);
  });

  test("a process holds only its roles", () => {
    const gateway = readInternalSecrets("link-gateway", "production", { RELAY_INTERNAL_TOKEN: split.RELAY_INTERNAL_TOKEN, INVENTORY_INTERNAL_TOKEN: split.INVENTORY_INTERNAL_TOKEN });
    expect(Object.keys(gateway.roles).sort()).toEqual(["inventory", "relay"]);
    const worker = readInternalSecrets("worker", "production", { EVENTS_INTERNAL_TOKEN: split.EVENTS_INTERNAL_TOKEN, RELAY_INTERNAL_TOKEN: split.RELAY_INTERNAL_TOKEN, RUN_KEY_SECRET: split.RUN_KEY_SECRET });
    expect(Object.keys(worker.roles).sort()).toEqual(["events", "relay", "runKey"]);
    expect(describeInternalSecrets(worker)).toEqual({
      process: "worker",
      roles: { events: "explicit", relay: "explicit", runKey: "explicit" },
      runKeyPreviousCreatedBefore: null,
    });
  });

  test("production requires every role of the process, without dev values, distinct", () => {
    expect(() => readInternalSecrets("worker", "production", {})).toThrow(/EVENTS_INTERNAL_TOKEN is required in production/);
    expect(() => readInternalSecrets("api", "production", { ...split, RELAY_INTERNAL_TOKEN: DEV_INTERNAL_SECRETS.relay })).toThrow(/development default/);
    // The former single development secret is public too: no role, nor the previous run-key secret, may reuse it.
    for (const name of Object.keys(split)) {
      expect(() => readInternalSecrets("api", "production", { ...split, [name]: "openedbot-worker-dev-token" })).toThrow(/development default/);
    }
    expect(() => readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: "openedbot-worker-dev-token", RUN_KEY_PREVIOUS_CREATED_BEFORE: "2026-11-07T12:00:00Z" })).toThrow(/development default/);
    expect(() => readInternalSecrets("api", "production", { ...split, INVENTORY_INTERNAL_TOKEN: split.EVENTS_INTERNAL_TOKEN })).toThrow(/distinct/);
    expect(() => readInternalSecrets("api", "production", { ...split, METRICS_INTERNAL_TOKEN: split.RUN_KEY_SECRET })).toThrow(/METRICS_INTERNAL_TOKEN/);
  });

  test("the former single secret and the cut-over flag stop the process, in every environment, naming no value", () => {
    for (const environment of ["development", "test", "production"] as const) {
      expect(() => readInternalSecrets("api", environment, { ...split, WORKER_INTERNAL_TOKEN: "l".repeat(64) })).toThrow(/WORKER_INTERNAL_TOKEN is no longer read/);
      expect(() => readInternalSecrets("worker", environment, { ...split, INTERNAL_TOKENS_EMIT: "split" })).toThrow(/INTERNAL_TOKENS_EMIT is no longer read/);
    }
    // A host that never migrated learns how, not just what is missing.
    let message = "";
    try { readInternalSecrets("api", "production", { WORKER_INTERNAL_TOKEN: "l".repeat(64) }); } catch (error) { message = String(error); }
    expect(message).toContain("RUN_KEY_PREVIOUS_SECRET (the former value)");
    expect(message).not.toContain("l".repeat(8));
    // Left empty in a template, it is harmless and ignored.
    expect(readInternalSecrets("api", "production", { ...split, WORKER_INTERNAL_TOKEN: "", INTERNAL_TOKENS_EMIT: " " }).roles.events.value).toBe(split.EVENTS_INTERNAL_TOKEN);
  });

  test("run-key previous secret: API only, with its bound, distinct from the current one", () => {
    const before = "2026-11-07T12:00:00.000Z";
    const api = readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: PREVIOUS, RUN_KEY_PREVIOUS_CREATED_BEFORE: before });
    expect(api.runKeyPrevious).toEqual({ secret: PREVIOUS, createdBefore: new Date(before) });
    expect(() => readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: PREVIOUS })).toThrow(/set together/);
    for (const bound of ["yesterday", "2026-11-07T12:00:00", "2026-11-07T12:00:00+01:00", "2026-02-30T12:00:00Z", "2026-11-07T24:00:00Z", "2026-11-07"]) {
      expect(() => readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: PREVIOUS, RUN_KEY_PREVIOUS_CREATED_BEFORE: bound })).toThrow(/UTC instant/);
    }
    expect(readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: PREVIOUS, RUN_KEY_PREVIOUS_CREATED_BEFORE: "2026-11-07T12:00:00.5Z" }).runKeyPrevious?.createdBefore.toISOString()).toBe("2026-11-07T12:00:00.500Z");
    expect(() => readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: split.RUN_KEY_SECRET, RUN_KEY_PREVIOUS_CREATED_BEFORE: before })).toThrow(/differ/);
    expect(() => readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: split.RELAY_INTERNAL_TOKEN, RUN_KEY_PREVIOUS_CREATED_BEFORE: before })).toThrow(/distinct|differ/);
    expect(readInternalSecrets("worker", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: PREVIOUS, RUN_KEY_PREVIOUS_CREATED_BEFORE: before }).runKeyPrevious).toBeNull();
  });
});

describe("bearers", () => {
  test("each route accepts the secret of its role only", () => {
    const secrets = readInternalSecrets("api", "production", split);
    expect(internalBearer(secrets, "events")).toBe(`Bearer ${split.EVENTS_INTERNAL_TOKEN}`);
    for (const role of ["events", "relay", "inventory"] as const) {
      for (const [name, value] of Object.entries(split)) {
        const expected = name.startsWith(role === "events" ? "EVENTS" : role === "relay" ? "RELAY" : "INVENTORY");
        expect(matchInternalBearer(secrets, role, `Bearer ${value}`)).toBe(expected);
      }
    }
    expect(matchInternalBearer(secrets, "relay", undefined)).toBe(false);
    expect(matchInternalBearer(secrets, "relay", split.RELAY_INTERNAL_TOKEN)).toBe(false);
    expect(matchInternalBearer(secrets, "relay", `Bearer ${split.RELAY_INTERNAL_TOKEN} `)).toBe(false);
  });
});

describe("run keys", () => {
  test("signed with the role's secret", () => {
    expect(runKeySigningSecret(readInternalSecrets("worker", "production", split))).toBe(split.RUN_KEY_SECRET);
  });

  test("the previous secret reads only the cohort of runs created before its bound", () => {
    const before = new Date("2026-11-07T12:00:00.000Z");
    const secrets = readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: PREVIOUS, RUN_KEY_PREVIOUS_CREATED_BEFORE: before.toISOString() });
    const verifiers = runKeyVerifiers(secrets);
    expect(verifiers.map((verifier) => verifier.via)).toEqual(["role", "previous"]);
    const previous = verifiers[1]!;
    expect(runKeyCohortAllows(previous, new Date(before.getTime() - 1))).toBe(true);
    expect(runKeyCohortAllows(previous, before)).toBe(false);
    expect(runKeyCohortAllows(verifiers[0]!, new Date(before.getTime() + 60_000))).toBe(true);
    expect(runKeyVerifiers(readInternalSecrets("api", "production", split)).map((verifier) => verifier.via)).toEqual(["role"]);
  });
});
