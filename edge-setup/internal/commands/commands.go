// Package commands implements the edge-setup subcommands on top of the
// phase packages. Each command parses its own flags, checks its gates and
// mutates nothing before the gates pass.
package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/audit"
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hostfacts"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/term"
)

// runner is the host runner; tests may swap it.
var runner exec.Runner = exec.Host{}

func ctxWithSignals() (context.Context, func()) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

func printf(w io.Writer, format string, args ...any) {
	fmt.Fprintf(w, format+"\n", args...)
}

func fail(env cli.Env, code int, format string, args ...any) int {
	fmt.Fprintf(env.Stderr, "edge-setup: "+format+"\n", args...)
	return code
}

// statusLabel colours an audit status without changing its width: PASS
// green, WARN yellow, FAIL red, UNKNOWN dim. padWidth mirrors the field
// width the caller printed with before colouring landed, so the output is
// byte-identical to the pre-colour one when c is disabled.
func statusLabel(c term.Color, s audit.Status, padWidth int) string {
	padded := fmt.Sprintf("%-*s", padWidth, string(s))
	switch s {
	case audit.Pass:
		return c.Green(padded)
	case audit.Warn:
		return c.Yellow(padded)
	case audit.Fail:
		return c.Red(padded)
	default:
		return c.Dim(padded)
	}
}

// boolLabel colours a status boolean: true green, false red.
func boolLabel(c term.Color, b bool) string {
	if b {
		return c.Green(fmt.Sprintf("%v", b))
	}
	return c.Red(fmt.Sprintf("%v", b))
}

func requireRoot(env cli.Env) int {
	if os.Geteuid() != 0 {
		return fail(env, cli.ExitPrivilege, "this command must run as root (sudo edge-setup …)")
	}
	return 0
}

func newFlagSet(name string, env cli.Env) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(env.Stderr)
	return fs
}

func arch() (pins.Arch, bool) {
	a, ok := pins.Arches[runtime.GOARCH]
	return a, ok
}

func collectFacts(ctx context.Context) (hostfacts.Facts, error) {
	return hostfacts.Default(runner).Collect(ctx)
}

// ---- detect ----------------------------------------------------------------

