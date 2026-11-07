// Package layout fixes the on-disk namespace of everything edge-setup
// (formerly hermes-setup) creates. The names are a contract with hosts
// already provisioned (units, state markers, backups): renaming one requires
// a migration, never a silent change. The tool rename kept every
// path below as it was, except the installed binary's own filename and its
// PATH copies, where a hermes-setup symlink alias now sits next to the
// canonical edge-setup file so an already-provisioned host keeps working.
package layout

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

// Service accounts.
const (
	// ServiceUser runs the gateway and owns HERMES_HOME. No sudo, no docker group.
	ServiceUser = "hermes"
	// ConnectorUser is deliberately the sole service account. Per-service
	// mount/PID namespaces keep the connector away from runtime data despite
	// the shared uid; credentials are still injected by systemd.
	ConnectorUser = ServiceUser
	// LegacyConnectorUser is removed after a successful unit migration.
	LegacyConnectorUser = "hermes-connector"
	// AdminUser is the key-only SSH administrator created by the harden phase.
	AdminUser = "hermes-admin"
	// AdminSudoPassword (the default) makes sudo ask hermes-admin's own
	// password; AdminSudoNoPasswd keeps the former NOPASSWD rule
	// (`--admin-sudo=nopasswd`).
	AdminSudoPassword = "password"
	AdminSudoNoPasswd = "nopasswd"
	// QuarantineUser is the cloud-init account put in quarantine.
	QuarantineUser = "debian"
	// QuarantineSudoers is the cloud-init sudoers drop-in backed up then removed.
	QuarantineSudoers = "/etc/sudoers.d/90-cloud-init-users"
	// QuarantineSudoersLine is the exact active directive expected in it.
	QuarantineSudoersLine = "debian ALL=(ALL) NOPASSWD:ALL"
)

// Hermes runtime.
const (
	RuntimeRoot     = "/srv/hermes/data"
	RuntimeEnv      = RuntimeRoot + "/runtime.env"
	RuntimeConfig   = RuntimeRoot + "/config.yaml"
	WorkspaceRoot   = RuntimeRoot + "/workspaces"
	SandboxDir      = RuntimeRoot + "/sandboxes"
	InstallDir      = "/usr/local/lib/hermes-agent"
	VenvBin         = InstallDir + "/venv/bin"
	UVRoot          = "/usr/local/lib/hermes-uv"
	UVBinary        = UVRoot + "/uv"
	UVPythonBinDir  = UVRoot + "/python-bin"
	UVConfigDir     = UVRoot + "/xdg-config"
	PythonInstall   = "/usr/local/share/hermes-python"
	UVCacheDir      = "/var/cache/hermes/uv"
	BootstrapHome   = "/usr/local/lib/hermes-bootstrap"
	InstallerPath   = DownloadDir + "/hermes-install.sh"
	GatewayHost     = "127.0.0.1"
	GatewayPort     = 8642
	GatewayUnit     = "hermes-gateway"
	GatewayUnitPath = "/etc/systemd/system/" + GatewayUnit + ".service"
)

// DownloadDir holds the pinned downloads root executes or unpacks. It is a
// root-owned 0700 directory: a shared directory such as /var/tmp would let
// another account plant or keep a writable copy of a file root later runs.
const DownloadDir = "/var/cache/hermes/downloads"

// LegacyDownloadPaths are where earlier releases kept their downloads, under
// /var/tmp; they are only ever removed, never read.
var LegacyDownloadPaths = []string{"/var/tmp/hermes-install.sh", "/var/tmp/uv-" + pins.UVVersion + ".tar.gz"}

// UVArchivePath is where the pinned uv release archive is downloaded before
// verification; named after the pin so a bump never reuses a stale file.
func UVArchivePath() string { return DownloadDir + "/uv-" + pins.UVVersion + ".tar.gz" }

// Node for the runtime's bridges: a root-owned tree, reached through PATH.
// It deliberately does NOT live under HERMES_HOME, where the service user
// could rewrite the interpreter its own gateway executes.
const (
	NodeRoot = "/usr/local/lib/hermes-node"
	NodeBin  = NodeRoot + "/bin"
)

// NodeArchivePath names the archive after the pin, so a bump never reuses a
// stale file.
func NodeArchivePath(target string) string {
	return DownloadDir + "/node-" + pins.NodeVersion + "-linux-" + target + ".tar.xz"
}

