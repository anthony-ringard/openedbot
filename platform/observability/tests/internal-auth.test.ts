import { describe, expect, test } from "bun:test";
import { InternalAuthMetrics } from "../src/internal-auth";

function harness() {
  let now = 0;
  const lines: Array<{ event: string; fields: Record<string, unknown>; level?: string }> = [];
  const metrics = new InternalAuthMetrics({
    now: () => now,
    log: (event, fields = {}, level) => { lines.push({ event, fields, level }); },
  });
  return { metrics, lines, advance: (ms: number) => { now += ms; } };
}

describe("InternalAuthMetrics", () => {
  test("counts every outcome per role, logs refusals at most every 10 s with the suppressed count", () => {
    const { metrics, lines, advance } = harness();
    metrics.recordBearer("relay", "refused", "/internal/runtime-links/proxy");
    metrics.recordBearer("relay", "refused", "/internal/runtime-links/proxy");
    metrics.recordBearer("relay", "refused", "/internal/runtime-links/proxy");
    advance(10_000);
    metrics.recordBearer("relay", "refused", "/internal/runtime-links/proxy");
    metrics.recordBearer("events", "role", "/internal/events/publish");
    expect(metrics.snapshot().bearers).toEqual({ "relay.refused": 4, "events.role": 1 });
    expect(lines).toEqual([
      { event: "internal_auth.refused", fields: { role: "relay", route: "/internal/runtime-links/proxy", suppressed: 0 }, level: "warn" },
      { event: "internal_auth.refused", fields: { role: "relay", route: "/internal/runtime-links/proxy", suppressed: 2 }, level: "warn" },
    ]);
  });

  test("a run key read through the previous secret is logged once a minute per label with its running total", () => {
    const { metrics, lines, advance } = harness();
    metrics.recordRunKey("routine", "previous");
    metrics.recordRunKey("routine", "previous");
    advance(60_000);
    metrics.recordRunKey("routine", "previous");
    metrics.recordRunKey("routine", "role");
    expect(lines.map((line) => [line.event, line.fields.total])).toEqual([
      ["internal_auth.run_key_previous", 1],
      ["internal_auth.run_key_previous", 3],
    ]);
  });

  test("run keys are counted apart from bearers, previous and legacy reads logged", () => {
    const { metrics, lines } = harness();
    metrics.recordRunKey("routine", "role");
    metrics.recordRunKey("routine", "previous");
    metrics.recordRunKey("bot-settings", "refused");
    expect(metrics.snapshot()).toEqual({ bearers: {}, runKeys: { "routine.role": 1, "routine.previous": 1, "bot-settings.refused": 1 } });
    expect(lines.map((line) => line.event)).toEqual(["internal_auth.run_key_previous", "internal_auth.run_key_refused"]);
  });

  test("never logs a value: only role, route, label and counts", () => {
    const { metrics, lines } = harness();
    metrics.recordBearer("inventory", "refused", "/internal/runtime-inventory/changed");
    expect(Object.keys(lines[0]!.fields).sort()).toEqual(["role", "route", "suppressed"]);
  });
});
