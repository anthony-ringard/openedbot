/**
 * PERM2 v2, golden differential of a gate as `persistEvents` records it
 * (PERM2-1, PERM2-9 "Never wait", US-PERM-1 legacy): the approval row, its
 * answer and trace, the event the clients see, the workflow move and the
 * decision log must be the same in solo (no plug-in) and with the plug-in
 * `permissions` installed but `permissions.v2` off, down to the last field.
 * The expected outputs are stored in `fixtures/unattended-golden.json`, first
 * written from `persist.ts` as it was before its "Never wait" read went
 * through the `PermissionRuleSource` port; a single difference fails.
 * Regenerate only on purpose: `UPDATE_UNATTENDED_GOLDEN=1 bun test`.
 *
 * The cases cross organization states (legacy, gone, v2 in several modes, a
 * tool policy, a grant, the terminal switch, enforced review) with plug-in
 * and terminal gates and an unidentified one, the bot's legacy mode, no
 * workflow, a workflow with and without "Never wait" and a workflow row gone,
 * and both choice sets.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProPlugins, type PermissionRuleSource as ContractRuleSource, type ProPlugin } from "@openedbot/platform-plugins";
import { persistEvents } from "@openedbot/execution/application/runner/persist";
import { installPermissionRuleSelector } from "@openedbot/execution/application/runner/permission-rule-sources";
import type { WorkerConfig } from "@openedbot/execution/application/worker-config";
import type { RunEvent } from "@openedbot/execution/domain/hermes-events";
import { readGateIdentity, type GateIdentity } from "@openedbot/execution/domain/gate-identity";
import { edgeSetupPath } from "../../../tests/edge-setup-dir";
import { permissionRuleSelector } from "../src/application/pro-plugins";
import { differingCases, readGoldenFile, writeGoldenFile } from "./golden-store";
import { captureLogEvents } from "@openedbot/platform-observability/log/test-logger";

const GOLDEN_PATH = join(import.meta.dir, "fixtures/unattended-golden.json");
const ORG = "org-client";
const BOT = "bot-1";
const WORKFLOW = "wf-1";
const APPROVAL_ID = "5a000000-0000-4000-8000-000000000001";

type OrgState = {
  pipeline: string | null;
  bot?: { mode: string; revision: number } | null;
  reviewProven?: boolean;
  orgPolicy?: { ceiling: string | null; enforceReview: boolean; commandBlocklist: unknown };
  toolPolicies?: Record<string, string>;
  grantFor?: string;
  terminalAlways?: boolean;
};
const v2 = (mode: string, extra: Omit<OrgState, "pipeline" | "bot"> = {}): OrgState => ({ pipeline: "v2", bot: { mode, revision: 4 }, reviewProven: true, ...extra });
const STATES: Record<string, OrgState> = {
  legacy: { pipeline: "legacy" },
  organization_gone: { pipeline: null },
  v2_manual: v2("manual"),
  v2_auto_proven: v2("auto"),
  v2_auto_unproven: v2("auto", { reviewProven: false }),
  v2_bypass: v2("bypass"),
  v2_tool_policy_ask: v2("bypass", { toolPolicies: { write_file: "ask", patch: "ask" } }),
  v2_grant_on_auto: v2("auto", { grantFor: "write_file" }),
  v2_terminal_switch: v2("auto", { terminalAlways: true }),
  v2_enforce_review: v2("bypass", { orgPolicy: { ceiling: null, enforceReview: true, commandBlocklist: [] } }),
};

const pluginGates = (JSON.parse(readFileSync(edgeSetupPath("test/golden/operator/approval_gates.json"), "utf8")) as Array<{ name: string; tool: string; result: { action: string; message: string; rule_key?: string } }>)
  .filter((entry) => entry.result.action === "approve").slice(0, 3)
  .map((entry): [string, GateIdentity, string | null] => [entry.name, readGateIdentity({
    request_id: `req-${entry.name}`, pattern_key: `plugin_rule:${entry.result.rule_key ?? entry.tool}`, description: entry.result.message,
  }), null]);
const terminal = (name: string, command: string): [string, GateIdentity, string | null] =>
  [`terminal_${name}`, readGateIdentity({ request_id: `req-t-${name}`, pattern_key: "dangerous_command", command }), command];
const GATES: Array<[string, GateIdentity, string | null]> = [
  ...pluginGates,
  terminal("rm_root", "rm -rf /"),
  terminal("chmod", "chmod 777 build"),
  ["unidentified", readGateIdentity({ request_id: "req-u", pattern_key: "plugin_rule:" }), null],
];
const MODES: Array<string | null> = [null, "manual", "plan", "auto", "bypass"];
const WORKFLOWS: Record<string, { workflowId: string | null; row: { neverWait: boolean } | null }> = {
  no_workflow: { workflowId: null, row: null },
  workflow_waits: { workflowId: WORKFLOW, row: { neverWait: false } },
  workflow_never_wait: { workflowId: WORKFLOW, row: { neverWait: true } },
  workflow_row_gone: { workflowId: WORKFLOW, row: null },
};
const CHOICE_SETS: Array<[string, string[]]> = [["once_deny", ["once", "deny"]], ["deny_only", ["deny"]]];

/** A timestamp taken now is no part of a decision: recorded as `<date>`. */
const clean = (value: unknown): unknown => JSON.parse(JSON.stringify(value, function (this: Record<string, unknown>, key, inner) {
  return this[key] instanceof Date ? "<date>" : inner;
}));