// DockerModulesLoad persists the kernel modules the rootless sandbox needs
// across reboots (systemd-modules-load).
const DockerModulesLoad = "/etc/modules-load.d/hermes-docker.conf"

// ManagedConfig is Hermes' managed-scope config (hermes_cli/managed_scope.py),
// merged over every profile's config.yaml.
const ManagedConfig = "/etc/hermes/config.yaml"

// Tool state.
const (
	ToolConfig       = "/etc/hermes/hermes-setup.json"
	ToolStateDir     = "/var/lib/hermes-setup"
	ToolLock         = ToolStateDir + "/lock"
	ToolJournal      = ToolStateDir + "/journal.jsonl"
	ToolRebootMarker = ToolStateDir + "/awaiting-reboot"
	// ToolQuarantineDir keeps what `up` had to take out of the managed Hermes
	// checkout, one timestamped directory per pass. Nothing is deleted: a
	// paired bridge or a file dropped by the client is worth more than the
	// disk it occupies, and a silent removal cannot be supported afterwards.
	ToolQuarantineDir = ToolStateDir + "/quarantine"
	ToolInstallDir    = "/usr/local/lib/hermes-setup"
	// ToolInstalledPath is the canonical installed binary since the
	// edge-setup rename; ToolAliasPath is the pre-rename filename,
	// kept as a symlink to it in the same directory.
	ToolInstalledPath = ToolInstallDir + "/edge-setup"
	ToolAliasPath     = ToolInstallDir + "/hermes-setup"
	// ToolPreviousPath keeps the binary an automatic upgrade replaced, so the
	// pass can put it back when the new one does not bring the link up.
	ToolPreviousPath = ToolInstallDir + "/edge-setup.previous"
	// AutoUpgradeUnit is the oneshot service and timer of `auto-upgrade
	// enable`; AutoUpgradeRecord is what its last pass saw and did.
	AutoUpgradeUnit   = "hermes-setup-upgrade"
	AutoUpgradeRecord = ToolStateDir + "/auto-upgrade.json"
	// AutoUpgradeDeclined remembers that the owner refused the timer, so a
	// later `up` does not enable it again by default.
	AutoUpgradeDeclined = ToolStateDir + "/auto-upgrade.declined"
	// AutoUpgradeTimerWants is the link `systemctl enable` makes for the
	// timer: present (and resolving) exactly while auto-upgrade is enabled.
	AutoUpgradeTimerWants = "/etc/systemd/system/timers.target.wants/" + AutoUpgradeUnit + ".timer"
	// UpgradeLock serialises a manual `upgrade` and an automatic pass.
	UpgradeLock = ToolStateDir + "/upgrade.lock"
	AuditDir    = "/var/lib/hermes/audit"
	// DeployKey is the shared deployment secret that tags a binary uploaded
	// through `upgrade --from`; written by `deploy-key set`, root 0600.
	DeployKey = "/etc/hermes/deploy.key"
)

// ToolPathCopies are the places where an operator conventionally installs a
// copy of the tool for the PATH (docs: `install … /usr/local/sbin/edge-setup`,
// the .deb: /usr/sbin). `upgrade` refreshes each one that exists as a regular
// file so the shell and the units run the same code.
var ToolPathCopies = []string{"/usr/local/sbin/edge-setup", "/usr/sbin/edge-setup", "/usr/local/bin/edge-setup"}

// ToolLegacyPathCopies are the pre-rename names of ToolPathCopies, in the
// same directories, index for index. `upgrade` keeps each one that exists as
// a symlink pointing at its edge-setup sibling, so a script or a habit that
// still types hermes-setup keeps running the same build.
var ToolLegacyPathCopies = []string{"/usr/local/sbin/hermes-setup", "/usr/sbin/hermes-setup", "/usr/local/bin/hermes-setup"}

// ToolPathLink is the symlink `up` and `upgrade` keep pointing at the
// installed binary, in a directory every user's PATH contains: the admin
// types `edge-setup status` and the tool re-executes itself with sudo.
const ToolPathLink = "/usr/local/bin/edge-setup"

// ToolLegacyPathLink is the pre-rename alias of ToolPathLink, kept pointing
// at the same installed binary so `hermes-setup status` still works.
const ToolLegacyPathLink = "/usr/local/bin/hermes-setup"

