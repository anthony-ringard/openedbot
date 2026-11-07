# Runtime link continuity evidence

## Isolated transport regression

From the repository root, run:

```sh
OPENEDBOT_LINK_GATEWAY_E2E=1 bun test apps/api/tests/runtime-link-separation.e2e.test.ts
```

This starts only disposable test processes and loopback listeners. It uses the
production Go connector, authenticated TypeScript gateway, internal relay routes,
worker dialer and transport. Persistence and inference are synthetic fixtures.
It does **not** prove that a deployed VPS, provider or PostgreSQL installation is
healthy. The harness hands the Go connector an unsealed `device.key` through
`CREDENTIALS_DIRECTORY`, as systemd would, and reports `proofOfPossession`:
`proven` when the host presented that key in `hello` and answered
`link.challenge` before admission, `not_presented_by_host` when the test host did
not offer it (then `pop_missing` is journaled; production refuses that case).

The test holds a mutation and an SSE stream while two API facade processes are
restarted. Worker requests must continue while the API is absent, with the same
connector connection, complete stream and one mutation. It then cuts the separate
gateway: an already dispatched mutation must report ambiguous delivery and must
not be replayed. This second phase is deliberate fault injection confined to test
resources. Cleanup stops the Go host and all test listeners/processes.

## Opt-in real provider restart acceptance

Provide explicit `E2E_EMAIL`, `E2E_PASSWORD`, `E2E_RUNTIME_ID`, `E2E_PROVIDER`,
`E2E_MODEL`, `E2E_RUN_INPUT`, `E2E_LINK_GATEWAY_URL`, `RELAY_INTERNAL_TOKEN` and
`METRICS_INTERNAL_TOKEN` through your normal environment mechanism. The account
must be an owner or admin of the intended runtime. No account, runtime, provider
or model is guessed. The runtime must already use the separate gateway, and its
journal must expose the persisted gateway instance and connection generation.

```sh
E2E_ALLOW_REAL_RUNS=1 bun tests/e2e/runtime-link-live-continuity.ts
```

This performs real inference and may incur provider charges. Choose a prompt long
enough for two API restarts during the same active run. A run that finishes too
quickly fails acceptance; no retry or alternative provider is tried. The
runner creates one bot and plans exactly two primary messages: the restart
scenario at the beginning, then a bounded verification at the end of observation.
Both may incur provider charges. The final message defaults to “Reply with only
CONTINUITY_END_OK.” and can be set with `E2E_END_RUN_INPUT`. For each run it observes the worker's actual
`hermesResponseId`, and opens a single SSE connection directly through the
dedicated gateway using the production worker dialer. It never reconnects that
SSE stream to conceal a failure.

Without restart options, coordinate the two API restarts externally after the
run starts. To explicitly authorize the runner to invoke your own restart
command twice, provide `E2E_ALLOW_API_RESTARTS=1` and `E2E_API_RESTART_ARGV` as a
JSON array of executable and arguments. No shell interpolation occurs. The
command is invoked only while the observed run is active and SSE has begun. It
must target only the intended API service, never the gateway or worker. The
runner does not infer an SSH host, service name, deployment command or permission.

Both API boots must have distinct, increasing `/internal/metrics` boot timestamps
inside the same run's recorded active interval. Zero restarts, a boot outside the
run, changed remote run identity, a stream gap/duplicate, missing terminal or
duplicated persisted assistant/terminal events fails acceptance. The test reads
worker persistence independently after each run and requires exactly two primary
openedbot runs on the owned bot after the final verification. Stable remote identifiers
and unique openedbot records alone do not prove remote creation counts. The independent
connector audit below must close that gate. The owned bot has auxiliary memory
extraction explicitly disabled and verified, so the scenario announces exactly
two provider runs; unexpected fallback/extra dispatches fail the audit gate.

Observation defaults to **30 minutes**. `E2E_OBSERVE_SECONDS` changes that window
(10 to 86400 seconds). A shorter result must be reported with its actual duration;
it is not a 30-minute observation and leaves `acceptanceComplete: false` with a
missing-duration gate even when the shorter scenario passes. `E2E_API_URL` defaults to loopback port 8790 and
otherwise requires HTTPS. The runner prints a private temporary artifact directory
containing before/after journals, restart-command logs when applicable, and final
boot/run/SSE sequence evidence. It does not save model text. Tokens and passwords
are redacted. `E2E_RUN_TIMEOUT_SECONDS` bounds each active run separately (default 300 seconds).
Only the test-created bot, profile and remote sessions are purged; its login
session is revoked. A still-active test run is stopped before cleanup. Cleanup
failure prevents success and retains the artifact identifiers for investigation.