func runDetect(env cli.Env, args []string) int {
	fs := newFlagSet("detect", env)
	asJSON := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if runtime.GOOS == "darwin" {
		return runMacDetect(env, *asJSON)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	facts, err := collectFacts(ctx)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if *asJSON {
		out := map[string]any{"facts": facts, "mode": "connector", "preflight": facts.Preflight()}
		b, _ := json.MarshalIndent(out, "", "  ")
		printf(env.Stdout, "%s", b)
		return cli.ExitOK
	}
	printf(env.Stdout, "host        %s %d (%s) %s virt=%s cgroupv2=%v", facts.OSID, facts.OSVersionID, facts.OSCodename, facts.Arch, facts.Virt, facts.CgroupV2)
	printf(env.Stdout, "address     %s (global=%v)", facts.PrimaryIP, facts.PrimaryIPIsGlobal)
	printf(env.Stdout, "resources   %d vCPU, %d MB", facts.VCPUs, facts.MemTotalMB)
	printf(env.Stdout, "session     ssh=%v client=%s", facts.SSHSession, facts.SSHClient)
	printf(env.Stdout, "reachability connector (outbound only)")
	if p := facts.Preflight(); len(p) > 0 {
		for _, x := range p {
			printf(env.Stdout, "preflight   %s %s", env.Color.Red("✗"), x)
		}
		return cli.ExitFailure
	}
	printf(env.Stdout, "preflight   %s ready", env.Color.Green("✓"))
	return cli.ExitOK
}

// ---- status ----------------------------------------------------------------

func runStatus(env cli.Env, args []string) int {
	fs := newFlagSet("status", env)
	asJSON := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if runtime.GOOS == "darwin" {
		return runMacStatus(env, *asJSON)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	st, err := state.Load()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	g := guard.Default(runner)
	sd := systemd.Client{Runner: runner}
	timer, _ := sd.TimerIsWaiting(ctx, g.Timer())
	gatewayActive, _ := sd.IsActive(ctx, layout.GatewayUnit)
	// connectors[0] is always the default instance; connector_active and
	// link_present keep describing it for callers of the previous JSON.
	connectors := connectorStatus(ctx, sd)
	autoUpgrade := readAutoUpgradeSummary(ctx, sd)
	summary := map[string]any{
		"auto_upgrade":     autoUpgrade,
		"configured":       st != nil,
		"hardening":        g.State(),
		"rollback_timer":   timer,
		"gateway_active":   gatewayActive,
		"connector_active": connectors[0].Active,
		"link_present":     connectors[0].Link,
		"connectors":       connectors,
	}
	if st != nil {
		summary["state"] = st
	}
	if *asJSON {
		b, _ := json.MarshalIndent(summary, "", "  ")
		printf(env.Stdout, "%s", b)
		return cli.ExitOK
	}
	if st == nil {
		printf(env.Stdout, "state       none (%s absent)", layout.ToolConfig)
	} else {
		printf(env.Stdout, "state       reachability=connector features=%s tool=%s", strings.Join(st.Features.EnabledNames(), ","), st.ToolVersion)
		for name, p := range st.Phases {
			printf(env.Stdout, "phase       %-10s %s", name, p.DoneAt.Format(time.RFC3339))
		}
	}
	hs := g.State()
	printf(env.Stdout, "hardening   active=%s finalized=%s rolled_back=%s awaiting_reboot=%s timer_waiting=%s",
		boolLabel(env.Color, hs.Active), boolLabel(env.Color, hs.Finalized), boolLabel(env.Color, hs.RolledBack), boolLabel(env.Color, hs.AwaitingReboot), boolLabel(env.Color, timer))
	printf(env.Stdout, "gateway     active=%s", boolLabel(env.Color, gatewayActive))
	for _, c := range connectors {
		printf(env.Stdout, "%s", connectorStatusLine(env.Color, c))
	}
	printf(env.Stdout, "%s", autoUpgradeStatusLine(env.Color, autoUpgrade))
	return cli.ExitOK
}

// ---- plan ------------------------------------------------------------------

func runPlan(env cli.Env, args []string) int {
	fs := newFlagSet("plan", env)
	o := bindUpFlags(fs)
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	return printPlan(env, o)
}

// printPlan is `plan`, and `up --dry-run`: what `up` would do with these
// options, read from the host and the state, without writing anything.
func printPlan(env cli.Env, o *upOptions) int {
	if runtime.GOOS == "darwin" {
		return runMacPlan(env, o)
	}
	st, err := state.Load()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	features := state.Features{}
	if st != nil {
		features = st.Features
	}
	features.Merge(o.requestedFeatures())
	ctx, cancel := ctxWithSignals()
	defer cancel()
	facts, err := collectFacts(ctx)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	for _, line := range planLines(features, facts) {
		printf(env.Stdout, "%s", colorizePhaseLine(env.Color, line))
	}
	printf(env.Stdout, "%s", autoUpgradePlanLine(o.autoUpgrade))
	return cli.ExitOK
}

// phaseTagPattern matches the leading phase marker of a plan/up line: "P0"
// through "P9", or a combined marker like "P3/P5" (runtime installs across
// what used to be two phases) or "P4/P6" (the optional-sandbox skip line).
var phaseTagPattern = regexp.MustCompile(`^P[0-9](/P[0-9])?`)

// phaseTag returns the leading phase marker of line and whether it has one;
// a marker only counts when followed by a space, so "P9000" is not mistaken
// for phase 9.
func phaseTag(line string) (string, bool) {
	m := phaseTagPattern.FindString(line)
	if m == "" || len(line) == len(m) || line[len(m)] != ' ' {
		return "", false
	}
	return m, true
}

// colorizePhaseLine highlights a leading phase tag ("P0".."P9", "P3/P5", …)
// in cyan bold, leaving every other line (mode, host, writes) untouched. It
// never changes the text, only wraps it, so output is byte-identical to
// before when color is disabled.
func colorizePhaseLine(c term.Color, line string) string {
	tag, ok := phaseTag(line)
	if !ok {
		return line
	}
	return c.Bold(c.Cyan(tag)) + line[len(tag):]
}

// phaseTags lists, in order, the phase markers `up` logs for the given
// options and resume state. It mirrors the branches of up() in up.go
// exactly (see the comment there) so the progress bar's total matches what
// actually gets logged, whether or not this run reaches P9 itself.
func phaseTags(features state.Features, resumed, newAccessChange bool) []string {
	tags := []string{"P1", "P2", "P3/P5"}
	if features.PersistentJournal {
		tags = append(tags, "P2")
	}
	if !features.Sandbox {
		tags = append(tags, "P4/P6")
	} else {
		tags = append(tags, "P4", "P6")
	}
	tags = append(tags, "P7", "P8")
	if resumed || !newAccessChange {
		// A non-resumed run with a newly selected access policy prints the
		// rollback-armed message and returns (or waits for verify-access) instead of
		// finalizing: P9 runs later, in a separate `verify-access` call.
		tags = append(tags, "P9")
	}
	return tags
}

func planLines(features state.Features, facts hostfacts.Facts) []string {
	lines := []string{
		"reachability connector (outbound only)",
		fmt.Sprintf("host        %s %d %s, %s", facts.OSID, facts.OSVersionID, facts.OSCodename, facts.Arch),
		"P0 preflight   Debian 12+ or Ubuntu 24.04+, systemd, supported architecture; opt-in protections need Debian 13; cgroup v2 only with --sandbox",
		"P1 selfinstall copy to " + layout.ToolInstalledPath,
		"P2 base        runtime packages only; no global host policy",
		fmt.Sprintf("P3 account     uid %s (nologin, no sudo/docker), %s", layout.ServiceUser, layout.RuntimeRoot),
		fmt.Sprintf("P5 runtime     Hermes %s @ %s, uv %s, Python %s, gateway 127.0.0.1:%d", pins.HermesVersion, pins.HermesInstallerCommit[:12], pins.UVVersion, pins.PythonVersion, layout.GatewayPort),
	}
	if features.PersistentJournal {
		lines = append(lines, "P2 optional    persistent journald selected")
	}
	if features.Sandbox {
		lines = append(lines, "P4/P6 optional rootless Docker sandbox selected; cgroup limits and loopback isolation proven")
	} else {
		lines = append(lines, "P4/P6 optional sandbox disabled; tools run as hermes under the gateway unit")
	}
	lines = append(lines, "P7 policy      "+strings.Join(features.EnabledPolicyNames(), ", "))
	lines = append(lines, "P8 connect     connector unit installed (starts after `link`), no inbound port")
	lines = append(lines, "P9 finalize    core plus selected-policy proofs, audit --strict; unselected checks are SKIP")
	lines = append(lines, "writes        "+layout.ToolConfig+" (no secret)")
	return lines
}

// ---- doctor ----------------------------------------------------------------

func runDoctor(env cli.Env, args []string) int {
	if runtime.GOOS == "darwin" {
		return runMacDoctor(env, args)
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	problems, warnings := doctor(ctx)
	for _, w := range warnings {
		printf(env.Stdout, "doctor %s %s", env.Color.Yellow("!"), w)
	}
	if len(problems) == 0 {
		printf(env.Stdout, "doctor %s gateway active, loopback-only, refuses anonymous calls, gateway.multiplex_profiles = true, exact toolset catalogue", env.Color.Green("✓"))
		return cli.ExitOK
	}
	for _, p := range problems {
		printf(env.Stdout, "doctor %s %s", env.Color.Red("✗"), p)
	}
	return cli.ExitFailure
}

func init() {
	cli.Register(cli.Command{Name: "detect", Summary: "Report host facts and connector-only readiness", ReadOnly: true, Run: runDetect})
	cli.Register(cli.Command{Name: "status", Summary: "Phases, hardening markers and installed versions", ReadOnly: true, Run: runStatus})
	cli.Register(cli.Command{Name: "plan", Summary: "Print exactly what `up` would do; writes nothing", ReadOnly: true, Run: runPlan})
	cli.Register(cli.Command{Name: "doctor", Summary: "Check the running runtime end to end", ReadOnly: true, Run: runDoctor})
}