// Host hardening transaction (unchanged from the previous tool).
const (
	HardeningStateDir     = "/var/lib/hermes-host-hardening"
	HardeningActive       = HardeningStateDir + "/active"
	HardeningFinalized    = HardeningStateDir + "/finalized"
	HardeningRolledBack   = HardeningStateDir + "/rolled-back"
	HardeningLock         = HardeningStateDir + "/rollback.lock"
	HardeningBackupDir    = "/var/backups/hermes-access"
	HardeningRollbackUnit = "hermes-hardening-rollback"
	// LoopbackGuardUnit pins the owner-match iptables rules that reserve the
	// private loopback ports for the service user and root (hardening).
	LoopbackGuardUnit = "hermes-loopback-guard"
	// HardeningRollbackDelaySeconds is fixed; a tunable window is a lockout.
	HardeningRollbackDelaySeconds = 600
	SSHDropin                     = "/etc/ssh/sshd_config.d/00-hermes-hardening.conf"
	ResolvedDropin                = "/etc/systemd/resolved.conf.d/90-hermes-hardening.conf"
	PwqualityDropin               = "/etc/security/pwquality.conf.d/90-hermes-hardening.conf"
	Fail2banJail                  = "/etc/fail2ban/jail.d/sshd.local"
	SudoersAdmin                  = "/etc/sudoers.d/80-hermes-admin"
	SudoersLogging                = "/etc/sudoers.d/81-hermes-logging"
	SudoLog                       = "/var/log/sudo.log"
	SudoLogrotate                 = "/etc/logrotate.d/hermes-sudo"
	AptAutoUpgrades               = "/etc/apt/apt.conf.d/20auto-upgrades"
	AptUnattended                 = "/etc/apt/apt.conf.d/52-hermes-unattended"
	PasswordMinLength             = 14
	SSHPort                       = 22
)

// Legacy proxy transaction paths retained only for safe cleanup/rollback.
const (
	Caddyfile         = "/etc/caddy/Caddyfile"
	ProxyStateDir     = "/var/lib/hermes-proxy-transaction"
	ProxyActive       = ProxyStateDir + "/active"
	ProxyBackupDir    = "/var/backups/hermes-proxy"
	ProxyRollbackUnit = "hermes-proxy-rollback"
)

// Connector (outbound mode).
const (
	ConnectorDir  = "/etc/hermes/connector"
	ConnectorLink = ConnectorDir + "/link.json"
	// ConnectorDeviceKey is the Ed25519 seed encrypted by systemd-creds
	// (TPM2 or host key); the plaintext exists only in the connector's
	// CREDENTIALS_DIRECTORY, never on disk.
	ConnectorDeviceKey = ConnectorDir + "/device.key.cred"
	ConnectorAllowlist = ConnectorDir + "/allowlist.json"
	ConnectorStateDir  = "/var/lib/hermes-connector"
	ConnectorRunsDir   = ConnectorStateDir + "/runs"
	ConnectorUnit      = "hermes-connector"
	// ConnectorTemplateUnit is the systemd template behind every named
	// instance (hermes-connector@<name>.service). The default instance keeps
	// ConnectorUnit and the paths above, byte for byte.
	ConnectorTemplateUnit = ConnectorUnit + "@"
	// OperatorUnit is the root service that executes `hermes auth add` for
	// the link: the connector reaches it through OperatorSocket only.
	OperatorUnit     = "hermes-operator"
	OperatorRunDir   = "/run/" + OperatorUnit
	OperatorStateDir = "/var/lib/" + OperatorUnit
	OperatorSocket   = OperatorRunDir + "/operator.sock"
)

// EgressDenyNetworks are the cloud instance-metadata ranges refused by the
// gateway, connector and operator units (IPAddressDeny=). Those units carry no
// IPAddressAllow= over these ranges: systemd grants an address that matches it
// before it reads the deny list (systemd.resource-control(5)). The one
// exception is the host's own resolver when it sits inside a range
// (internal/egress). Never 127.0.0.0/8.
var EgressDenyNetworks = []string{"169.254.0.0/16", "fd00:ec2::/64"}

// ResolvConf is where the C library and Go's resolver read the nameservers a
// unit's processes will use.
const ResolvConf = "/etc/resolv.conf"

// ResolvedResolvConf is the upstream list systemd-resolved keeps while it
// runs: the nameservers behind the 127.0.0.53 stub that ResolvConf then names.
const ResolvedResolvConf = "/run/systemd/resolve/resolv.conf"

// ResolverFiles are the files the host's real nameservers are read from. The
// host-wide firewall needs both: it also filters systemd-resolved's own
// upstream queries (internal/egress).
var ResolverFiles = []string{ResolvConf, ResolvedResolvConf}

