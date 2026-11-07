#!/usr/bin/env bun
/**
 * The blocking update test of the macOS app: no release reaches GitHub
 * "Latest" or the stable channel before an installed N-1 has updated itself
 * to N, on a GitHub macOS runner (`desktop-update-canary.yml`).
 *
 *   bun apps/desktop-tauri/scripts/update-canary-mac.ts --from 1.1.1 --to 1.1.2 [--feed URL] [--work DIR]
 *
 * 1. The published dmg of `--from` (R2, checked against its SHA256SUMS) is
 *    copied to a writable folder: neither translocated nor quarantined.
 * 2. `--from` older than `--to` (a release): the feed (the beta manifest by
 *    default) must name `--to`, signed by the update key. The app starts
 *    signed out, against a dead API (no run in progress), idle after 10 s,
 *    checking every 30 s: it must download, install and restart into `--to`,
 *    whose bundle must stay signed by team QDC76LMF29, notarised and
 *    stapled, and whose new process must answer "up to date" and keep running.
 *    `--from` equal to `--to` (the harness on the current release): the feed
 *    (the stable manifest by default) names nothing newer, nothing installs.
 * 3. Always: a loopback feed announces 9999.0.0 with a real artifact signed by
 *    a throwaway key. The app must refuse it (bad signature) and keep its
 *    bundle byte for byte, still running.
 *
 * It runs on CI only: the production app shares its data folder with the
 * owner's, and a different API origin purges that data (lib.rs).
 * Exit: 0 passed, 1 failed, 2 usage or environment.
 */
import { $ } from "bun";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { artifactNames, IDENTITIES, RELEASE_VERSION } from "./mac-identity";
import { parsePublicKey, type UpdatePublicKey } from "./minisign";
import { checkUpdateSignature, hostedLayout, parseSums, RELEASES_BASE, sha256, UPDATE_PUBLIC_KEY } from "./release";
import { testKey } from "./test-signing";
import { buildManifest } from "./update-feed";

export const TEAM = "QDC76LMF29";
export const BUNDLE_ID = "app.openedbot.desktop";
/** What the forged feed announces: newer than anything ever released. */
export const FORGED_VERSION = "9999.0.0";
const PLATFORM = "darwin-aarch64";
const DEAD_API = "http://127.0.0.1:9";
/** The single-instance socket of the production app (tauri-plugin-single-instance). */
const INSTANCE_SOCKET = "/tmp/app_openedbot_desktop_si.sock";
const LOG_FILE = path.join(homedir(), "Library", "Logs", BUNDLE_ID, "openedbot.log");

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export type CanaryMode = "update" | "not-newer";

export function compareVersions(a: string, b: string): number {
  for (const version of [a, b]) if (!RELEASE_VERSION.test(version)) throw new Error(`a release is X.Y.Z, got ${version}`);
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! < y![i]! ? -1 : 1;
  return 0;
}

/** An update from an older release, or the harness on one release; never a downgrade. */
export function canaryMode(from: string, to: string): CanaryMode {
  const order = compareVersions(from, to);
  if (order > 0) throw new Error(`--from ${from} is newer than --to ${to}`);
  return order < 0 ? "update" : "not-newer";
}

/** The feed the app follows: the beta manifest for a release (it names N before the tag), the stable one otherwise. */
export function defaultFeed(mode: CanaryMode, to: string): string {
  return `${RELEASES_BASE}/${hostedLayout(to).manifest(mode === "update" ? "beta" : "stable")}`;
}

export type Offer = { version: string; url: string; signature: string };

/** The macOS entry of a manifest, or why it has none. */
export function feedOffer(manifest: unknown): Offer {
  const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
  const root = object(manifest);
  if (!root || typeof root.version !== "string") throw new Error("the feed is not an update manifest (no version)");
  const entry = object(object(root.platforms)?.[PLATFORM]);
  if (!entry || typeof entry.url !== "string" || typeof entry.signature !== "string") throw new Error(`the feed has no ${PLATFORM} entry`);
  return { version: root.version, url: entry.url, signature: entry.signature };
}

