# edge-setup

**Install a hardened Hermes agent runtime on your own host and link it to openedbot, outbound only.**

[![CI](https://github.com/OpenedBot/openedbot/actions/workflows/edge-setup-ci.yml/badge.svg)](https://github.com/OpenedBot/openedbot/actions/workflows/edge-setup-ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![Platforms](https://img.shields.io/badge/hosts-Debian%2012%2B%20%7C%20Ubuntu%2024.04%2B-lightgrey)

## Overview

**edge-setup** is a single static Go binary that you run **on your own host**
(a VPS or a homelab machine). It installs a pinned
[Hermes](https://github.com/NousResearch/hermes-agent) agent runtime, keeps its
gateway on loopback, and links it to [openedbot](https://openedbot.app) through
an **outbound** connector: no inbound application port is opened and the local
gateway bearer never leaves the machine. Global host hardening (firewall, SSH,
PAM, journald, unattended upgrades, sandbox) is entirely **opt-in**.

```text
 YOUR host (VPS / homelab)                             openedbot
 +--------------------------------------+            +------------------------+
 | edge-setup up . link . credentials   |            | https://openedbot.app  |
 | Hermes gateway 127.0.0.1:8642        |  outbound  | link origin:           |
 |   uid hermes, optional sandbox       |    wss     | https://link.openedbot |
 | hermes-connector (outbound link)     | =========> |   .app                 |
 |   local bearer, no inbound port      |            |                        |
 +--------------------------------------+            +------------------------+
```

The wire contract between the host and openedbot (relay frames, the gateway
route allowlist, named operator verbs) is specified in
[`protocol/SPEC.md`](../protocol/SPEC.md); the host-side reference is [`docs/CONNECTOR.md`](docs/CONNECTOR.md).

## Where it fits

| Component | Role |
|---|---|
| **`edge-setup/`** (this directory) | Host side: installer, hardening and outbound connector |
| [`apps/`](../README.md) | Cloud side: the openedbot console, API and link gateway (Apache-2.0 open core) |
| [`protocol/`](../protocol/README.md) | The connector protocol specification and test vectors, for any agent or gateway |
| [openedbot-notch](https://github.com/OpenedBot/openedbot-notch) | macOS notch UI prototype for openedbot (its own repository) |

## Supported hosts

- Debian 12+ or Ubuntu 24.04+, `amd64` or `arm64`, systemd.
- Optional protections (sandbox, firewall, SSH, PAM, journal, updates) require
  Debian 13. `--sandbox` also requires cgroup v2.
- Ubuntu 22.04 is refused: its systemd 249 cannot seal the connector key
  (`systemd-creds`, `LoadCredentialEncrypted`).

## Install

Releases are signed, keyless, with [Sigstore](https://www.sigstore.dev/). The
release workflow `.github/workflows/edge-setup-release.yml`, run on the tag
`edge-setup/vX.Y.Z`, signs the release `SHA256SUMS` through GitHub OIDC; the
signature is logged in Sigstore's public transparency log and published next to
the manifest as `SHA256SUMS.sigstore.json`. The only signer accepted for
version `vX.Y.Z` is:

- certificate identity
  `https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/vX.Y.Z`;
- OIDC issuer `https://token.actions.githubusercontent.com`.

Every release lives under the immutable
**https://releases.openedbot.app/edge-setup/vX.Y.Z/**;
`https://releases.openedbot.app/edge-setup/LATEST` names the newest one.

The bootstrap script is served at **https://docs.openedbot.app/install**. It
installs the release it was cut with (never an implicit latest), downloads
`SHA256SUMS` and its signature, verifies the signature for the identity of that
version with a pinned cosign whose SHA-256 is written in the script, and only
then downloads the binary and checks its SHA-256. There is no fallback to any
other origin: if a check fails or the origin does not answer, nothing is
installed.

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://docs.openedbot.app/install | sh
# verify everything and print the install step, writing nothing:
curl --proto '=https' --tlsv1.2 -fsSL https://docs.openedbot.app/install | sh -s -- --dry-run
# another release than the pinned one (or `--version latest`, explicitly):
curl --proto '=https' --tlsv1.2 -fsSL https://docs.openedbot.app/install | sh -s -- --version vX.Y.Z
```

`EDGE_SETUP_COSIGN=/path/to/cosign` makes the script use a cosign you already
trust instead of downloading the pinned one.

Manual install of a pinned release, with the same verification (requires
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/)):

```bash
V=vX.Y.Z   # the release to install; https://releases.openedbot.app/edge-setup/LATEST names the newest
U=https://releases.openedbot.app/edge-setup/$V
A=edge-setup_linux_$(dpkg --print-architecture)
curl --proto '=https' --tlsv1.2 -fsSL -O "$U/$A" -O "$U/SHA256SUMS" -O "$U/SHA256SUMS.sigstore.json"
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/$V" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
sudo install -m 0755 "$A" /usr/local/sbin/edge-setup
```

Stop if `cosign` does not print `Verified OK` or `sha256sum` does not print
`OK`. `upgrade`, `auto-upgrade` and `self-verify` apply the same two checks, in
the same order, with the signer identity of the version they read. A release
without a signature (every release up to v0.0.2) is refused: the first signed
release is v0.0.3.

## Quick start

```bash
sudo edge-setup detect          # host facts and readiness, read-only
sudo edge-setup plan            # exactly what `up` would do, writes nothing
sudo edge-setup up --yes        # install the runtime and the connector

# In openedbot, open Settings > Installation and create an enrollment ticket, then:
sudo edge-setup link --yes      # paste the ticket at the hidden prompt
edge-setup status
edge-setup doctor
```

`link` targets the production origin `https://link.openedbot.app` by default;
pass `--openedbot https://...` for another openedbot. The ticket is a secret: it is
read from the hidden prompt, stdin, or a `0600` file (`--ticket-file`), never
from the command line. `link` is an update-or-create: it rewrites the link of
the targeted instance. `--name <name>` creates a named instance next to the
default one (for example a development openedbot on the same host).

Minimal `up` creates a single unprivileged `hermes` account, installs the
runtime, keeps the gateway on loopback and installs the outbound connector. It
does not touch SSH, UFW, fail2ban, PAM, journald or the update policy.

Hardened profile example (every access-changing option also needs
`--console-confirmed`, and `verify-access` must be run from a **new** SSH
session within 600 s or the change rolls back):

```bash
sudo edge-setup up \
  --sandbox --persistent-journal --unattended-upgrades \
  --sudo-logging --password-policy --disable-llmnr \
  --firewall --allow-inbound 22/tcp --fail2ban \
  --ssh-hardening --quarantine-cloud-user \
  --admin-key /root/admin.pub --console-confirmed --yes
# from ANOTHER terminal:
ssh hermes-admin@203.0.113.10 && edge-setup verify-access
edge-setup audit --strict
```

## Commands

| Command | Read-only | What it does |
|---|---|---|
| `detect` | yes | Host facts and connector readiness. |
| `plan` | yes | Prints exactly what `up` would do. |
| `up` | | Installs the runtime, loopback gateway and connector; host policies are opt-in flags. On Linux it also enables the upgrade timer, unless `--no-auto-upgrade` (remembered). |
| `verify-access` | | From a fresh SSH session: proves admin access and commits a guarded policy. |
| `link` | | Pairs the runtime with openedbot (`--openedbot`, default `https://link.openedbot.app`; `--name`, `--ticket-file`, `--insecure-openedbot` for a loopback development origin only). |
| `unlink` | | Stops and removes one local link, keeping its device key and Hermes data. |
| `credentials list\|add\|login\|remove` | | Model-provider credentials, from stdin or a `0600` file, or OAuth device code (`login`). |
| `mcp`, `toolsets` | | List, add/enable or remove/disable MCP servers and toolsets on this host. |
| `doctor`, `audit [--strict]`, `status`, `export` | yes | End-to-end checks, security inventory, state, non-secret coordinates. |
| `upgrade --yes` (alias `update --self`) | | Downloads a release, verifies the Sigstore signature of its `SHA256SUMS` then the binary's SHA-256, replaces the binary, restarts the units. |
| `auto-upgrade enable\|disable\|status` | | Timer (every 6 h) that installs a newer `vX.Y.Z` release only when idle; on by default after `up` on Linux, `disable` is remembered. |
| `self-verify` | yes | Verifies the signature of the release `SHA256SUMS`, then checks the running binary against it. |
| `reset --yes`, `uninstall --yes` | | Remove everything this tool installed (see [`docs/RESET.md`](docs/RESET.md)). |
| `version` | yes | Prints the version. |

Every mutation requires `--yes`. No flag ever accepts a secret.

## What the host guarantees

Pins by commit and checksum (`internal/pins`); a single `hermes` account
without sudo or docker group; confined systemd units; gateway on loopback only,
anonymous access refused, exact tool catalog; egress to cloud metadata ranges
denied in the gateway, connector and operator units; a link that relays only
the gateway allowlist plus named operator verbs (providers, read-only quotas,
toolsets, MCP servers and **one** fixed gateway restart). Never a shell, a
path, an `exec` or an `update` over the wire.

What the host cannot guarantee: prompt injection through content an agent
reads. That is handled by approvals in openedbot. Outbound network traffic is
not filtered, except for cloud metadata ranges.

## Configuration

edge-setup is configured with command-line flags only (see [Commands](#commands));
no flag ever accepts a secret. Tickets and credentials are read from a hidden
prompt, stdin or a `0600` file. `NO_COLOR` disables coloured output.

## Development

Requires Go 1.26 or later (`go.mod`; toolchain pinned there) and `make`.

```bash
make check       # gofmt, vet, offline unit tests (golden files included), release checks
make build       # dist/edge-setup for this machine
make build-all   # linux + darwin, amd64 + arm64, plus install.sh and SHA256SUMS
make release     # the same, unsigned (only the release workflow signs), and a .deb if nfpm is installed
```

## Testing

| Command | What it does |
|---|---|
| `make test` | Offline unit tests |
| `make lint` | gofmt + vet; staticcheck and govulncheck when installed (`LINT_STRICT=1` requires them) |
| `make lint-tools` | Installs staticcheck and govulncheck at the versions pinned in the Makefile and checks their module sums |
| `make test-update` | Regenerate the golden files (review the diff) |
| `make integration` | Integration tests in a Debian 13 + systemd container (network required) |
| `make integration-vm` | Full `up` in a Debian 13 QEMU VM |
| `make contract-check` | Link contract on both sides; needs the monorepo root `..` (`OPENEDBOT_MAIN_DIR`) |
| `make check-docs` | Checks the documentation site in `../docs` (`DOCS_DIR`) against `docs/` |

CI ([`.github/workflows/edge-setup-ci.yml`](../.github/workflows/edge-setup-ci.yml) at the monorepo
root) runs the static checks and tests on every push to `main` and every pull request touching
edge-setup; pushing an `edge-setup/vX.Y.Z` tag runs
[`.github/workflows/edge-setup-release.yml`](../.github/workflows/edge-setup-release.yml).

More: [`docs/OPERATIONS.md`](docs/OPERATIONS.md), [`docs/RELEASING.md`](docs/RELEASING.md),
[`docs/PROVENANCE.md`](docs/PROVENANCE.md), [`docs/RESET.md`](docs/RESET.md).

## Project structure

```text
cmd/edge-setup/   CLI entry point
internal/         commands, connector, gateway, hardening, sandbox, pins, self-update, …
test/             golden files, integration, release and VM tests
packaging/        .deb packaging (nfpm)
scripts/          release publishing
docs/             connector reference, operations, releasing, provenance, reset
assets/           embedded Hermes hooks and plugins, A2A assets, notices
```

## Documentation

- Full documentation: <https://docs.openedbot.app>
- Host-side connector reference: [`docs/CONNECTOR.md`](docs/CONNECTOR.md)
- A French version of this page: [`docs/README.fr.md`](docs/README.fr.md)

The `/hermes-setup/` routes are technical identifiers kept for compatibility.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
never in a public issue.

## License

Copyright 2026 Kévin Aubrée. Licensed under the [Apache License, Version 2.0](LICENSE).
Third-party notices: [NOTICE](NOTICE).
