import { describe, expect, test } from "bun:test";

import { classifyLocalEnvEntry, parseEnvEntries } from "./env-file";

describe("classifyLocalEnvEntry", () => {
  test("keeps local variables and unknown ones", () => {
    expect(classifyLocalEnvEntry({ name: "API_DATABASE_URL", value: "postgres://x" }, "external")).toBe("keep");
    expect(classifyLocalEnvEntry({ name: "CUSTOM_UNKNOWN", value: "1" }, "external")).toBe("keep");
  });

  test("removes empty production or default-only variables, preserves non-empty ones", () => {
    expect(classifyLocalEnvEntry({ name: "API_PUBLIC_URL", value: "" }, "external")).toBe("remove");
    expect(classifyLocalEnvEntry({ name: "RELAY_INTERNAL_TOKEN", value: "x" }, "external")).toBe("preserve");
  });

  test("removes deprecated variables, whatever their value", () => {
    expect(classifyLocalEnvEntry({ name: "DEV_BUNDLED_HERMES_TOKEN", value: "x" }, "external")).toBe("remove");
    // The former single internal secret (S1b): a process that finds it refuses to start.
    expect(classifyLocalEnvEntry({ name: "WORKER_INTERNAL_TOKEN", value: "x" }, "external")).toBe("remove");
    // The database port now comes from API_DATABASE_URL: the copy is removed.
    expect(classifyLocalEnvEntry({ name: "OPENEDBOT_POSTGRES_PORT", value: "5432" }, "external")).toBe("remove");
  });
});

describe("parseEnvEntries", () => {
  test("keeps order and ignores comments", () => {
    const entries = parseEnvEntries("# c\nA=1\n\nB=two words\n");
    expect(entries.map((e) => e.name)).toEqual(["A", "B"]);
    expect(entries[1]?.value).toBe("two words");
  });
});

describe("classifyLocalEnvEntry: plug-in variables", () => {
  test("a set OPENEDBOT_PLUGIN_<ID>__<KEY> is preserved, an empty one removed", () => {
    expect(classifyLocalEnvEntry({ name: "OPENEDBOT_PLUGIN_BILLING__API_KEY", value: "x" }, "external")).toBe("preserve");
    expect(classifyLocalEnvEntry({ name: "OPENEDBOT_PLUGIN_BILLING__API_KEY", value: "" }, "external")).toBe("remove");
  });
});
