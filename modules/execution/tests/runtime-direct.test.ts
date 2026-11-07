import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { encryptSecret, secretEncryptionKey } from "@openedbot/hermes";
import { createRuntimeClient, type RuntimeClientContext, type RuntimeClientConfig } from "@openedbot/execution/application/runtime-client";
import { probeDirectRuntimes, failRunsOnUnhealthyDirectRuntimes } from "../src/application/runtime-direct";
import { resolveToolsetScope } from "@openedbot/execution/application/runner";

const key = secretEncryptionKey(new Uint8Array(32).fill(4));
const previous = secretEncryptionKey(new Uint8Array(32).fill(3));
const token = encryptSecret("worker-direct-bearer", previous.value);
const edge = encryptSecret('{"clientId":"edge-id","clientSecret":"edge-secret"}', previous.value);
const row: RuntimeClientContext = { runtimeId: "rt-1", reachability: "direct", runtimeEndpoint: "http://127.0.0.1:18642", hermesProfile: "old-profile",
  tokenCiphertext: token.ciphertext, tokenNonce: token.nonce, tokenTag: token.tag, tokenKeyId: previous.id,
  edgeAuthCiphertext: edge.ciphertext, edgeAuthNonce: edge.nonce, edgeAuthTag: edge.tag, edgeAuthKeyId: previous.id };
const config: RuntimeClientConfig = { apiInternalUrl: "http://127.0.0.1:8790", internalSecrets: testInternalSecrets("worker", "internal-only"),
  tokenEncryption: { current: key, previous: [previous] }, hermesEndpointPolicy: { environment: "test", testHttpUrl: row.runtimeEndpoint! }, hermesMtls: null };
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

test("direct worker decrypts previous keys, sends root requests and never sends its internal bearer", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Response.json({ status: "ok" });
  }) as typeof fetch);
  await createRuntimeClient(row, config).probe();
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => new URL(request.url).pathname).sort()).toEqual(["/health", "/v1/capabilities"]);
  for (const request of requests) {
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer worker-direct-bearer");
    expect(headers.get("cf-access-client-id")).toBe("edge-id");
    expect(headers.get("cf-access-client-secret")).toBe("edge-secret");
  }
  const scope = await resolveToolsetScope({ probeProfileIsolation: async () => { throw new Error("must not probe named profiles"); } }, { reachability: "direct", hermesProfile: "old-profile", hermesProfileManaged: true });
  expect(scope).toBe("runtime");
});

function fakeDb() {
  let remaining = true;
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ? ").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.startsWith("select id as") && remaining) { remaining = false; return [{ ...row, organizationId: "org-1" }]; }
    if (sql.startsWith("update runs set status = 'failed'")) return [{ id: "run-1", organizationId: "org-1", threadId: "thread-1", workflowId: "wf-1", leaseGeneration: 0 }];
    if (sql.startsWith("insert into run_events")) return [{ cursor: "1", botId: null, turnId: "run-1", sessionKey: null, leaseGeneration: "0", occurredAt: new Date() }];
    return [];
  }) as unknown as SQL;
  (tx as unknown as { begin: (fn: (inner: Bun.TransactionSQL) => Promise<unknown>) => Promise<unknown> }).begin = (fn) => fn(tx as unknown as Bun.TransactionSQL);
  return { db: tx, calls };
}

test("direct health probe records success or bounded failure without leaking exception contents", async () => {
  for (const ok of [true, false]) {
    const { db, calls } = fakeDb();
    expect(await probeDirectRuntimes(db, config, async () => {
      if (!ok) throw new Error("worker-direct-bearer edge-secret");
      return { status: "ok" };
    })).toBe(1);
    const update = calls.find((call) => call.sql.startsWith("update runtimes"))!;
    expect(update.values[0]).toBe(ok ? "healthy" : "unreachable");
    expect(update.sql).toContain("last_probed_at = now()");
    const cutoff = calls[0]!.values[0] as Date;
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(30_000);
    expect(Date.now() - cutoff.getTime()).toBeLessThan(31_000);
    expect(JSON.stringify(calls)).not.toMatch(/worker-direct-bearer|edge-secret/);
  }
});

test("direct expiration settles queued runs, workflows and their event with the shared disconnected code", async () => {
  const { db, calls } = fakeDb();
  expect(await failRunsOnUnhealthyDirectRuntimes(db, 90_000)).toBe(1);
  // One transition (S2d): queued -> failed, settled, for the organizations of a stale direct runtime.
  const sql = calls[0]!.sql;
  expect(sql).toStartWith("update runs set status = 'failed', external_state = 'settled'");
  expect(sql).toContain("rt.last_health_status <> 'healthy'");
  expect(sql).toContain("interval '90 seconds'");
  expect(sql).toContain("status in ('queued')");
  expect(sql).toContain("hermes_run_id is null");
  expect(calls[0]!.values).toContain("RUNTIME_DISCONNECTED");
  // Then its workflow, after the run.
  expect(calls[1]!.sql).toStartWith("update workflows set status = 'failed'");
  expect(calls[1]!.values).toContain("wf-1");
  // The run.error is numbered by the primitive, after the cursor lock, in its own statement (D2).
  expect(sql).not.toContain("run_events");
  const insert = calls.find((call) => call.sql.startsWith("insert into run_events"))!;
  expect(insert.values).toContain("run.error");
  expect(insert.values).toContainEqual(expect.objectContaining({ errorCode: "RUNTIME_DISCONNECTED" }));
});
