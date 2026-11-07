import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parsePublicKey, verifySignature } from "./minisign";
import { checkUpdateSignature, UPDATE_PUBLIC_KEY } from "./release";
import { canaryMode, compareVersions, defaultFeed, escapeRegex, feedOffer, feedProblems, FORGED_VERSION, forgedManifest } from "./update-canary-mac";

const offer = (version: string, url = `https://releases.openedbot.app/desktop/v${version}/openedbot_${version}_aarch64.app.tar.gz`) => ({ version, url, signature: "c2ln" });

describe("update canary", () => {
  test("compares X.Y.Z numerically and refuses anything else", () => {
    expect(compareVersions("1.1.1", "1.1.2")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.1.1", "1.1.1")).toBe(0);
    expect(() => compareVersions("1.1", "1.1.1")).toThrow(/X\.Y\.Z/);
    expect(() => compareVersions("1.1.1-test", "1.1.1")).toThrow(/X\.Y\.Z/);
  });

  test("an older --from is an update, the same is the harness, a newer one is refused", () => {
    expect(canaryMode("1.1.1", "1.1.2")).toBe("update");
    expect(canaryMode("1.1.1", "1.1.1")).toBe("not-newer");
    expect(() => canaryMode("1.1.2", "1.1.1")).toThrow(/newer than --to/);
  });

  test("a release follows the beta manifest, the harness the stable one", () => {
    expect(defaultFeed("update", "1.1.2")).toBe("https://releases.openedbot.app/desktop/solo/beta/latest.json");
    expect(defaultFeed("not-newer", "1.1.1")).toBe("https://releases.openedbot.app/desktop/solo/stable/latest.json");
  });

  test("reads the macOS entry of a manifest, and says what is missing", () => {
    expect(feedOffer({ version: "1.1.2", platforms: { "darwin-aarch64": { url: "u", signature: "s" } } })).toEqual({ version: "1.1.2", url: "u", signature: "s" });
    expect(() => feedOffer(null)).toThrow(/not an update manifest/);
    expect(() => feedOffer({ version: "1.1.2", platforms: { "linux-x86_64-appimage": { url: "u", signature: "s" } } })).toThrow(/no darwin-aarch64 entry/);
  });

  test("a release feed must name --to and its hosted artifact", () => {
    expect(feedProblems(offer("1.1.2"), "update", "1.1.1", "1.1.2")).toEqual([]);
    expect(feedProblems(offer("1.1.1"), "update", "1.1.1", "1.1.2")).toEqual([
      "the feed names 1.1.1, not 1.1.2: upload the beta manifest before tagging",
      "the feed's darwin-aarch64 artifact is https://releases.openedbot.app/desktop/v1.1.1/openedbot_1.1.1_aarch64.app.tar.gz, want https://releases.openedbot.app/desktop/v1.1.2/openedbot_1.1.2_aarch64.app.tar.gz",
    ]);
    expect(feedProblems(offer("1.1.2", "https://elsewhere.example/a.tar.gz"), "update", "1.1.1", "1.1.2")).toHaveLength(1);
  });

  test("the harness feed must name nothing newer", () => {
    expect(feedProblems(offer("1.1.1"), "not-newer", "1.1.1", "1.1.1")).toEqual([]);
    expect(feedProblems(offer("1.1.0"), "not-newer", "1.1.1", "1.1.1")).toEqual([]);
    expect(feedProblems(offer("1.1.2"), "not-newer", "1.1.1", "1.1.1")).toEqual(["the feed names 1.1.2, newer than 1.1.1: it is not a not-newer feed"]);
  });

  test("the forged manifest is well signed, by a key the app does not trust", () => {
    const artifact = new TextEncoder().encode("an app archive");
    const { manifest, publicKeyFile } = forgedManifest(artifact, "http://127.0.0.1:1/artifact.app.tar.gz");
    const forged = feedOffer(JSON.parse(manifest));
    expect(forged.version).toBe(FORGED_VERSION);
    // Valid under its own key: the app refuses it for the key, not for a broken file.
    expect(verifySignature(artifact, forged.signature, parsePublicKey(publicKeyFile))).toContain(`version:${FORGED_VERSION}`);
    const updateKey = parsePublicKey(readFileSync(UPDATE_PUBLIC_KEY, "utf8"));
    expect(() => checkUpdateSignature("artifact", artifact, forged.signature, updateKey, FORGED_VERSION)).toThrow();
  });

  test("escapes a path for pgrep", () => {
    expect(escapeRegex("/tmp/a.b/openedbot.app/Contents/MacOS/openedbot")).toBe("/tmp/a\\.b/openedbot\\.app/Contents/MacOS/openedbot");
    expect(new RegExp(`^${escapeRegex("/x/(y)+")}$`).test("/x/(y)+")).toBe(true);
  });
});
