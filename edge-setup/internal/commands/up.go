package commands

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/netip"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/access"
	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/apt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/audit"
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/docker"
	"github.com/OpenedBot/openedbot/edge-setup/internal/egress"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hardening"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/proxy"
	"github.com/OpenedBot/openedbot/edge-setup/internal/render"
	"github.com/OpenedBot/openedbot/edge-setup/internal/sandbox"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/term"
)

type upOptions struct {
	adminKeyFile      string
	adminSudo         string
	adminPasswordFile string
	// adminPassword is filled by runUp, never by a flag.
	adminPassword       string
	yes                 bool
	console             bool
	detach              bool
	sandbox             bool
	persistentJournal   bool
	unattendedUpgrades  bool
	sudoLogging         bool
	passwordPolicy      bool
	disableLLMNR        bool
	firewall            bool
	allowedInbound      inboundRules
	fail2ban            bool
	sshHardening        bool
	quarantineCloudUser bool
	// autoUpgrade decides the upgrade timer once `up` succeeds (on by
	// default, see autoupgrade_default.go). It is not a host policy: it
	// changes no access and is not recorded in the state.
	autoUpgrade autoUpgradeChoice
	// dryRun prints the plan (`plan`) instead of applying it.
	dryRun bool
}

type inboundRules []string

func (r *inboundRules) String() string { return strings.Join(*r, ",") }

func (r *inboundRules) Set(value string) error {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(value)), "/")
	if len(parts) != 2 || (parts[1] != "tcp" && parts[1] != "udp") {
		return errors.New("must be PORT/tcp or PORT/udp")
	}
	port, err := strconv.Atoi(parts[0])
	if err != nil || port < 1 || port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	canonical := fmt.Sprintf("%d/%s", port, parts[1])
	for _, current := range *r {
		if current == canonical {
			return nil
		}
	}
	*r = append(*r, canonical)
	return nil
}

func (o *upOptions) requestedFeatures() state.Features {
	return state.Features{
		Sandbox: o.sandbox, PersistentJournal: o.persistentJournal,
		UnattendedUpgrades: o.unattendedUpgrades, SudoLogging: o.sudoLogging,
		PasswordPolicy: o.passwordPolicy, DisableLLMNR: o.disableLLMNR,
		Firewall: o.firewall, AllowedInbound: append([]string{}, o.allowedInbound...),
		Fail2Ban: o.fail2ban, SSHHardening: o.sshHardening,
		QuarantineCloudUser: o.quarantineCloudUser,
	}
}

func bindUpFlags(fs *flag.FlagSet) *upOptions {
	o := &upOptions{}
	fs.StringVar(&o.adminKeyFile, "admin-key", "", "file with the single ssh-ed25519 public key of the administrator")
	fs.StringVar(&o.adminSudo, "admin-sudo", layout.AdminSudoPassword, "sudo rule of hermes-admin with --ssh-hardening: password (asked on the terminal, or generated and shown once) or nopasswd")
	fs.StringVar(&o.adminPasswordFile, "admin-password-file", "", "0600 file with the sudo password of hermes-admin (--admin-sudo=password without a terminal)")
	fs.BoolVar(&o.yes, "yes", false, "confirm the mutation")
	fs.BoolVar(&o.dryRun, "dry-run", false, "print what up would do, change nothing (same as `plan`)")
	fs.BoolVar(&o.console, "console-confirmed", false, "confirm out-of-band access exists for an access-changing option")
	fs.BoolVar(&o.detach, "detach", false, "return after arming instead of waiting for verify-access")
	fs.BoolVar(&o.sandbox, "sandbox", false, "install the optional rootless Docker sandbox")
	fs.BoolVar(&o.persistentJournal, "persistent-journal", false, "persist systemd journal logs on disk")
	fs.BoolVar(&o.unattendedUpgrades, "unattended-upgrades", false, "configure Debian unattended security upgrades")
	fs.BoolVar(&o.sudoLogging, "sudo-logging", false, "write sudo commands to a root-only rotated log")
	fs.BoolVar(&o.passwordPolicy, "password-policy", false, "configure the HVS PAM password policy")
	fs.BoolVar(&o.disableLLMNR, "disable-llmnr", false, "disable LLMNR through a systemd-resolved drop-in")
	fs.BoolVar(&o.firewall, "firewall", false, "manage the strict HVS UFW policy")
	fs.Var(&o.allowedInbound, "allow-inbound", "inbound UFW rule PORT/tcp or PORT/udp (repeatable; requires --firewall)")
	fs.BoolVar(&o.fail2ban, "fail2ban", false, "install and configure the fail2ban sshd jail")
	fs.BoolVar(&o.sshHardening, "ssh-hardening", false, "create hermes-admin and harden sshd under rollback")
	fs.Var(autoUpgradeFlag{choice: &o.autoUpgrade, on: true}, "auto-upgrade", "enable the timer that installs newer vX.Y.Z releases even if this host declined it before (Linux enables it by default)")
	fs.Var(autoUpgradeFlag{choice: &o.autoUpgrade, on: false}, "no-auto-upgrade", "leave the upgrade timer off and remember the refusal for the next `up`")
	fs.BoolVar(&o.quarantineCloudUser, "quarantine-cloud-user", false, "quarantine the Debian cloud-init account (requires --ssh-hardening)")
	return o
}