/** What is wrong with the feed for this canary, empty when it can run. */
export function feedProblems(offer: Offer, mode: CanaryMode, from: string, to: string): string[] {
  if (mode === "not-newer") {
    return compareVersions(offer.version, from) > 0 ? [`the feed names ${offer.version}, newer than ${from}: it is not a not-newer feed`] : [];
  }
  const problems: string[] = [];
  if (offer.version !== to) problems.push(`the feed names ${offer.version}, not ${to}: upload the beta manifest before tagging`);
  const expected = hostedLayout(to).url(artifactNames(IDENTITIES.production, to).tarball);
  if (offer.url !== expected) problems.push(`the feed's ${PLATFORM} artifact is ${offer.url}, want ${expected}`);
  return problems;
}

/** A manifest announcing FORGED_VERSION for `artifactUrl`, signed by a key generated here and thrown away. */
export function forgedManifest(artifact: Uint8Array, artifactUrl: string): { manifest: string; publicKeyFile: string } {
  const key = testKey();
  const signature = key.sign(artifact, { version: FORGED_VERSION });
  const manifest = buildManifest({ version: FORGED_VERSION, url: artifactUrl, signature, notes: "forged by the update canary", pubDate: new Date() });
  return { manifest: JSON.stringify(manifest, null, 2), publicKeyFile: key.publicKeyFile };
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- the run (macOS, CI) ---------------------------------------------------

class CanaryFailure extends Error {}

const fail = (message: string): never => {
  throw new CanaryFailure(message);
};
const step = (message: string) => console.log(`canary ✓ ${message}`);
const note = (message: string) => console.log(`canary · ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, everyMs = 2 * SECOND): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() >= deadline) return fail(`timed out after ${Math.round(timeoutMs / SECOND)} s waiting for ${label}`);
    await sleep(everyMs);
  }
}

async function download(url: string, file: string): Promise<Uint8Array> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5 * MINUTE), redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      writeFileSync(file, bytes);
      return bytes;
    } catch (error) {
      last = error;
      await sleep(attempt * 2 * SECOND);
    }
  }
  return fail(`download of ${url} failed (${last instanceof Error ? last.message : String(last)})`);
}

/** Downloads a file of a published release and checks it against that release's SHA256SUMS. */
async function releaseFile(version: string, name: string, dir: string): Promise<Uint8Array> {
  const layout = hostedLayout(version);
  const sumsFile = path.join(dir, `SHA256SUMS-${version}`);
  if (!existsSync(sumsFile)) await download(layout.url("SHA256SUMS"), sumsFile);
  const want = parseSums(readFileSync(sumsFile, "utf8")).get(name) ?? fail(`${name} is not listed in the SHA256SUMS of ${version}`);
  const file = path.join(dir, name);
  const bytes = await download(layout.url(name), file);
  if (sha256(file) !== want) fail(`${name}: its sum differs from the SHA256SUMS of ${version}`);
  return bytes;
}

async function plist(app: string, key: string): Promise<string> {
  return (await $`/usr/libexec/PlistBuddy -c ${`Print :${key}`} ${path.join(app, "Contents", "Info.plist")}`.quiet().text()).trim();
}

const bundleVersion = (app: string) => plist(app, "CFBundleShortVersionString");

async function installFrom(version: string, work: string): Promise<{ app: string; executable: string }> {
  const dmgName = artifactNames(IDENTITIES.production, version).dmg;
  await releaseFile(version, dmgName, work);
  const applications = path.join(work, "Applications");
  rmSync(applications, { recursive: true, force: true });
  mkdirSync(applications, { recursive: true });
  const mount = path.join(work, "mount");
  mkdirSync(mount, { recursive: true });
  await $`hdiutil attach -nobrowse -readonly -noautoopen -mountpoint ${mount} ${path.join(work, dmgName)}`.quiet();
  try {
    await $`ditto ${path.join(mount, "openedbot.app")} ${path.join(applications, "openedbot.app")}`.quiet();
  } finally {
    await $`hdiutil detach ${mount}`.quiet().nothrow();
  }
  const app = path.join(applications, "openedbot.app");
  // A file fetched by a script is not quarantined; a quarantined bundle would be translocated and never updated.
  if ((await $`xattr -p com.apple.quarantine ${app}`.quiet().nothrow()).exitCode === 0) fail(`${app} is quarantined: it would run translocated`);
  const installed = await bundleVersion(app);
  if (installed !== version) fail(`the dmg of ${version} holds version ${installed}`);
  const executable = path.join(app, "Contents", "MacOS", await plist(app, "CFBundleExecutable"));
  step(`installed ${version} from its published dmg into ${app}`);
  return { app, executable };
}

/** The checks Gatekeeper and the release workflow make, on the bundle as it is now. */
async function verifyBundle(app: string, version: string): Promise<void> {
  const run = async (label: string, command: Promise<{ exitCode: number; stderr: Buffer; stdout: Buffer }>) => {
    const result = await command;
    if (result.exitCode !== 0) fail(`${label} refused ${app}: ${(result.stderr.toString() + result.stdout.toString()).trim()}`);
  };
  await run("codesign --verify", $`codesign --verify --deep --strict --verbose=2 ${app}`.quiet().nothrow());
  await run("spctl", $`spctl -a -vv -t exec ${app}`.quiet().nothrow());
  await run("stapler", $`xcrun stapler validate ${app}`.quiet().nothrow());
  const details = (await $`codesign -dv ${app}`.quiet().nothrow()).stderr.toString();
  const team = /^TeamIdentifier=(.+)$/m.exec(details)?.[1]?.trim();
  if (team !== TEAM) fail(`${app} is signed by team ${team ?? "none"}, want ${TEAM}`);
  const id = await plist(app, "CFBundleIdentifier");
  if (id !== BUNDLE_ID) fail(`${app} is ${id}, want ${BUNDLE_ID}`);
  const short = await bundleVersion(app);
  if (short !== version) fail(`${app} is version ${short}, want ${version}`);
  step(`${version}: signed by ${TEAM}, accepted by Gatekeeper, ticket stapled, ${BUNDLE_ID}`);
}

/** What must not change when an update is refused. */
async function snapshot(app: string, executable: string): Promise<string> {
  const files = [executable, path.join(app, "Contents", "Info.plist"), path.join(app, "Contents", "_CodeSignature", "CodeResources")];
  const cdhash = /^CDHash=(.+)$/m.exec((await $`codesign -dv --verbose=4 ${app}`.quiet().nothrow()).stderr.toString())?.[1] ?? "none";
  return [...files.map((file) => `${path.basename(file)}:${existsSync(file) ? sha256(file) : "missing"}`), `cdhash:${cdhash}`].join(" ");
}

async function pids(executable: string): Promise<number[]> {
  const result = await $`pgrep -f ${`^${escapeRegex(executable)}`}`.quiet().nothrow();
  return result.stdout.toString().split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function stopApp(executable: string): Promise<void> {
  for (const signal of ["TERM", "KILL"] as const) {
    if ((await pids(executable)).length === 0) break;
    await $`pkill ${`-${signal}`} -f ${`^${escapeRegex(executable)}`}`.quiet().nothrow();
    const deadline = Date.now() + 10 * SECOND;
    while (Date.now() < deadline && (await pids(executable)).length > 0) await sleep(500);
  }
  if ((await pids(executable)).length > 0) fail(`the app under ${executable} did not stop`);
  // A socket left by a killed instance would make the next start hand over to nobody and quit.
  rmSync(INSTANCE_SOCKET, { force: true });
}

/** The app's own journal from `offset` on: the update engine writes every decision there. */
const logSince = (offset: number) => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE).subarray(offset).toString("utf8") : "");
const logSize = () => (existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0);

function launch(executable: string, feed: string, output: string): void {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !name.startsWith("OPENEDBOT_")) env[name] = value;
  Object.assign(env, {
    OPENEDBOT_UPDATE_URL: feed,
    OPENEDBOT_UPDATE_CHECK_SECONDS: "30",
    OPENEDBOT_UPDATE_IDLE_SECONDS: "10",
    OPENEDBOT_POPUP: "0",
    // Signed out against a dead API: the console reports no run in progress.
    OPENEDBOT_API_ORIGIN: DEAD_API,
  });
  const fd = openSync(output, "a");
  try {
    // Not awaited: after an install the app restarts as another process; it is followed by its path.
    Bun.spawn([executable], { env, stdin: "ignore", stdout: fd, stderr: fd });
  } finally {
    closeSync(fd);
  }
  note(`started ${executable} on ${feed}`);
}

async function stillRunning(executable: string, label: string, forMs = 20 * SECOND): Promise<void> {
  const deadline = Date.now() + forMs;
  while (Date.now() < deadline) {
    if ((await pids(executable)).length === 0) fail(`${label}: the app is no longer running (see its journal)`);
    await sleep(2 * SECOND);
  }
  step(`${label}: still running ${Math.round(forMs / SECOND)} s later`);
}

async function realUpdate(installed: { app: string; executable: string }, from: string, to: string, feed: string, key: UpdatePublicKey, work: string): Promise<void> {
  const response = await fetch(feed, { signal: AbortSignal.timeout(MINUTE), cache: "no-store" });
  if (!response.ok) fail(`feed ${feed}: HTTP ${response.status}`);
  const offer = feedOffer(await response.json());
  const problems = feedProblems(offer, "update", from, to);
  if (problems.length > 0) fail(problems.join("; "));
  const tarball = artifactNames(IDENTITIES.production, to).tarball;
  const artifact = await releaseFile(to, tarball, work);
  checkUpdateSignature(tarball, artifact, offer.signature, key, to);
  step(`feed ${feed} names ${to}, its artifact signed by the update key`);

  const offset = logSize();
  launch(installed.executable, feed, path.join(work, "app-update.out"));
  await waitFor(`the bundle to become ${to}`, 10 * MINUTE, async () => (await bundleVersion(installed.app).catch(() => "")) === to, 5 * SECOND);
  step(`the bundle was replaced: ${from} → ${to}`);
  await waitFor(`"update ${to} installed" in the journal`, MINUTE, () => logSince(offset).includes(`update ${to} installed`));
  // The restarted process checks the feed 30 s after its start and finds nothing newer than itself.
  await waitFor(`the restarted ${to} to report "up to date (${to})"`, 3 * MINUTE, () => logSince(offset).includes(`up to date (${to})`), 5 * SECOND);
  step(`the restarted app runs ${to} and checks the feed`);
  await stillRunning(installed.executable, `${to} after the update`);
  await verifyBundle(installed.app, to);
  await stopApp(installed.executable);
}

async function notNewer(installed: { app: string; executable: string }, from: string, feed: string, work: string): Promise<void> {
  const response = await fetch(feed, { signal: AbortSignal.timeout(MINUTE), cache: "no-store" });
  if (!response.ok) fail(`feed ${feed}: HTTP ${response.status}`);
  const problems = feedProblems(feedOffer(await response.json()), "not-newer", from, from);
  if (problems.length > 0) fail(problems.join("; "));
  const before = await snapshot(installed.app, installed.executable);
  const offset = logSize();
  launch(installed.executable, feed, path.join(work, "app-not-newer.out"));
  await waitFor(`"up to date (${from})" in the journal`, 3 * MINUTE, () => logSince(offset).includes(`up to date (${from})`), 5 * SECOND);
  step(`${from} on ${feed}: up to date, nothing downloaded`);
  await stillRunning(installed.executable, `${from} on its own feed`);
  if ((await snapshot(installed.app, installed.executable)) !== before) fail("the bundle changed although the feed named nothing newer");
  await verifyBundle(installed.app, from);
  await stopApp(installed.executable);
}

async function forged(installed: { app: string; executable: string }, version: string, work: string): Promise<void> {
  const tarball = artifactNames(IDENTITIES.production, version).tarball;
  const artifact = readFileSync(path.join(work, tarball));
  const served: string[] = [];
  let manifest = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      served.push(pathname);
      if (pathname === "/latest.json") return new Response(manifest, { headers: { "content-type": "application/json" } });
      if (pathname === "/artifact.app.tar.gz") return new Response(artifact, { headers: { "content-type": "application/gzip" } });
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    manifest = forgedManifest(artifact, `${base}/artifact.app.tar.gz`).manifest;
    const before = await snapshot(installed.app, installed.executable);
    const offset = logSize();
    launch(installed.executable, `${base}/latest.json`, path.join(work, "app-forged.out"));
    const refusal = `update ${FORGED_VERSION} refused: bad signature`;
    await waitFor(`"${refusal}" in the journal`, 4 * MINUTE, () => {
      const journal = logSince(offset);
      if (journal.includes(`update ${FORGED_VERSION} installed`) || journal.includes(`update ${FORGED_VERSION} downloaded`)) fail(`the forged ${FORGED_VERSION} was accepted`);
      return journal.includes(refusal);
    }, 3 * SECOND);
    if (!served.includes("/artifact.app.tar.gz")) fail("the app reported a refusal without downloading the forged artifact");
    step(`a forged ${FORGED_VERSION} (artifact signed by a throwaway key) is downloaded, then refused`);
    await stillRunning(installed.executable, `${version} after the refusal`);
    if (logSince(offset).includes(`update ${FORGED_VERSION} installed`)) fail(`the forged ${FORGED_VERSION} was installed`);
    if ((await snapshot(installed.app, installed.executable)) !== before) fail("the bundle changed after a refused update");
    if ((await bundleVersion(installed.app)) !== version) fail(`the bundle is no longer ${version}`);
    step(`the bundle is untouched (${version}, same executable, Info.plist, signature)`);
  } finally {
    server.stop(true);
    await stopApp(installed.executable);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      to: { type: "string" },
      feed: { type: "string" },
      work: { type: "string" },
    },
    strict: true,
  });
  if (!values.from || !values.to) {
    console.error("usage: update-canary-mac.ts --from X.Y.Z --to X.Y.Z [--feed URL] [--work DIR]");
    return 2;
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.error("the update canary runs on an Apple Silicon Mac");
    return 2;
  }
  if (process.env.CI !== "true") {
    // The production app's data folder is the owner's: a dead API origin would purge it.
    console.error("the update canary runs on CI only (CI=true): on this Mac it would purge the installed app's data");
    return 2;
  }
  let mode: CanaryMode;
  try {
    mode = canaryMode(values.from, values.to);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const work = path.resolve(values.work ?? path.join(process.env.RUNNER_TEMP ?? "/tmp", "openedbot-update-canary"));
  mkdirSync(work, { recursive: true });
  const feed = values.feed ?? defaultFeed(mode, values.to);
  const key = parsePublicKey(readFileSync(UPDATE_PUBLIC_KEY, "utf8"));
  note(`${mode === "update" ? `update ${values.from} → ${values.to}` : `harness on ${values.from} (nothing newer)`}, feed ${feed}, work ${work}`);

  let installed: { app: string; executable: string } | null = null;
  const logStart = logSize();
  try {
    installed = await installFrom(values.from, work);
    await verifyBundle(installed.app, values.from);
    if (mode === "update") await realUpdate(installed, values.from, values.to, feed, key, work);
    else {
      await releaseFile(values.to, artifactNames(IDENTITIES.production, values.to).tarball, work);
      await notNewer(installed, values.from, feed, work);
    }
    await forged(installed, values.to, work);
    console.log(`canary passed: ${mode === "update" ? `${values.from} updated itself to ${values.to}` : `${values.from} kept on a feed with nothing newer`}, forged update refused`);
    return 0;
  } catch (error) {
    console.error(`canary FAILED: ${error instanceof Error ? error.message : String(error)}`);
    // The engine's last decisions say why (e.g. "idle install waits: the console has not reported its runs").
    const tail = logSince(logStart).trimEnd().split("\n").slice(-25).join("\n");
    if (tail) console.error(`the app's journal, last lines:\n${tail}`);
    return 1;
  } finally {
    if (installed) await stopApp(installed.executable).catch((error) => console.error(`cleanup: ${error instanceof Error ? error.message : String(error)}`));
    // The journal holds kinds and codes, never a token (logger.rs): kept for the workflow's artifact.
    writeFileSync(path.join(work, "openedbot.log"), logSince(logStart));
    if (existsSync(LOG_FILE)) copyFileSync(LOG_FILE, path.join(work, "openedbot-full.log"));
  }
}

if (import.meta.main) process.exit(await main());