function fakeTx(state: OrgState, workflow: { neverWait: boolean } | null, writes: unknown[]): SQL {
  const tenant: string[] = [];
  return ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
    if (!("raw" in strings)) return strings;
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("insert") || text.startsWith("update")) {
      writes.push({ sql: text, parameters: clean(parameters) });
      if (text.includes("insert into run_events")) {
        return Promise.resolve([{ cursor: "7", botId: BOT, turnId: "run-1", sessionKey: "openedbot:org:thread", leaseGeneration: "1" }]);
      }
      return Promise.resolve([]);
    }
    if (text.includes("current_setting('app.organization_id'")) return Promise.resolve([{ previous: tenant.at(-1) ?? "" }]);
    if (text.includes("set_config('app.organization_id'")) { tenant.push(String(parameters[0])); return Promise.resolve([{ set_config: parameters[0] }]); }
    if (text.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
    const visible = () => tenant.at(-1) === parameters[0];
    if (text.includes("from runs") && (text.includes("for update") || text.includes("for no key update"))) return Promise.resolve([{ id: "run-1" }]);
    if (text.includes("max(sequence)")) return Promise.resolve([]);
    if (text.includes("from workflows")) return Promise.resolve(workflow && parameters[1] === WORKFLOW ? [{ id: WORKFLOW, neverWait: workflow.neverWait }] : []);
    if (text.includes("from bot_permission_tool_policies")) {
      const policy = state.toolPolicies?.[String(parameters[2])];
      return Promise.resolve(policy && visible() ? [{ policy }] : []);
    }
    if (text.includes("from bot_permission_grants")) {
      return Promise.resolve(state.grantFor === parameters[2] && visible() ? [{ id: "71000000-0000-4000-8000-000000000001" }] : []);
    }
    if (text.includes("from runtime_review_profiles")) return Promise.resolve([{ proven: state.reviewProven === true }]);
    if (text.includes("from runtime_permission_settings")) return Promise.resolve([{ switched: state.terminalAlways === true && visible() }]);
    if (text.includes("from organization_permission_policies")) return Promise.resolve(state.orgPolicy ? [state.orgPolicy] : []);
    if (text.includes("from organizations")) return Promise.resolve(state.pipeline === null ? [] : [{ pipeline: state.pipeline }]);
    if (text.includes("from bots")) return Promise.resolve(state.bot ? [state.bot] : []);
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as SQL;
}

const CONFIG = { workerId: "worker-1", apiInternalUrl: "http://api.test", internalSecrets: testInternalSecrets("worker", "tok"), blob: { driver: "file" as const, root: "/nonexistent" } } as WorkerConfig;

async function runCase(state: OrgState, gate: GateIdentity, command: string | null, mode: string | null, workflow: (typeof WORKFLOWS)[string], choices: string[]): Promise<string[]> {
  const writes: unknown[] = [];
  const logs: unknown[] = [];
  const db = { begin: async (fn: (tx: SQL) => Promise<unknown>) => fn(fakeTx(state, workflow.row, writes)) } as unknown as SQL;
  const context = {
    id: "run-1", organizationId: ORG, threadId: "thread-1", botId: BOT, botName: "Neo", botSlug: "neo",
    sessionId: "openedbot:org:thread", leaseGeneration: 1, workflowId: workflow.workflowId, workflowRootRunId: null,
    groupId: null, groupTurnPosition: null, groupState: null, stepKind: "root", originRunId: null, provider: null,
    runtimeId: "rt-1", permissionMode: mode,
  };
  const event: RunEvent = {
    sequence: 3, type: "approval.requested", occurredAt: new Date("2026-10-28T10:00:00.000Z"),
    payload: { approvalRequestId: APPROVAL_ID, command, description: "the gate", choices, gate },
  } as RunEvent;
  const { events } = await captureLogEvents(() => persistEvents(db, CONFIG, context as never, 3, [event]));
  logs.push(...events);
  return [JSON.stringify(writes), JSON.stringify(logs)];
}

