# edge-setup security

This page is for an operator who wants to know what `edge-setup` does to a
host before running it, what it protects against, and how to check a release
by hand. To report a vulnerability, see [`SECURITY.md`](../SECURITY.md).

`edge-setup` installs the Hermes runtime on a Linux server (Debian 12+,
Ubuntu 24.04+, amd64 or arm64) and links it to openedbot over an outbound
connection. It has two parts:

- the **bootstrap**, a POSIX `sh` script served at
  `https://docs.openedbot.app/install` (source: `docs/public/install`);
- the **binary**, `edge-setup`, a static Go program (source: `edge-setup/`).

## Threat model

### What is protected

| Asset | Where it lives |
|---|---|
| Root on the host | the host itself |
| The device key (Ed25519 seed that proves the host's identity) | `/etc/hermes/connector/device.key.cred`, sealed by `systemd-creds` (TPM2 when present, host key otherwise); never leaves the host |
| The link token | `/etc/hermes/connector/link.json`, 0600 |
| The gateway bearer and provider keys | `/srv/hermes/data` (`runtime.env`, `.env`), 0600, owner `hermes` |
| Workspaces and agent data | `/srv/hermes/data` |
| The enrollment ticket | memory only, for at most 5 minutes, single use |

### Who we defend against

| Adversary | What stops them |
|---|---|
| A network attacker between the host and the release origin, a CDN, or a mirror | every binary is verified against a `SHA256SUMS` signed keyless by the release workflow (Sigstore); HTTPS only; any failure installs nothing |
| An attacker who controls `releases.openedbot.app` | cannot produce a valid signature; can withhold releases or point `LATEST` at an older or the same signed one, which `upgrade` refuses without `--allow-downgrade` and `auto-upgrade` always refuses |
| An agent workload running in the gateway (prompt injection, malicious tool) | runs as the unprivileged `hermes` account, no shell, no sudo; the gateway unit hides the connector's credentials, the operator socket and the rest of the system (`ProtectSystem=strict`, `ProtectHome=tmpfs`, no capability); the operator also refuses any peer that is not root or the connector's own system unit, so a `hermes` process outside the gateway (rootless Docker, the user manager) cannot drive it either; cloud metadata endpoints are denied |
| An unprivileged local user | the gateway listens on `127.0.0.1:8642` only and requires the bearer; with `--firewall`, an owner-match rule refuses loopback connections from any uid but `hermes` and root; every secret file is 0600 |
| Someone who steals the link token | cannot reconnect without the device key (proof of possession at every connection); the token rotates over the link |
| Someone who reads a log or a shell history | the ticket is refused on the command line and is read from a no-echo prompt, stdin or a 0600 file; the journal masks anything shaped like a secret |
| A host that is uninstalled or decommissioned | `uninstall` asks openedbot to revoke the runtime before removing the link |

### Out of scope

- An attacker who is already root on the host.
- A compromise of the GitHub repository, of its release workflow on a release
  tag, of GitHub's OIDC issuer, or of the Sigstore public-good instance
  (Fulcio, Rekor, its TUF root). These are the trust anchors.
- The security of the AI providers and of the tools an agent is allowed to use.
- Physical access, and provider snapshots of the disk (they hold the data in
  clear; encrypt the disk when the server is created).

### Trust chain of a release

```
  tag edge-setup/vX.Y.Z
          |
          v
  +------------------------------+      OIDC token      +---------------------+
  |  edge-setup-release.yml      |  ----------------->  |  Fulcio (Sigstore)  |
  |  (GitHub Actions)            |  <-----------------  |  short-lived cert   |
  +------------------------------+      certificate     +---------------------+
          |  signs SHA256SUMS,                                     |
          |  logs it in Rekor                                      v
          v                                              +---------------------+
  +------------------------------+                       |  Rekor (public log) |
  |  releases.openedbot.app      |                       +---------------------+
  |  /edge-setup/vX.Y.Z/         |
  |  SHA256SUMS + .sigstore.json |   untrusted transport: it can withhold,
  |  binaries                    |   it cannot forge
  +------------------------------+
          |
          v
  bootstrap / upgrade / auto-upgrade / self-verify:
    1. bundle verifies for identity
       .../edge-setup-release.yml@refs/tags/edge-setup/vX.Y.Z   else stop
    2. sha256(binary) == line in SHA256SUMS                     else stop
    3. only then: install, execute
```

The identity is bound to the version: a valid signature of `v0.0.3` cannot be
replayed as `v0.0.4`. It is one exact string, compared character for
character: no prefix, no pattern, so a bundle signed on `edge-setup/v0.0.30`,
on a branch or by another workflow never verifies for `v0.0.3`. The version
is the one asked for (`--version`), the installed one (`self-verify`), or the
one `LATEST` names, read once: the binary must then claim that same version,
or nothing is installed.

`upgrade` and `auto-upgrade` install only a version strictly newer than the
installed one. `upgrade --allow-downgrade` lets an operator reinstall the same
or an older release, still signed by the workflow run on that release's own
tag: an unsigned release (v0.0.2 and before) stays refused. `auto-upgrade`
never goes back. A version is `vX.Y.Z` with decimal numbers and no leading
zero; anything else is refused before any download, by the bootstrap as by the
binary.

## What the bootstrap does

`curl --proto '=https' --tlsv1.2 -fsSL https://docs.openedbot.app/install | sh`

Every statement is inside a function and `main` runs on the last line, so a
truncated download executes nothing. The script runs with `set -eu`, and with
`pipefail` where the shell supports it.

1. Checks the platform: Linux, `amd64` or `arm64`, and the commands it needs.
2. Creates a private temporary directory, removed on exit.
3. Picks the version it was published with (`PINNED_VERSION`), never an
   implicit latest. `--version vX.Y.Z` picks another one; `--version latest`
   reads the `LATEST` pointer explicitly.
4. Downloads `SHA256SUMS` and `SHA256SUMS.sigstore.json` for that version.
   No bundle: stop.
5. Gets cosign to check the signature: the operator's own
   (`EDGE_SETUP_COSIGN=/path/to/cosign`), or cosign v3.1.4 downloaded from
   `github.com/sigstore/cosign/releases`, whose SHA-256 is written in the
   script. A mismatch: stop.
6. Verifies the bundle for the identity of the release workflow on the tag of
   that version. Any failure: stop. cosign's trust cache (`TUF_ROOT`) stays in
   the temporary directory.
7. Downloads `edge-setup_linux_<arch>` and compares its SHA-256 with
   `SHA256SUMS`. A mismatch: stop.
8. Installs it with `install -m 0755` to `/usr/local/sbin/edge-setup`, through
   `sudo` when not root, and runs `edge-setup version`.

`--dry-run` does steps 1 to 7 and prints step 8 without doing it. The script
writes nothing else, starts nothing, and does not configure the host:
that is `sudo edge-setup up`.

Network destinations of the bootstrap: `releases.openedbot.app`, `github.com`
(cosign, unless `EDGE_SETUP_COSIGN` is set) and the Sigstore TUF repository
`tuf-repo-cdn.sigstore.dev`.

## What edge-setup does to the host

`edge-setup plan` (or `up --dry-run`) prints the exact plan for the options
given, and writes nothing. `up --yes` then:

- creates one service account, `hermes`: system account, `nologin` shell, no
  sudo, no password;
- installs the runtime under root-owned trees (`/usr/local/lib/hermes-*`),
  every download pinned by version and SHA-256 (uv, Node.js, the Hermes
  installer and commit, Python dependencies from a hashed lock file);
- writes its data under `/srv/hermes/data` (owner `hermes`, secrets 0600) and
  its configuration under `/etc/hermes` (root, the link and device key 0600);
- installs systemd units and opens **no inbound port**. The gateway listens on
  loopback; the connector only dials out.

`systemd-analyze security` exposure (lower is better; measured on Debian 13,
systemd 257):

| Unit | User | Exposure | Why not lower |
|---|---|---|---|
| `hermes-connector` | hermes | 1.3 | — |
| `hermes-operator` | root | 2.5 | it must switch to `hermes` (`runuser`) to run the provider sign-in commands openedbot asks for; capabilities limited to SETUID, SETGID, CHOWN, FOWNER, DAC_OVERRIDE |
| `hermes-gateway` | hermes | 1.3 | runs arbitrary agent tools (Node.js JIT, Python, optional rootless Docker). It has the `@system-service` system call filter, `RestrictNamespaces`, `PrivateDevices`, `PrivateUsers`, `ProtectProc=invisible`, `RemoveIPC` and no capability; `MemoryDenyWriteExecute` (kills the Node.js JIT), `ProcSubset=pid` (hides `/proc/meminfo` and `/proc/cpuinfo`) and `UMask=0027` (hides agent files from non-root sandbox users) were measured and left out. Two `ExecStartPre=+` lines run as root before it starts: one creates `/run/credentials`, one waits up to 60 s for the rootless Docker socket |
| `hermes-setup-upgrade` (opt-in timer) | root | 7.0 | it replaces the binary and restarts units |
| `hermes-loopback-guard` (with `--firewall`) | root | 1.8 | — (writes iptables rules: NET_ADMIN and NET_RAW only, no IP traffic, no device) |
| `hermes-hardening-rollback` (with `--ssh-hardening`) | root | 8.8 | restores SSH access if a hardening is not confirmed in 10 minutes |

**The operator socket.** `hermes-operator` serves a fixed list of named
verbs; an unknown route gets `404 ROUTE_UNKNOWN`, and no verb takes a command,
a path or a free argument. Before routing it refuses dot segments, empty
segments and encoded slashes; every route parameter is checked against its
grammar before its handler runs, and MCP bodies are checked before any
process starts. Each connection is then checked with `SO_PEERCRED`: root is
accepted, the `hermes` account only from the connector's own system unit
(its cgroup under `/system.slice`, which only PID 1 can place a process in);
the gateway, the rootless Docker daemon and the `hermes` user manager share
that uid and are refused. Its unit adds `RestrictNamespaces=true`,
`MemoryDenyWriteExecute=` and `ProtectProc=invisible`, which brings its
exposure from 3.1 to 2.5.

Host policies are opt-in, each by its own flag, and apply inside a
transaction that rolls back by itself if access is not confirmed:
`--ssh-hardening`, `--firewall`, `fail2ban`, password policy, LLMNR,
unattended upgrades, persistent journal, sudo logging, cloud-init account
quarantine.

**`--ssh-hardening` creates an administrator.** It creates `hermes-admin`,
key-only SSH login, to replace the cloud-init account it quarantines. Its rule
in `/etc/sudoers.d/80-hermes-admin` asks its own password for every `sudo`
(`--admin-sudo=password`, the default): a stolen SSH key alone does not give
root. `up` asks that password twice on the terminal, without echo, or
generates one, shows it once on the terminal and waits for the operator to
confirm it is stored; without a terminal it reads `--admin-password-file`
(a 0600 file owned by the caller). The password is never printed on stdout or
stderr, never written to the journal or the state file, and is set with
`chpasswd` on stdin only after the reloaded sshd is proved to refuse passwords.
It must be at least as long as the password policy's minimum (14).
`--admin-sudo=nopasswd` keeps the former `NOPASSWD: ALL` rule, and hosts
hardened before this option keep theirs. Without `--ssh-hardening`, no sudoers
file is written. `audit` fails if a file of `/etc/sudoers.d` grants a rule to
`hermes`, if the administrator rule exists without `--ssh-hardening`, or if it
grants `NOPASSWD` where a password was chosen.

Network destinations of the binary:

| Destination | When |
|---|---|
| `releases.openedbot.app` | `upgrade`, `auto-upgrade`, `self-verify` (signed) |
| `tuf-repo-cdn.sigstore.dev` | the same, to refresh the Sigstore trusted root (cached in `/var/lib/hermes-setup/sigstore`) |
| `github.com`, `raw.githubusercontent.com`, `nodejs.org`, PyPI | `up`, `upgrade`: runtime downloads, each pinned by SHA-256 or lock-file hash |
| Debian or Ubuntu mirrors, `download.docker.com` | `up`: APT, signed by the distribution or the pinned Docker key |
| The openedbot origin (`wss://…`) | `link` and the connector: TLS, proof of possession |

### Life cycle

- **Preview:** `up --dry-run`, `upgrade --dry-run`, `uninstall --dry-run`
  and `reset --dry-run` print what would happen and write nothing.
- **Update:** `upgrade` verifies the signed release, keeps the current
  binary, installs the new one, and proves it (operator active, gateway
  `/health`, each link admitted again by openedbot). If a proof fails, the
  previous binary is put back and proved. On Linux, `up` turns automatic
  updates on unless `--no-auto-upgrade`; a refusal is remembered
  (`auto-upgrade disable --yes`, `auto-upgrade enable --yes`).
- **Uninstall:** `uninstall` stops each connector, asks openedbot to revoke
  each runtime over a session proved by the device key, then removes the
  units, the binary and the configuration, and keeps or purges the data as
  asked. If openedbot does not confirm a revocation within 20 seconds, the
  command says so and names where to revoke it by hand (Settings →
  Installation → Edge), and goes on.
- **Journal:** commands that change the host append their output to
  `/var/lib/hermes-setup/journal.jsonl` (root, 0600), with anything shaped
  like a secret masked.

## Verify a release by hand

You need cosign v3 or later (<https://docs.sigstore.dev/cosign/system_config/installation/>).
Pick the version and download the files:

```sh
VERSION=v0.0.3
BASE=https://releases.openedbot.app/edge-setup/$VERSION
ARCH=amd64   # or arm64
curl --proto '=https' --tlsv1.2 -fsSLO "$BASE/SHA256SUMS"
curl --proto '=https' --tlsv1.2 -fsSLO "$BASE/SHA256SUMS.sigstore.json"
curl --proto '=https' --tlsv1.2 -fsSLO "$BASE/edge-setup_linux_$ARCH"
```

Verify that `SHA256SUMS` was signed by the release workflow, on the tag of
that version:

```sh
cosign verify-blob \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/$VERSION" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

It must print `Verified OK`. Then check the binary against the signed list:

```sh
sha256sum --ignore-missing -c SHA256SUMS
```

It must print `edge-setup_linux_<arch>: OK`. Each file of the release also has
its own bundle (`<file>.sigstore.json`), verified the same way with the file
name instead of `SHA256SUMS`. The bootstrap itself ships signed in each release
as `install.sh`: download it with `install.sh.sigstore.json`, verify it, read
it, then run `sh install.sh`.

On a host where edge-setup is installed, `edge-setup self-verify` does the
same checks against the running binary, for the release of the installed
version (not `LATEST`); a build that is not a published `vX.Y.Z` is refused.

## Remaining risks

- **First contact.** `curl … | sh` trusts the script as served over HTTPS by
  `docs.openedbot.app` at that moment. Verify `install.sh` from the release
  first if that is not acceptable.
- **Trust anchors.** A compromise of the repository's release workflow, of
  GitHub's OIDC issuer or of Sigstore defeats the signature.
- **Root components.** The operator, the update timer, the loopback guard and
  the hardening rollback run as root, by design; their exposure scores are
  above.
- **The gateway runs untrusted agent work.** Its confinement is a filesystem,
  capability and network boundary, not a sandbox for hostile native code:
  use `--sandbox` (rootless Docker) for tools that run untrusted code.
- **Revocation needs openedbot.** An uninstall done while openedbot is
  unreachable, or older than this version, leaves the runtime to revoke by
  hand; the command says so.