func runUp(env cli.Env, args []string) int {
	fs := newFlagSet("up", env)
	o := bindUpFlags(fs)
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if o.dryRun {
		return printPlan(env, o)
	}
	if !o.yes {
		return fail(env, cli.ExitRefused, "up mutates the host; add --yes (nothing was changed)")
	}
	if runtime.GOOS == "darwin" {
		return runMacUp(env, o)
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	previous, err := state.Load()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if err := reconcileRolledBackFeatures(previous, guard.Default(runner)); err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	previousFeatures := state.Features{}
	if previous != nil {
		previousFeatures = previous.Features
	}
	requested := o.requestedFeatures()
	effective := previousFeatures
	effective.Merge(requested)
	selectedChanges := effective.NewComparedTo(previousFeatures)
	newAccessChange := (requested.SSHHardening && !previousFeatures.SSHHardening) ||
		(requested.Firewall && !previousFeatures.Firewall) ||
		(requested.Fail2Ban && !previousFeatures.Fail2Ban) ||
		(requested.QuarantineCloudUser && !previousFeatures.QuarantineCloudUser)
	newPolicyChange := !effective.Equal(previousFeatures)
	if newAccessChange && !o.console {
		return fail(env, cli.ExitRefused, "the selected access policy can lock you out; add --console-confirmed after checking out-of-band access")
	}
	if requested.SSHHardening && !previousFeatures.SSHHardening && o.adminKeyFile == "" {
		return fail(env, cli.ExitRefused, "--admin-key FILE (one ssh-ed25519 public key) is required for SSH hardening")
	}
	newAdmin := requested.SSHHardening && !previousFeatures.SSHHardening
	if o.adminSudo != layout.AdminSudoPassword && o.adminSudo != layout.AdminSudoNoPasswd {
		return fail(env, cli.ExitUsage, "--admin-sudo must be %s or %s", layout.AdminSudoPassword, layout.AdminSudoNoPasswd)
	}
	if o.adminPasswordFile != "" && (!newAdmin || o.adminSudo != layout.AdminSudoPassword) {
		return fail(env, cli.ExitRefused, "--admin-password-file only applies to a new --ssh-hardening with --admin-sudo=%s", layout.AdminSudoPassword)
	}
	if requested.QuarantineCloudUser && !(requested.SSHHardening || previousFeatures.SSHHardening) {
		return fail(env, cli.ExitRefused, "--quarantine-cloud-user requires --ssh-hardening")
	}
	if len(requested.AllowedInbound) > 0 && !(requested.Firewall || previousFeatures.Firewall) {
		return fail(env, cli.ExitRefused, "--allow-inbound requires --firewall")
	}
	if o.detach && !newAccessChange {
		return fail(env, cli.ExitRefused, "--detach only applies to a newly selected access policy")
	}
	if newAdmin && o.adminSudo == layout.AdminSudoPassword {
		// Asked before anything changes: a refusal here leaves the host as it was.
		p, err := adminSudoPassword(o.adminPasswordFile, openAdminTTY)
		if err != nil {
			return fail(env, cli.ExitRefused, "%v", err)
		}
		o.adminPassword = p
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	resumed := false
	if st, _ := state.Load(); st != nil {
		resumed = resumeAfterCommit(st.Phases, guard.Default(runner).State().Finalized)
	}
	pb := term.NewProgressBar(env.Stdout, env.Color, len(phaseTags(effective, resumed, newAccessChange)))
	log := func(format string, a ...any) {
		line := fmt.Sprintf(format, a...)
		if tag, ok := phaseTag(line); ok {
			// The bar is its own redrawn (TTY) or one-line-per-step
			// (non-TTY) rendering; Finish moves past it so the phase's
			// own descriptive line below always starts on a fresh line.
			pb.Step(tag)
			pb.Finish()
			line = colorizePhaseLine(env.Color, line)
		}
		printf(env.Stdout, "  %s", line)
	}
	if err := up(ctx, env, o, effective, selectedChanges, newAccessChange, newPolicyChange, log); err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	return upAutoUpgrade(ctx, env, o.autoUpgrade)
}

func up(ctx context.Context, env cli.Env, o *upOptions, features, selectedChanges state.Features, newAccessChange, newPolicyChange bool, log func(string, ...any)) error {
	a, ok := arch()
	if !ok {
		return errors.New("unsupported architecture")
	}
	facts, err := collectFacts(ctx)
	if err != nil {
		return err
	}
	var protections []string
	if names := features.EnabledNames(); !(len(names) == 1 && names[0] == "minimal") {
		protections = names
	}
	if p := facts.PreflightFor(features.Sandbox, protections); len(p) > 0 {
		return fmt.Errorf("preflight: %s", strings.Join(p, "; "))
	}
	st, err := state.Load()
	if err != nil {
		return err
	}
	if st == nil {
		st = state.New(env.Version)
	}
	if err := reconcileRolledBackFeatures(st, guard.Default(runner)); err != nil {
		return err
	}
	previousFeatures := st.Features
	// A connector-only replay on a host provisioned by an older direct-mode
	// build must retire that public path before the state can claim that the
	// host is connector-only. This is intentionally before selfInstall and
	// the first Save: a partial migration is retried on the next invocation.
	if err := migrateLegacyDirect(ctx, runner, st); err != nil {
		return fmt.Errorf("retire legacy direct exposure: %w", err)
	}
	delete(st.Phases, "expose") // historical name; connector installs record "connect"
	st.Mode = state.ModeConnector
	st.Hostname = ""
	st.PublicIP = facts.PrimaryIP
	st.Features = previousFeatures
	st.SSHHardening = previousFeatures.SSHHardening
	st.DockerEnabled = previousFeatures.Sandbox
	st.ToolVersion = env.Version
	sd := systemd.Client{Runner: runner}
	printf(env.Stdout, "edge-setup up: connector (outbound only) on %s %d (%s)", facts.OSID, facts.OSVersionID, facts.Arch)

	// P0/P1
	log("P1 self-install → %s", layout.ToolInstalledPath)
	if err := selfInstall(); err != nil {
		return err
	}
	if err := st.Save(); err != nil {
		return err
	}
	// P2 base
	log("P2 base packages")
	ap := apt.New(runner)
	if err := ap.Update(ctx); err != nil {
		return err
	}
	if features.PersistentJournal {
		log("P2J optional persistent journal")
		if err := persistentJournal(ctx, sd); err != nil {
			return err
		}
		st.Features.PersistentJournal = true
		_ = st.Save()
	}
	st.MarkPhase("base", "")
	_ = st.Save()
	// P3+P5 runtime (docker unit variant decided now: docker is installed in P4).
	log("P3/P5 Hermes runtime %s (uv %s, Python %s)", pins.HermesVersion, pins.UVVersion, pins.PythonVersion)
	inst := hermes.New(runner, a, features.Sandbox, log)
	rep, err := inst.Run(ctx)
	if err != nil {
		return fmt.Errorf("runtime: %w", err)
	}
	st.PinsApplied["hermes"] = pins.HermesVersion
	st.MarkPhase("runtime", "")
	_ = st.Save()
	uid := rep.UID
	if !features.Sandbox {
		log("P4/P6 optional sandbox not selected: tools run as %s", layout.ServiceUser)
		st.DockerEnabled = false
		if err := sandbox.ApplyContractOnly(ctx, runner, uid, rep.UID); err != nil {
			return fmt.Errorf("toolset contract: %w", err)
		}
	} else {
		// P4 docker
		log("P4 rootless docker for %s", layout.ServiceUser)
		dk := docker.New(runner, a, facts.OSCodename, facts.Virt == "lxc")
		if _, err := dk.Run(ctx); err != nil {
			return fmt.Errorf("docker: %w", err)
		}
		st.DockerEnabled = true
		st.Features.Sandbox = true
		st.MarkPhase("docker", "")
		_ = st.Save()
		// The gateway unit was rendered with docker enabled; restart it now
		// that the rootless socket exists.
		if err := sd.Restart(ctx, layout.GatewayUnit); err != nil {
			return err
		}
		// P6 sandbox
		log("P6 sandbox (docker backend, exact toolsets)")
		sb := sandbox.New(runner, uid, rep.UID, sandbox.Machine{VCPUs: facts.VCPUs, MemTotalMB: facts.MemTotalMB})
		if _, err := sb.Run(ctx); err != nil {
			return fmt.Errorf("sandbox: %w", err)
		}
		st.MarkPhase("sandbox", "")
		_ = st.Save()
	}
	// P7 harden
	hopts := hardening.Options{Features: selectedChanges, Guarded: newAccessChange, QuarantineExpectedKey: st.QuarantineKeyFingerprint, AdminSudo: o.adminSudo, AdminPassword: o.adminPassword}
	if features.SSHHardening && o.adminKeyFile != "" {
		key, err := os.ReadFile(o.adminKeyFile)
		if err != nil {
			return fmt.Errorf("--admin-key: %w", err)
		}
		hopts.AdminPublicKey = strings.TrimSpace(string(key))
	}
	h := hardening.New(runner, log)
	g := guard.Default(runner)
	if resumeAfterCommit(st.Phases, g.State().Finalized) && !newPolicyChange {
		// verify-access committed P7 but a later phase failed (or the
		// operator detached before P8): the hardening transaction is
		// one-shot, so resume at P8 and redo the P9 proofs afterwards.
		log("P7 harden already committed by verify-access; resuming at P8")
		log("P8 connect (outbound only)")
		if err := installConnectorUnit(ctx, log); err != nil {
			return fmt.Errorf("connector: %w", err)
		}
		st.MarkPhase("connect", "")
		_ = st.Save()
		log("P9 finalize (proofs after connector install)")
		if err := h.Finalize(ctx, hardening.Options{Features: features}, st.AdminKeyFingerprint); err != nil {
			return fmt.Errorf("finalize: %w", err)
		}
		if err := strictAudit(ctx, env, st); err != nil {
			return err
		}
		st.MarkPhase("finalize", "")
		_ = st.Save()
		printf(env.Stdout, "done. Next: %s", nextStep())
		return nil
	}
	if !features.HostPolicyEnabled() {
		st.Features = features
		st.SSHHardening = features.SSHHardening
		st.DockerEnabled = features.Sandbox
		_ = st.Save()
		log("P7 optional host policy not selected")
		log("P8 connect (outbound only)")
		if err := installConnectorUnit(ctx, log); err != nil {
			return fmt.Errorf("connector: %w", err)
		}
		st.MarkPhase("connect", "")
		_ = st.Save()
		log("P9 finalize (core audit)")
		if err := strictAudit(ctx, env, st); err != nil {
			return err
		}
		st.MarkPhase("finalize", "")
		_ = st.Save()
		printf(env.Stdout, "done. Next: %s", nextStep())
		return nil
	}
	log("P7 selected host policy")
	prep, err := h.Prepare(ctx, hopts)
	if err != nil {
		return fmt.Errorf("harden/prepare: %w", err)
	}
	if prep.RebootRequired {
		printf(env.Stdout, "Updates applied but a reboot is required before any access change.\nReboot, reconnect, then run the same `up` command again: it resumes here.")
		return nil
	}
	if prep.AdminKeyFingerprint != "" {
		st.AdminUser = layout.AdminUser
		st.AdminKeyFingerprint = prep.AdminKeyFingerprint
		st.AdminSudo = o.adminSudo
	}
	if prep.QuarantineApplies {
		st.QuarantineUser = layout.QuarantineUser
		st.QuarantineKeyFingerprint = prep.QuarantineKeyFingerprint
	}
	_ = st.Save()
	if err := h.Enforce(ctx, hopts); err != nil {
		return fmt.Errorf("harden/enforce: %w", err)
	}
	// Enforce only applies newly selected features; a firewall selected by an
	// older build may lack the loopback guard that Finalize requires.
	if features.Firewall && !selectedChanges.Firewall {
		installed, err := h.EnsureLoopbackGuard(ctx)
		if err != nil {
			return fmt.Errorf("harden/loopback guard: %w", err)
		}
		if installed {
			log("P7 loopback guard installed (missing on this host)")
		}
	}
	st.Features = features
	st.SSHHardening = features.SSHHardening
	st.DockerEnabled = features.Sandbox
	_ = st.Save()
	st.MarkPhase("harden", "")
	_ = st.Save()
	// P8 connector
	log("P8 connect (outbound only)")
	if err := installConnectorUnit(ctx, log); err != nil {
		return fmt.Errorf("connector: %w", err)
	}
	st.MarkPhase("connect", "")
	_ = st.Save()
	if !newAccessChange {
		log("P9 finalize")
		if err := h.Finalize(ctx, hardening.Options{Features: features}, st.AdminKeyFingerprint); err != nil {
			return fmt.Errorf("finalize: %w", err)
		}
		if err := strictAudit(ctx, env, st); err != nil {
			return err
		}
		st.MarkPhase("finalize", "")
		_ = st.Save()
		printf(env.Stdout, "done. Next: %s", nextStep())
		return nil
	}
	printf(env.Stdout, "\nRollback armed for %d s. From ANOTHER SSH session to %s, run:\n\n    edge-setup verify-access\n\nverify-access proves the new session and commits; the timer restores the previous access otherwise.",
		layout.HardeningRollbackDelaySeconds, facts.PrimaryIP)
	if o.detach {
		return nil
	}
	return waitForCommit(ctx, env, g)
}

// reconcileRolledBackFeatures makes the persisted selection describe the
// policies that survived the last access rollback. The rollback itself never
// reads JSON; it records only the selected access features in its root-owned
// marker, and the next `up` consumes that fact before computing deltas.
func reconcileRolledBackFeatures(st *state.File, g *guard.Guard) error {
	if st == nil || !g.State().RolledBack {
		return nil
	}
	kv, err := g.ReadMarker(g.RolledBack())
	if err != nil {
		return fmt.Errorf("rolled-back marker: %w", err)
	}
	features := strings.Split(kv["features"], ",")
	if kv["version"] == "1" || kv["features"] == "" {
		features = []string{"firewall", "fail2ban", "ssh", "quarantine"}
	}
	for _, feature := range features {
		switch feature {
		case "firewall":
			st.Features.Firewall = false
			st.Features.AllowedInbound = nil
		case "fail2ban":
			st.Features.Fail2Ban = false
		case "ssh":
			st.Features.SSHHardening = false
			st.SSHHardening = false
		case "quarantine":
			st.Features.QuarantineCloudUser = false
		}
	}
	return nil
}

func waitForCommit(ctx context.Context, env cli.Env, g *guard.Guard) error {
	deadline := time.Now().Add(time.Duration(layout.HardeningRollbackDelaySeconds+120) * time.Second)
	for time.Now().Before(deadline) {
		s := g.State()
		switch {
		case s.Finalized:
			printf(env.Stdout, "finalized by verify-access. Next: %s", nextStep())
			return nil
		case s.RolledBack:
			return errors.New("the rollback restored the previous access (verify-access did not commit in time); investigate, then run `up` again")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return errors.New("no commit and no rollback marker after the window; inspect " + layout.HardeningStateDir)
}

// strictAudit runs the audit and refuses any FAIL or UNKNOWN.
func strictAudit(ctx context.Context, env cli.Env, st *state.File) error {
	rep, err := audit.New(runner, st).Run(ctx)
	if err != nil {
		return fmt.Errorf("audit: %w", err)
	}
	for _, r := range rep.Results {
		if r.Status != audit.Pass {
			printf(env.Stdout, "  audit [%s] %s: %s", statusLabel(env.Color, r.Status, 0), r.ID, r.Message)
		}
	}
	if !rep.Strict() {
		return fmt.Errorf("strict audit failed; report %s", rep.Path)
	}
	return nil
}

func nextStep() string {
	return "edge-setup link --openedbot https://link.openedbot.app --yes (ticket prompted without echo)"
}

func persistentJournal(ctx context.Context, sd systemd.Client) error {
	if err := fsx.EnsureDir("/var/log/journal", 0o2755, fsx.Root); err != nil {
		return err
	}
	_, err := exec.Must(ctx, runner, exec.Cmd{Path: "/usr/bin/systemd-tmpfiles", Args: []string{"--create", "--prefix", "/var/log/journal"}})
	if err != nil {
		return err
	}
	return sd.Restart(ctx, "systemd-journald")
}

// selfInstall copies the running binary to the canonical path so units
// reference a stable file, and refuses to overwrite a foreign one.
func selfInstall() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(self)
	if err != nil {
		return err
	}
	if cur, err := os.ReadFile(layout.ToolInstalledPath); err == nil && string(cur) == string(data) {
		return ensurePathLink()
	}
	if err := fsx.EnsureDir(layout.ToolInstallDir, 0o755, fsx.Root); err != nil {
		return err
	}
	if err := releaseAdoptedCanonical(layout.ToolInstalledPath, layout.ToolAliasPath); err != nil {
		return err
	}
	if err := fsx.WriteAtomic(layout.ToolInstalledPath, data, 0o755, fsx.Root); err != nil {
		return err
	}
	return ensurePathLink()
}

func installConnectorUnit(ctx context.Context, log func(string, ...any)) error {
	acc := account.New(runner)
	info, err := acc.EnsureSystemUser(ctx, layout.ServiceUser, "/home/"+layout.ServiceUser)
	if err != nil {
		return err
	}
	if err := acc.RequireUnprivileged(ctx, layout.ServiceUser); err != nil {
		return err
	}
	sd := systemd.Client{Runner: runner}
	legacy, err := acc.Get(ctx, layout.LegacyConnectorUser)
	if err != nil {
		return err
	}
	if legacy != nil {
		_ = sd.Stop(ctx, layout.ConnectorUnit)
		if fsx.Exists(layout.ConnectorStateDir) {
			if _, err := exec.Must(ctx, runner, exec.Cmd{Path: "/bin/chown", Args: []string{"-R", fmt.Sprintf("%d:%d", info.UID, info.GID), layout.ConnectorStateDir}}); err != nil {
				return err
			}
		}
	}
	// The metadata deny must not cut the units' own DNS: a resolver inside a
	// denied range (GCE and OCI serve DNS on the metadata address) stays
	// allowed, alone. The same exception goes to the operator unit below.
	resolvers := egress.ResolverAllowFrom(layout.ResolvConf, "connector and operator units", log)
	unit, err := render.ConnectorUnit(info.UID, resolvers)
	if err != nil {
		return err
	}
	// The template behind named instances (hermes-connector@<name>) is
	// installed next to the default unit; `link --name` enables an instance.
	templateUnit, err := render.ConnectorTemplateUnit(info.UID, resolvers)
	if err != nil {
		return err
	}
	for name, text := range map[string]string{layout.ConnectorUnit: unit, layout.ConnectorTemplateUnit: templateUnit} {
		path := "/etc/systemd/system/" + name + ".service"
		if cur, err := os.ReadFile(path); err != nil || string(cur) != text {
			if err := fsx.WriteAtomic(path, []byte(text), 0o644, fsx.Root); err != nil {
				return err
			}
		}
	}
	if err := fsx.EnsureDir(layout.ConnectorDir, 0o700, fsx.Root); err != nil {
		return err
	}
	// A host linked before proof of possession existed gets its device key
	// here (every linked instance), so the units re-rendered above can start
	// after an upgrade.
	if err := ensureDeviceKeys(ctx, runner, log); err != nil {
		return err
	}
	if err := sd.DaemonReload(ctx); err != nil {
		return err
	}
	if err := sd.Enable(ctx, layout.ConnectorUnit); err != nil {
		return err
	}
	if err := installOperatorUnit(ctx, sd, resolvers); err != nil {
		return err
	}
	if legacy != nil {
		if fsx.Exists(layout.ConnectorLink) {
			if err := sd.EnableNow(ctx, layout.ConnectorUnit); err != nil {
				return err
			}
			if active, _ := sd.IsActive(ctx, layout.ConnectorUnit); !active {
				return errors.New("connector account migration did not produce an active service")
			}
		}
		if err := acc.Delete(ctx, layout.LegacyConnectorUser); err != nil {
			return err
		}
		log("migrated connector to the single %s account and removed %s", layout.ServiceUser, layout.LegacyConnectorUser)
	}
	log("connector unit installed; it starts after `link` writes %s", layout.ConnectorLink)
	return nil
}

// installOperatorUnit writes and starts hermes-operator.service, the root
// service behind the provider, profile and read-only usage routes of the
// link (docs/CONNECTOR.md). resolvers are the host's resolvers inside a denied
// range, which the unit keeps allowed (egress.ResolverAllow).
func installOperatorUnit(ctx context.Context, sd systemd.Client, resolvers []netip.Addr) error {
	_, _, err := applyOperatorUnit(ctx, sd, false, resolvers)
	return err
}

// applyOperatorUnit renders hermes-operator.service, enables it and restarts
// it when the unit text changed. With force the operator restarts even when
// the text is identical: the binary behind ExecStart changed (upgrade). It
// reports whether the operator was restarted and which connector units
// (default and named instances) were active and therefore restarted.
func applyOperatorUnit(ctx context.Context, sd systemd.Client, force bool, resolvers []netip.Addr) (operatorRestarted bool, connectorsRestarted []string, err error) {
	// The interpreter program behind the toolset and MCP verbs is written
	// here, from root, because the unit itself cannot: ProtectSystem=strict
	// leaves /usr/local read-only to the service. Without it the operator
	// starts fine but announces neither toolset_management nor mcp_management,
	// and openedbot renders the runtime as read-only.
	if err := operator.InstallProbe(); err != nil {
		return false, nil, err
	}
	unit, err := render.OperatorUnit(resolvers)
	if err != nil {
		return false, nil, err
	}
	path := "/etc/systemd/system/" + layout.OperatorUnit + ".service"
	changed := false
	if cur, err := os.ReadFile(path); err != nil || string(cur) != unit {
		if err := fsx.WriteAtomic(path, []byte(unit), 0o644, fsx.Root); err != nil {
			return false, nil, err
		}
		changed = true
	}
	if err := sd.DaemonReload(ctx); err != nil {
		return false, nil, err
	}
	if err := sd.EnableNow(ctx, layout.OperatorUnit); err != nil {
		return false, nil, err
	}
	if !changed && !force {
		return false, nil, nil
	}
	if err := sd.Restart(ctx, layout.OperatorUnit); err != nil {
		return false, nil, err
	}
	// A link already up said hello before the operator existed (or with the
	// previous binary): reconnect so it announces the current features. Every
	// instance with a link is covered; an inactive one is left alone
	// (try-restart).
	if !fsx.Exists("/etc/systemd/system/" + layout.ConnectorUnit + ".service") {
		return true, nil, nil
	}
	for _, inst := range linkedInstances() {
		active, err := sd.IsActive(ctx, inst.Unit())
		if err != nil {
			return true, connectorsRestarted, err
		}
		if err := sd.TryRestart(ctx, inst.Unit()); err != nil {
			return true, connectorsRestarted, err
		}
		if active {
			connectorsRestarted = append(connectorsRestarted, inst.Unit())
		}
	}
	return true, connectorsRestarted, nil
}

func init() {
	cli.Register(cli.Command{Name: "up", Summary: "Install and connect the runtime; host policies are opt-in", Run: runUp})
	cli.Register(cli.Command{Name: "verify-access", Summary: "Prove fresh SSH access and commit a guarded policy", Run: runVerifyAccess})
	cli.Register(cli.Command{Name: "internal", Summary: "Entry points used by systemd units (rollback-access, connector, operator)", Run: runInternal})
}

func runVerifyAccess(env cli.Env, args []string) int {
	if code := requireRoot(env); code != 0 {
		return code
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	v := access.New(runner)
	proof, err := v.Verify(ctx)
	if err != nil {
		return fail(env, cli.ExitRefused, "verify-access refused (nothing disarmed): %v", err)
	}
	if proof.AdminUser == "" {
		printf(env.Stdout, "proved: fresh SSH access from %s after the selected access policy", proof.RemoteHost)
	} else {
		printf(env.Stdout, "proved: %s logged in with %s from %s after the lockdown, sudo works, sshd refuses passwords and root", proof.AdminUser, proof.AdminKeyFingerprint, proof.RemoteHost)
	}
	res, err := v.Guard.Commit(ctx, proof.AdminUser, proof.AdminKeyFingerprint)
	if err != nil {
		return fail(env, cli.ExitFailure, "commit: %v", err)
	}
	printf(env.Stdout, "hardening %s; rollback timer stopped", res)
	st, _ := state.Load()
	if st == nil {
		return cli.ExitOK
	}
	h := hardening.New(runner, func(f string, a ...any) { printf(env.Stdout, "  "+f, a...) })
	opts := hardening.Options{Features: st.Features}
	fingerprint := proof.AdminKeyFingerprint
	if fingerprint == "" {
		fingerprint = st.AdminKeyFingerprint
	}
	if err := h.Finalize(ctx, opts, fingerprint); err != nil {
		return fail(env, cli.ExitFailure, "finalize proofs failed (hardening is committed; fix and run `edge-setup audit --strict`): %v", err)
	}
	if err := strictAudit(ctx, env, st); err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	st.MarkPhase("finalize", "")
	_ = st.Save()
	printf(env.Stdout, "finalized %s  Next: %s", env.Color.Green("✓"), nextStep())
	return cli.ExitOK
}

func runInternal(env cli.Env, args []string) int {
	if len(args) == 0 {
		return fail(env, cli.ExitUsage, "internal <rollback-access|proxy-rollback|connector|operator>")
	}
	if args[0] == "mac-upgrade-check" || args[0] == "mac-upgrade-apply" {
		ctx, cancel := ctxWithSignals()
		defer cancel()
		return runMacUpgradeInternal(env, args, ctx)
	}
	if runtime.GOOS == "darwin" && args[0] == "operator" {
		if code := prepareConnectorHost(env); code != 0 {
			return code
		}
	} else if internalNeedsRoot(args[0]) {
		if code := requireRoot(env); code != 0 {
			return code
		}
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	switch args[0] {
	case "rollback-access":
		h := hardening.New(runner, nil)
		out, err := h.Rollback(ctx)
		if err != nil {
			return fail(env, cli.ExitFailure, "rollback: %v", err)
		}
		printf(env.Stdout, "%s", out)
		return cli.ExitOK
	case "proxy-rollback":
		out, err := proxy.NewTransaction(runner, nil).Rollback(ctx)
		if err != nil {
			return fail(env, cli.ExitFailure, "proxy-rollback: %v", err)
		}
		printf(env.Stdout, "%s", out)
		return cli.ExitOK
	case "connector":
		// Every connector instance, default or named, starts here: drop
		// dumpability before the daemon reads any credential.
		if err := denyProcessIntrospection(); err != nil {
			return fail(env, cli.ExitRefused, "connector: %v (nothing was started)", err)
		}
		return runConnectorDaemon(env)
	case "operator":
		return runOperatorDaemon(env, ctx)
	}
	return fail(env, cli.ExitUsage, "unknown internal entry point %q", args[0])
}

func internalNeedsRoot(entrypoint string) bool { return entrypoint != "connector" }

// resumeAfterCommit reports whether `up` must skip P7: the harden phase is
// recorded and the guard says verify-access committed it. A finalized guard
// without the phase record (or the reverse) is not a resumable state.
func resumeAfterCommit(phases map[string]state.Phase, finalized bool) bool {
	_, hardened := phases["harden"]
	return hardened && finalized
}