// OperatorProbe is the interpreter program the operator installs for the
// toolset and MCP verbs. It lives under the tool's root, owned by root and
// never writable by the service user that executes it.
const OperatorProbe = ToolInstallDir + "/inventory-probe.py"

// OperatorOAuthProbe is the long-lived interpreter program the operator
// starts to authorize one `auth: oauth` MCP server (docs/CONNECTOR.md,
// « OAuth MCP par le lien »). Same ownership and mode as OperatorProbe.
const OperatorOAuthProbe = ToolInstallDir + "/mcp-oauth-probe.py"

// GatewayRestartMarker records that a change the gateway reads at boot landed
// after it last started (an MCP write, A2A credentials, profile capabilities,
// an upgrade that changed the gateway unit's directives while runs were in
// progress; a comment-only unit change sets none), so a page can say
// « restart pending » from a fact and not from a guess. It lives under the
// operator's RuntimeDirectory, which the operator unit keeps across restarts
// (RuntimeDirectoryPreserve=yes, pinned by a render test): it survives an
// operator restart and vanishes with the reboot that would have restarted the
// gateway anyway.
const GatewayRestartMarker = OperatorRunDir + "/gateway-restart-pending"

// ConnectorInstance names one link on the host (docs/CONNECTOR.md « Named
// instances »). The empty name is the default instance: the unit and the
// paths hosts were provisioned with. A named instance owns
// /etc/hermes/connector/<name>/{link.json,device.key.cred}, the unit
// hermes-connector@<name>.service and the state directory
// /var/lib/hermes-connector/<name>, so two links to two openedbot
// origins never share a runs journal, an audit key or a device key.
type ConnectorInstance string

// DefaultConnectorInstance is the unnamed, pre-existing link.
const DefaultConnectorInstance ConnectorInstance = ""

var connectorInstanceRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// reservedConnectorInstances are the subdirectories the default instance
// already keeps under its own state directory: a name among them would
// alias /var/lib/hermes-connector/<name> onto the default instance's data.
var reservedConnectorInstances = map[string]bool{"default": true, "runs": true, "diagnostics": true, "creation-audit": true}

// ParseConnectorInstance validates a --name value. The empty string is the
// default instance.
func ParseConnectorInstance(name string) (ConnectorInstance, error) {
	if name == "" {
		return DefaultConnectorInstance, nil
	}
	if !connectorInstanceRe.MatchString(name) {
		return "", fmt.Errorf("--name %q: an instance name is 1–32 characters, lowercase letters, digits and dashes, starting with a letter", name)
	}
	if reservedConnectorInstances[name] {
		return "", errors.New("--name " + name + " is reserved (omit --name for the default instance)")
	}
	return ConnectorInstance(name), nil
}

// IsDefault reports whether this is the unnamed instance.
func (i ConnectorInstance) IsDefault() bool { return i == DefaultConnectorInstance }

// Label is the name shown by status ("default" for the unnamed instance).
func (i ConnectorInstance) Label() string {
	if i.IsDefault() {
		return "default"
	}
	return string(i)
}

// DirUnder is the instance's configuration directory below root (tests
// redirect root; production uses ConnectorDir).
func (i ConnectorInstance) DirUnder(root string) string {
	if i.IsDefault() {
		return root
	}
	return root + "/" + string(i)
}

// Dir is /etc/hermes/connector, or /etc/hermes/connector/<name>.
func (i ConnectorInstance) Dir() string { return i.DirUnder(ConnectorDir) }

// LinkPath is the enrollment file handed to the unit as a credential.
func (i ConnectorInstance) LinkPath() string { return i.Dir() + "/link.json" }

// DeviceKeyPath is the sealed Ed25519 seed of this instance.
func (i ConnectorInstance) DeviceKeyPath() string { return i.Dir() + "/device.key.cred" }

// Unit is the systemd unit name without suffix: hermes-connector, or
// hermes-connector@<name>.
func (i ConnectorInstance) Unit() string {
	if i.IsDefault() {
		return ConnectorUnit
	}
	return ConnectorTemplateUnit + string(i)
}

// StateDir is what systemd exposes as $STATE_DIRECTORY to the daemon.
func (i ConnectorInstance) StateDir() string {
	if i.IsDefault() {
		return ConnectorStateDir
	}
	return ConnectorStateDir + "/" + string(i)
}