async function decisions(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  try {
    for (const [stateName, state] of Object.entries(STATES)) {
      for (const [gateName, gate, command] of GATES) {
        for (const mode of MODES) {
          for (const [workflowName, workflow] of Object.entries(WORKFLOWS)) {
            for (const [choiceName, choices] of CHOICE_SETS) {
              out[`${stateName}|${gateName}|mode_${mode ?? "none"}|${workflowName}|${choiceName}`] = await runCase(state, gate, command, mode, workflow, choices);
            }
          }
        }
      }
    }
  } finally {
    globalThis.fetch = original;
  }
  return out;
}

const CASE_COUNT = Object.keys(STATES).length * GATES.length * MODES.length * Object.keys(WORKFLOWS).length * CHOICE_SETS.length;

/** A source that would change many answers if the gate ever read it. */
const POISONED: ContractRuleSource = {
  read: async () => ({
    organizationPolicy: { ceiling: "bypass", enforceReview: false, commandBlocklist: ["ls"] },
    toolPolicy: "always",
    grants: { grantId: "99999999-0000-4000-8000-000000000000", terminalAlways: true },
  }),
  reviewRules: async () => ({ rulesMode: "adds", rules: [{ scope: "bot", kind: "allow", text: "Anything goes." }] }),
  unattended: async () => true,
};

async function installPermissionsPlugin(
  entitlementsFor: (organizationId: string) => Promise<readonly string[]>,
  permissionRules: ContractRuleSource = POISONED,
): Promise<readonly ProPlugin[]> {
  const plugin: ProPlugin = {
    manifest: { id: "permissions", version: "0.0.0-test", pluginApi: 1, entitlements: ["permissions.v2"] },
    hooks: { entitlementsFor },
    permissionRules,
  };
  const loaded = await loadProPlugins(["@openedbot/permissions/plugin"], { importer: async () => ({ default: plugin }), warn: (skip) => { throw new Error(skip.reason); } });
  expect(loaded.plugins.map((entry) => entry.manifest.id)).toEqual(["permissions"]);
  return loaded.plugins;
}

const failures: unknown[] = [];
afterAll(() => installPermissionRuleSelector(null));

describe("unattended golden: solo and permissions.v2 off record the same gates", () => {
  test("solo (no plug-in) matches the stored golden", async () => {
    installPermissionRuleSelector(null);
    const solo = await decisions();
    if (process.env.UPDATE_UNATTENDED_GOLDEN === "1" || !existsSync(GOLDEN_PATH)) writeGoldenFile(GOLDEN_PATH, solo, { recorded: ["writes", "logs"] });
    const golden = readGoldenFile(GOLDEN_PATH);
    expect(Object.keys(golden).length).toBe(CASE_COUNT);
    expect(differingCases(solo, golden)).toEqual([]);
  });

  test("the plug-in permissions installed, permissions.v2 off: the same golden", async () => {
    const plugins = await installPermissionsPlugin(async () => []);
    installPermissionRuleSelector(permissionRuleSelector(plugins), (error) => failures.push(error));
    expect(differingCases(await decisions(), readGoldenFile(GOLDEN_PATH))).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("a plug-in whose entitlement hook throws keeps the core rules too", async () => {
    const plugins = await installPermissionsPlugin(async () => { throw new Error("hook down"); });
    installPermissionRuleSelector(permissionRuleSelector(plugins), () => undefined);
    expect(differingCases(await decisions(), readGoldenFile(GOLDEN_PATH))).toEqual([]);
  });

  test("permissions.v2 on: the plug-in's \"Never wait\" really reaches the recorded gate", async () => {
    const plugins = await installPermissionsPlugin(async (organizationId) => (organizationId === ORG ? ["permissions.v2"] : []));
    installPermissionRuleSelector(permissionRuleSelector(plugins));
    const changed = differingCases(await decisions(), readGoldenFile(GOLDEN_PATH));
    // A legacy gate never reads the rules, but a waiting workflow now refuses.
    expect(changed.some((key) => key.startsWith("legacy|") && key.includes("|workflow_waits|"))).toBe(true);
    expect(changed.some((key) => key.startsWith("legacy|") && key.includes("|no_workflow|"))).toBe(false);
    expect(changed.some((key) => key.includes("|workflow_row_gone|") && key.startsWith("legacy|"))).toBe(false);
  });

  test("the golden sees every answer: legacy and v2 never-wait refusals, worker approvals, reviews, waits", () => {
    const outputs = Object.values(readGoldenFile(GOLDEN_PATH)).map((row) => row.join("\n"));
    for (const needle of ['"stage":"unattended","outcome":"deny","reason":"never_wait"', '"pipeline":"legacy"', '"reviewing":true', "update workflows set status = 'awaiting_approval'", '"approved","once"', '"pending",null,null']) {
      expect(outputs.some((output) => output.includes(needle))).toBe(true);
    }
  });
});