The journal boundary must remain visible within the endpoint's 200-entry limit.
Every new link event fails continuity. API read outages during the run are
tolerated for at most 30 seconds; the independent gateway stream must stay intact.
`passed` covers this executable continuity scenario. `continuityScenarioComplete`
additionally requires the full observation duration. `acceptanceComplete` becomes
true only when both external proof validators below and cleanup also succeed.
Without these exports, their missing gates remain explicit and full acceptance
stays false. Never infer browser or remote-dispatch evidence from openedbot rows.

## Observation-only lifecycle

The older observation-only recipe (`runtime-link-live-observation.ts`) was removed
on 2026-10-10; its evidence stays under `docs/reports/`. It deliberately emitted
`acceptanceComplete: false` and exited
nonzero because it does not prove restart overlap or independent SSE continuity.
Its `/api/events` observer may close during an API restart without indicating a
worker/gateway failure. Use the full acceptance runner above for runtime link continuity.

The real bot recipe also checks auxiliary behaviors. A failed lifecycle is not
automatically a transport defect; retain the failing step and its evidence. A
passing short health-only load test is not evidence of real inference, and a
synthetic transport test is never labeled as a VPS validation.

## Independent connector creation audit

The connector must already have `HERMES_CONNECTOR_CREATION_AUDIT=1` enabled before
this scenario. This recipe does not enable it, restart services or connect to SSH.
Provide `E2E_CREATION_AUDIT_PATH` as an absolute local path for the final exported
artifact. The runtime-bound source is the connector's sealed
`<stateDir>/creation-audit/<sha256(wsURL + "\n" + runtimeId)>/snapshot.bin`
(AES-256-GCM under a key openedbot hands to the host per session and never writes on the
VPS; hash chain inside; `edge-setup/docs/CONNECTOR.md`). Use the
exact observed connector configuration to identify that file; never guess a host
or use another runtime's audit. A `snapshot.json` next to it is the plaintext v1
file of an older connector, set aside as `snapshot.v1.json`: it is never evidence,
and both the export tool and openedbot refuse it by name (`AUDIT_PLAINTEXT_EXPORT`).

After `awaiting_external_evidence`, collect on the connector host using an
already authorized operator session:

The key-less copy is made by `copySealedExport` in `runtime-link-export-audit-lib.ts`
(the standalone CLI wrapper was removed on 2026-10-10).

The supplied script copies the sealed file byte for byte into a new private
output file, prints only the clear header (`runtimeId`, `keyId`, `writeSeq`) and
the SHA-256, and holds no key: it cannot read, trim or backdate anything. The
`exportedAt` it prints is when the copy was made, not a fact inside the file.
Transfer that output through your authorized mechanism to `E2E_CREATION_AUDIT_PATH`.

The runner submits the bytes unchanged to
`POST /api/runtimes/<id>/creation-audit/verifications` with its own session
(owner or admin). openedbot finds the key, decrypts, recomputes the chain, compares the
position with the last `audit.anchor` the connector sent it, cross-checks every
`attempt` against the dispatches the API itself relayed and every `remoteId`
against its runs, then returns a dated verdict signed Ed25519 with the key
published by `GET /api/creation-audit/verdict-key`. The runner verifies that
signature locally, stores `creation-audit-verdict.json` and
`creation-audit-verdict-key.json` in its artifacts, and requires `verdict` to be
`valid` (or `valid_unanchored`, reported as such), zero dropped metadata,
coverage from before the scenario start, receipt after its end, one
attempt/outcome per SHA256(primary openedbot run ID), matching successful remote IDs,
and no other creation on the dedicated profile.

What the verdict proves: the bytes were sealed by the connector holding the key
openedbot issued for this runtime, were not truncated, reordered or restored from an
older copy without detection, and describe exactly the creations the API relayed
through that connector. What it does not prove: creations made outside the link
(covered separately by the runtime session reconciliation), the wall clock of the
VPS (a `clock_skew` finding names a drift above 60 s), or anything at all when the
API signs with an ephemeral development key (`signature.ephemeral`, reported as
a limitation). Metadata contains no prompts, bodies, provider credentials or
idempotency key values; the runner and revalidator never hold an audit key.

## Real PWA replay observation through Ghostchrome MCP

Browser access requires an explicit user request for that execution. Preparation
and typecheck do not launch a browser. The installed transport here is MCP: reuse
the registered Ghostchrome connection, never invoke a Ghostchrome CLI or another
MCP process. Follow the Ghostchrome skill for current snapshots, observed account
identity, authorized login and bounded cleanup. Do not reuse guessed seed identity.

Provide `E2E_BROWSER_EVIDENCE_PATH` as an absolute path and `E2E_PAGE_URL` as the
exact PWA origin. The browser event origin defaults to this PWA origin because
its `/api/events` requests use the frontend proxy. If the observed PWA explicitly
sets a different API origin, set `E2E_BROWSER_EVENTS_URL` to that exact origin;
it is independent of `E2E_API_URL`, used by the HTTP control harness. After the runner creates its private bot, it emits
`awaiting_browser_observer` and `browser-manifest.json`. Generate the injection
expression without starting a browser:

```sh
bun tests/e2e/runtime-link-browser-observer.ts /absolute/browser-manifest.json
```

Use that exact expression with the registered Ghostchrome `eval` tool on the
expected PWA origin. Install on the login page before the authorized test login,
so the application's first `/api/events` fetch is observed. Installing after an
existing stream opened cannot recover its unseen bytes and may fail coverage.
Navigate to the created bot's `/bot/<botId>` route through SPA links using current
snapshots and refs, without reloading the document (which removes the observer).
Only after the target route is visible and an observed `/api/events` fetch has
returned 200, export `globalThis.__openedbotContinuityEvidence.snapshot()` through MCP
and save that structured value unchanged to `E2E_BROWSER_EVIDENCE_PATH` using an
atomic local file replacement. The runner requires those readiness conditions
in addition to the matching scenario nonce and thread ID. Keep that thread open
through both API restarts and the final run. Snapshot the visible terminal answer
and collect the Ghostchrome console/network observations separately.

The observer wraps only the actual PWA `/api/events` fetch responses. It records
bounded cursor/run/sequence/type metadata as the application consumes bytes; it
never opens an independent API event subscriber or stores payloads/headers. API
stream disconnects are expected during API restart. Global `stream.gap` controls
are retained with their requested/skipped cursor ranges. They do not certify any
history outside the two expected runs: acceptance requires every expected run
event, from persisted sequence zero through terminal, to match exactly in the
PWA stream. Thus a global cursor hole caused by deleted unrelated history can
coexist with complete scoped proof; missing even one expected event still fails.
The separate worker-to-gateway SSE still must remain uninterrupted.

When the runner emits `awaiting_external_evidence`, use the same registered MCP
`eval` tool with this expression and save its returned JSON unchanged, atomically
replacing the ready file:

```js
globalThis.__openedbotContinuityEvidence.snapshot(true)
```

This restores the original fetch, stops the bounded observer timer, and records
nonempty/unique rendered assistant message targets without saving model text.
The verifier matches both run IDs, all persisted cursor/sequence/type triples,
the actual request cursor after each distinct API boot, scenario nonce, origins,
coverage timestamps and each exact rendered assistant message ID. A snapshot of
an unrelated conversation or a second SSE subscriber cannot satisfy those gates.
Finally close the authorized Ghostchrome flow according to the skill; do not kill
unrelated Chrome processes. If the recipe fails before final export, call the same
stop expression to restore fetch and release its timer.

`E2E_EVIDENCE_WAIT_SECONDS` bounds each external readiness/export wait (default
120 seconds, maximum 600). Missing or invalid configured exports fail the run;
omitting a path leaves its acceptance gate open. Final artifacts include original
export SHA256s, metadata copies and `evidence-expectations.json`. A short transport
scenario may pass while full acceptance remains false; no browser or remote audit
results have been claimed from preparation or unit tests.

## Revalidate retained artifacts without another real run

A prior version rejected every global `stream.gap` and required a run event before
the first API boot. Those conditions can reject a healthy browser whose SSE was
already open before the first worker event and whose old global cursor predates
deleted unrelated history. To review that specific false negative, retain the
original result, full expectations and both journals, plus the raw final browser
and connector exports **before cleanup removes the test bot**. Do not modify the
old verdict, remove gap errors or invent missing events.

The standalone `runtime-link-revalidate.ts` CLI was removed on 2026-10-10: replay the
verdict with `inspectSealedExport` from `runtime-link-export-audit-lib.ts` against the
original artifacts, and keep the original verdict file untouched.

By default this command makes no HTTP request, starts no browser and invokes no
provider. It writes a new exclusive private verdict, recording hashes of every
input. The connector audit is judged from the retained
`creation-audit-verdict.json`: its signature is re-verified offline with the
retained `creation-audit-verdict-key.json`, and its `exportSha256` must be the
digest of the sealed export supplied. With `E2E_REVALIDATE_ONLINE=1` plus explicit
`E2E_EMAIL`, `E2E_PASSWORD` and `E2E_API_URL`, the export is submitted again and
the fresh verdict (same export digest, signed by the live key) is used instead;
the login session is revoked afterwards. It can supersede only the named old
browser-proof failures; transport, inference, observation and cleanup failures
remain failures. It rechecks 30 minutes, two real run identities, ordered
independent gateway streams, both API boot overlaps, unchanged link journal,
openedbot-verified connector dispatches, all expected persisted event
sequences/cursors against the PWA, rendered messages, and the original cleanup.

The corrected browser proof accepts an SSE request opened before the first boot
even if that request had not yet received a run event. Each boot still requires a
new successful request before the next boot using at least the previous cursor.
Legacy exports that recorded only the global gap error retain that count without
invented ranges. Their exact expected-run equality and contiguous persisted
sequence-zero coverage remain mandatory. The new verdict names this limited
scope and never claims that unrelated global history was preserved.
