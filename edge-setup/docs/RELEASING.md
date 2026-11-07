# Publishing edge-setup

How an `edge-setup` release is cut, signed and published, and how hosts verify
it.

## Where releases live

The source is `edge-setup/` of the monorepo `OpenedBot/openedbot`. The public
origin of the binaries is Cloudflare R2 behind a read-only Worker:

```
https://releases.openedbot.app/edge-setup/vX.Y.Z/...                 immutable, signed
https://releases.openedbot.app/edge-setup/LATEST                     latest version string
https://releases.openedbot.app/edge-setup/edge-setup.json            latest version and digests, for the console
https://releases.openedbot.app/edge-setup/SHA256SUMS                 unversioned copies, for hosts
https://releases.openedbot.app/edge-setup/edge-setup_linux_{amd64,arm64}   older than signed releases
```

A version directory holds the four binaries `edge-setup_{linux,darwin}_{amd64,arm64}`,
the bootstrap `install.sh`, `SHA256SUMS`, and one Sigstore bundle per file:
`SHA256SUMS.sigstore.json` and `<file>.sigstore.json`. `LATEST` holds the
latest version (`vX.Y.Z`). The unversioned copies at the root are still written
for hosts older than signed releases; nothing signed reads them.

The install bootstrap (`docs.openedbot.app/install`, `docs/public/install` of
`OpenedBot/openedbot`), `upgrade`, `upgrade --auto` and `self-verify`
(`selfupdate.DefaultBaseURL`) read only that origin. They resolve one version
(`LATEST`, a `/vX.Y.Z` base URL, or the version pinned in the bootstrap), read
`SHA256SUMS` and `SHA256SUMS.sigstore.json` from that version directory, verify
the signature, then the binary's SHA-256. When the origin serves nothing, or a
check fails, they **fail closed**: nothing is installed or replaced, there is
no fallback. `--release-url` refuses the retired GitHub releases repository
(exit 2).

Versioning restarted at **v0.0.1** with this repository, and reached v1.0.0
on 2026-11-03. Hosts still on a v1.x of the former repository carry the
retired default base and see the new v1.0.0 as the same or older: their one-time
migration is in `CHANGELOG.md` (`upgrade --allow-downgrade --release-url`).
The former GitHub releases repository is gone: nothing reads or publishes to
it. A v1.x binary of the former repository is rebuilt from its tag in
`OpenedBot/openedbot` if it is ever needed.

From v1.5.0 on, every version is numbered above v1.4.0, the last version of
the former repository, so one number never names two different releases.
Never reuse a number listed in `CHANGELOG.md`, old section included.

Every version is published twice, identically: on R2 (the only origin hosts
read) and as the GitHub release `edge-setup/vX.Y.Z` of `OpenedBot/openedbot`
(never marked Latest: that badge belongs to the desktop app). Both carry the
same signed files and the same `SHA256SUMS`.

## Cutting a release

**Operator rule: every host is updated from an official public release**,
never with `make deploy`, except in explicit dev mode.

1. Write the public notes as the `## vX.Y.Z` entry of `CHANGELOG.md`. They are
   product copy: never a ticket id, an internal route, an error code, a host
   path or an em dash. `make notes-check NOTES_FILE=...` refuses them, and fails
   closed if its checker cannot run.
2. Set `PINNED_VERSION="vX.Y.Z"` in `docs/public/install` to the version being
   tagged: the bootstrap installs that release by default, and `make build-all`
   refuses a release whose bootstrap pins another one.
3. Commit, tag `edge-setup/vX.Y.Z` (monorepo OpenedBot/openedbot) and push both.
   `.github/workflows/edge-setup-release.yml` runs on the tag:
   - job `verify`: connector contract on both sides (the core is the monorepo
     root), `make test`, `make test-release`, `make build-all`, then `make sign`
     (cosign keyless, GitHub OIDC) and `make verify-signatures`, the check a
     host makes. It uploads the signed files as the workflow artifact
     `edge-setup-vX.Y.Z` (kept 30 days);
   - job `publish`: downloads that artifact, verifies every signature again,
     extracts the `## vX.Y.Z` entry of `CHANGELOG.md` (refused by
     `notes-check` like a manual release), then runs `scripts/publish-r2.sh`.
     Nothing is rebuilt: the bytes published are the bytes signed;
   - job `github`: downloads the same artifact, fails unless R2 serves the
     same `SHA256SUMS`, then creates the GitHub release `edge-setup/vX.Y.Z`
     with every signed file and the same notes.
4. Check the release: `curl -fsS https://releases.openedbot.app/edge-setup/LATEST`
   names the new version, `gh release view edge-setup/vX.Y.Z` lists the same
   files, and the console announces it within the hour.

The R2 write token lives only in the GitHub environment `edge-setup-r2`
(secret `CLOUDFLARE_R2_TOKEN`, variable `CF_ACCOUNT_ID`), whose deployment
policy admits the `edge-setup/v*` tags and nothing else: a branch, a pull
request or a dispatch never sees it. It is a Cloudflare API token with the
single permission Account, Workers R2 Storage, Edit, on this account only.
Without the secret the `publish` job fails red and nothing is written.

Manual fallback, from the clean tagged tree, once the release run of the tag
has succeeded (a token never stored on disk in clear):

```bash
git status --short --branch
git switch --detach edge-setup/vX.Y.Z
CLOUDFLARE_API_TOKEN=... CF_ACCOUNT_ID=... NOTES_FILE=notes.md make publish VERSION=vX.Y.Z
```

`make publish` refuses a dirty tree, a version that is not a tag, and runs the
connector contract again. It rebuilds nothing: the signatures bind the bytes
the CI built from the tag, so those are the bytes published.

- `make fetch-signed` (`scripts/fetch-signed-release.sh`) downloads the
  artifact `edge-setup-vX.Y.Z` of the successful release run for the tag's
  commit (`gh run download`), and refuses it unless it holds exactly the files
  of its `SHA256SUMS`, each with its bundle, plus the manifest's bundle;
- `make verify-signatures` checks every bundle with `cosign verify-blob` for
  the identity of that tag, then `sha256sum --check`;
- `scripts/publish-r2.sh` then:
  - refuses a version already published (a release is immutable) and a
    directory without signatures;
  - writes `vX.Y.Z/` first (each file with its bundle, then the manifest's
    bundle, then the versioned `SHA256SUMS` **last**), then the unversioned copies (binaries,
    then `SHA256SUMS`), then the anchor `edge-setup.json` (version and SHA-256
    of each file, read by the console's update feed), then `LATEST` **last of
    all**, so a host never reads a
    manifest that lists a file not yet served, and a failed write leaves the
    previous latest untouched;
  - reads back from the public origin both manifests, the signature, the
    anchor and `LATEST`, and compares them.

The token is read from a `0600` header file, never from argv. Its scope should
be R2 write on the `openedbot-releases` bucket only. Publishing needs `gh`
(authenticated to read the workflow artifact), `cosign`, `curl` and `jq`.

Each release ships Linux and macOS binaries for amd64 and arm64, all listed
in the one `SHA256SUMS` with `install.sh`. The install script and `upgrade`
fetch `edge-setup_<os>_<arch>`. Releases no longer carry the legacy-named
`hermes-setup_*` copies: every published release (v0.0.1 onward) already
looks up the canonical name, and `upgrade` still falls back to a legacy name
when an older manifest lists only that one.

## Signature: keyless, Sigstore

Releases are signed in CI with cosign keyless: the release workflow obtains a
short-lived Fulcio certificate for its GitHub OIDC identity, signs, and the
signature is logged in Rekor, Sigstore's public transparency log. There is no
signing key to store, rotate or guard, and no offline ceremony.

The only identity a host accepts for version `vX.Y.Z`:

- certificate identity
  `https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/vX.Y.Z`;
- OIDC issuer `https://token.actions.githubusercontent.com`.

A signature made by another workflow, a branch, or the tag of another version
does not verify. Renaming or moving the release workflow therefore changes the
root of trust: hosts would refuse every release it signs.

- The bootstrap verifies with a pinned cosign (v3.1.4) downloaded from
  GitHub and checked against a SHA-256 written in the script, or with a cosign
  the operator already trusts (`EDGE_SETUP_COSIGN`).
- `upgrade`, `upgrade --auto` and `self-verify` verify with sigstore-go. The
  trusted root comes from Sigstore's TUF repository (`tuf-repo-cdn.sigstore.dev`),
  cached in `/var/lib/hermes-setup/sigstore` when run as root.
- A release without `SHA256SUMS.sigstore.json` (every release up to v0.0.2) is
  refused. The first signed release is v0.0.3; until it is published, the
  bootstrap and `upgrade` of a signed binary install nothing.

### When Rekor is down

`make sign` signs each file through the public signing configuration
(Rekor v1, `rekor.sigstore.dev`). When that fails for a file, it signs that
file again with `scripts/sigstore-signing-config-rekor-v2.json`: the Rekor v2
log `log2025-1.rekor.sigstore.dev` plus an RFC 3161 timestamp from
`timestamp.sigstore.dev`. Both are in the trusted root hosts already read from
TUF, and both verifiers accept the result with the same thresholds (a verified
log entry, an observer timestamp) and the same exact identity: sigstore-go
v1.3.0 (`upgrade`, `upgrade --auto`, `self-verify`, so v1.5.1 hosts too) and
cosign v3.1.4 (bootstrap, `make verify-signatures`). If both logs refuse,
`make sign` fails and nothing is published.

This was added on 2026-11-07, when Rekor v1 answered 500 ("inactive shard")
and the tag `edge-setup/v1.5.2` could not be signed. A tag is never moved: its
number is skipped and the release ships under the next one (v1.5.3).

Operator decision, unchanged: do not reintroduce minisign, a `MINISIGN_KEY`
secret or any offline key ceremony; it once kept releases frozen for 66
commits. Keyless cosign has no key to guard.

## Dev mode

`make deploy HOST=...` pushes an HMAC-tagged binary under the deploy key
(`/etc/hermes/deploy.key` on the host, set with `edge-setup deploy-key set`
over stdin) to prove a change before tagging. It is never how a host is kept
up to date: once proven, cut the release and run
`sudo edge-setup upgrade --yes` on the host. Remove the deploy key from a host
that no longer needs dev pushes.
