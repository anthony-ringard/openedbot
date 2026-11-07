package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/render"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/term"
)

// The automatic upgrade is a pull decided on the host, by a systemd timer.
// openedbot never triggers it: the link carries no update verb
// (docs/CONNECTOR.md), and the pass installs only a published vX.Y.Z whose
// binary matches its SHA256SUMS over HTTPS. It is the release path of `upgrade`
// with three extra duties: stay away from a busy host, prove the link on the
// new binary, and put the previous binary back when that proof fails.

// Outcomes of one automatic pass, as recorded in layout.AutoUpgradeRecord.
const (
	autoOutcomeUpToDate       = "up_to_date"
	autoOutcomeNotNewer       = "not_newer"
	autoOutcomeHeldBack       = "held_back"
	autoOutcomeDeferred       = "deferred"
	autoOutcomeBlocked        = "blocked"
	autoOutcomeUpgraded       = "upgraded"
	autoOutcomeFailed         = "failed"
	autoOutcomeRolledBack     = "rolled_back"
	autoOutcomeRollbackFailed = "rollback_failed"
)

const (
	// autoUpgradeMaxDeferral bounds how long runs in progress hold a release
	// back: a host that is never idle still gets its upgrade.
	autoUpgradeMaxDeferral = 24 * time.Hour
	// autoUpgradeRunWindow: a run journal written within it whose last event
	// is not terminal is a run in progress.
	autoUpgradeRunWindow = 15 * time.Minute
	// autoUpgradeProofTimeout bounds the wait for every watched link to be
	// admitted again by openedbot on the new binary.
	autoUpgradeProofTimeout = 2 * time.Minute
	// autoUpgradeSettle is how long the admitted links must stay up.
	autoUpgradeSettle = 10 * time.Second
	// autoUpgradeHoldBack is how long a rejected release is left alone. A
	// rejection is not always the release's fault: a full disk for ten
	// seconds, a network cut during the link proof or a systemd timeout are
	// enough to reject a perfectly good binary. Holding it back forever means
	// the host never upgrades again, since the mark was only ever cleared by
	// a successful upgrade. One retry per day keeps a genuinely bad release
	// out of the way while letting an accident heal on its own.
	autoUpgradeHoldBack = 24 * time.Hour
)

// autoUpgradeRecord is what the last automatic pass saw and did. It holds no
// secret: `status` prints it.
type autoUpgradeRecord struct {
	Schema       int    `json:"schema"`
	CheckedAt    string `json:"checked_at"`
	Outcome      string `json:"outcome"`
	Detail       string `json:"detail,omitempty"`
	Installed    string `json:"installed,omitempty"`
	Candidate    string `json:"candidate,omitempty"`
	CandidateSum string `json:"candidate_sha256,omitempty"`
	UpgradedAt   string `json:"upgraded_at,omitempty"`
	// NotNewerSum is a release already judged not newer than the installed
	// binary; FailedSum one that was rolled back. Neither is downloaded again.
	NotNewerSum   string `json:"not_newer_sha256,omitempty"`
	FailedSum     string `json:"failed_sha256,omitempty"`
	FailedVersion string `json:"failed_version,omitempty"`
	// FailedAt is when that rejection happened; after autoUpgradeHoldBack the
	// release is tried once more instead of being held back for good.
	FailedAt string `json:"failed_at,omitempty"`
	// DeferredSince is when runs in progress first held the current release.
	DeferredSince string `json:"deferred_since,omitempty"`
}

func loadAutoUpgradeRecord(path string) autoUpgradeRecord {
	var r autoUpgradeRecord
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &r)
	}
	return r
}

func saveAutoUpgradeRecord(path string, r autoUpgradeRecord) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(path, append(data, '\n'), 0o644, fsx.Current())
}

// watchedLink is a connector instance that was active before the upgrade and
// must be admitted again afterwards.
type watchedLink struct {
	Unit     string
	StateDir string
}

// autoUpgrader is one automatic pass. Every effect is a field so the
// decisions (skip, defer, install, prove, roll back) are tested without a
// host.
type autoUpgrader struct {
	now        func() time.Time
	logf       func(string, ...any)
	recordPath string
	asset      string
	// legacyAsset is the pre-rename asset name: a manifest cut at or
	// before v0.4.0 lists it instead of asset, and the pass must still see a
	// candidate rather than report the release as unpublished. Empty skips
	// the fallback (tests that only care about the canonical name).
	legacyAsset string
	// busy names an active transaction, empty otherwise.
	busy       func() string
	activeRuns func() int
	// manifest returns the verified SHA256SUMS of the latest release and
	// the version (tag) its signature was checked for.
	manifest func(context.Context) (map[string]string, string, error)
	// download fetches the binary of that same signed version.
	download func(ctx context.Context, version string) ([]byte, string, error)
	// installed returns the bytes and version of the installed binary.
	installed func(context.Context) ([]byte, string, error)
	version   func(context.Context, []byte) (string, error)
	// keep stores the binary about to be replaced (layout.ToolPreviousPath).
	keep    func([]byte) error
	install func([]byte) error
	// finish runs `upgrade --finish` in whatever binary is installed now.
	// rollback is set when it re-renders the binary put back.
	finish func(ctx context.Context, previous string, rollback bool) error
	watch  func(context.Context) []watchedLink
	prove  func(ctx context.Context, since time.Time, version string, links []watchedLink) error
}

func (u autoUpgrader) run(ctx context.Context) (int, autoUpgradeRecord) {
	rec := loadAutoUpgradeRecord(u.recordPath)
	rec.Schema = 1
	rec.CheckedAt = u.now().UTC().Format(time.RFC3339)
	rec.Candidate, rec.CandidateSum = "", ""
	done := func(code int, outcome, detail string) (int, autoUpgradeRecord) {
		rec.Outcome, rec.Detail = outcome, detail
		if err := saveAutoUpgradeRecord(u.recordPath, rec); err != nil {
			u.logf("auto-upgrade: record not written: %v", err)
		}
		u.logf("auto-upgrade: %s: %s", outcome, detail)
		return code, rec
	}
	if reason := u.busy(); reason != "" {
		return done(cli.ExitOK, autoOutcomeDeferred, reason)
	}
	sums, signed, err := u.manifest(ctx)
	if err != nil {
		return done(cli.ExitOK, autoOutcomeBlocked, "latest release cannot be read: "+err.Error())
	}
	want := sums[u.asset]
	if want == "" && u.legacyAsset != "" {
		want = sums[u.legacyAsset]
	}
	if want == "" {
		return done(cli.ExitOK, autoOutcomeBlocked, "SHA256SUMS does not list "+u.asset)
	}
	rec.CandidateSum = want
	current, installed, err := u.installed(ctx)
	if err != nil {
		return done(cli.ExitFailure, autoOutcomeFailed, "installed binary: "+err.Error())
	}
	rec.Installed = installed
	if selfupdate.Digest(current) == want {
		rec.DeferredSince = ""
		return done(cli.ExitOK, autoOutcomeUpToDate, "the installed binary is the latest release")
	}
	if want == rec.FailedSum {
		if rec.FailedAt == "" {
			// A record written before hold-backs expired: stamp it now so it
			// expires a day from here instead of never.
			rec.FailedAt = u.now().UTC().Format(time.RFC3339)
		}
		if held, until := holdsBack(rec, u.now()); held {
			return done(cli.ExitOK, autoOutcomeHeldBack, fmt.Sprintf("release %s (sha256 %s) was rolled back on this host; trying it again after %s", rec.FailedVersion, short12(want), until.UTC().Format(time.RFC3339)))
		}
		u.logf("auto-upgrade: %s was rejected more than %s ago; trying it once more", rec.FailedVersion, autoUpgradeHoldBack)
		rec.FailedSum, rec.FailedVersion, rec.FailedAt = "", "", ""
	}
	if want == rec.NotNewerSum {
		return done(cli.ExitOK, autoOutcomeNotNewer, fmt.Sprintf("latest release (sha256 %s) is not newer than %s", short12(want), installed))
	}
	if n := u.activeRuns(); n > 0 {
		if rec.DeferredSince == "" {
			rec.DeferredSince = u.now().UTC().Format(time.RFC3339)
		}
		since, err := time.Parse(time.RFC3339, rec.DeferredSince)
		if err == nil && u.now().Sub(since) < autoUpgradeMaxDeferral {
			return done(cli.ExitOK, autoOutcomeDeferred, fmt.Sprintf("%d run(s) in progress", n))
		}
		u.logf("auto-upgrade: runs still in progress after %s; upgrading anyway", autoUpgradeMaxDeferral)
	}
	rec.DeferredSince = ""
	data, sum, err := u.download(ctx, signed)
	if err != nil {
		return done(cli.ExitOK, autoOutcomeBlocked, "download: "+err.Error())
	}
	rec.CandidateSum = sum
	candidate, err := u.version(ctx, data)
	if err != nil {
		rec.FailedSum, rec.FailedVersion, rec.FailedAt = sum, "unknown", u.now().UTC().Format(time.RFC3339)
		return done(cli.ExitFailure, autoOutcomeFailed, err.Error()+" (nothing was changed)")
	}
	rec.Candidate = candidate
	if candidate != signed {
		// SHA256SUMS signed on one tag never installs a binary that claims
		// another version: held back like a rejected release.
		rec.FailedSum, rec.FailedVersion, rec.FailedAt = sum, candidate, u.now().UTC().Format(time.RFC3339)
		return done(cli.ExitFailure, autoOutcomeFailed, fmt.Sprintf("version mismatch: the binary claims %q but SHA256SUMS is signed for edge-setup/%s (nothing was changed)", candidate, signed))
	}
	if !isStableRelease(candidate) {
		rec.NotNewerSum = sum
		return done(cli.ExitOK, autoOutcomeNotNewer, fmt.Sprintf("candidate %s is not a vX.Y.Z release", candidate))
	}
	order, ok := compareToolVersions(candidate, installed)
	if !ok {
		rec.NotNewerSum = sum
		return done(cli.ExitOK, autoOutcomeNotNewer, fmt.Sprintf("installed %q cannot be ordered against %s: an automatic pass leaves such a build alone", installed, candidate))
	}
	if order <= 0 {
		rec.NotNewerSum = sum
		return done(cli.ExitOK, autoOutcomeNotNewer, fmt.Sprintf("%s is not newer than the installed %s", candidate, installed))
	}
	links := u.watch(ctx)
	if err := u.keep(current); err != nil {
		return done(cli.ExitFailure, autoOutcomeFailed, "previous binary not kept: "+err.Error()+" (nothing was changed)")
	}
	since := u.now()
	if err := u.install(data); err != nil {
		if restore := u.install(current); restore != nil {
			return done(cli.ExitFailure, autoOutcomeRollbackFailed, fmt.Sprintf("install %s: %v; restoring %s: %v", candidate, err, installed, restore))
		}
		return done(cli.ExitFailure, autoOutcomeFailed, fmt.Sprintf("install %s: %v; %s kept", candidate, err, installed))
	}
	err = u.finish(ctx, installed, false)
	if err == nil {
		err = u.prove(ctx, since, candidate, links)
	}
	if err == nil {
		rec.Installed, rec.UpgradedAt = candidate, u.now().UTC().Format(time.RFC3339)
		rec.NotNewerSum, rec.FailedSum, rec.FailedVersion, rec.FailedAt = "", "", "", ""
		return done(cli.ExitOK, autoOutcomeUpgraded, fmt.Sprintf("%s -> %s; %d link(s) admitted again", installed, candidate, len(links)))
	}
	u.logf("auto-upgrade: %s did not prove itself (%v); putting %s back", candidate, err, installed)
	rec.FailedSum, rec.FailedVersion, rec.FailedAt = sum, candidate, u.now().UTC().Format(time.RFC3339)
	restore := u.install(current)
	if restore == nil {
		restore = u.finish(ctx, candidate, true)
	}
	if restore == nil {
		restore = u.prove(ctx, u.now(), installed, links)
	}
	if restore != nil {
		return done(cli.ExitFailure, autoOutcomeRollbackFailed, fmt.Sprintf("%s rejected: %v; rollback to %s failed: %v", candidate, err, installed, restore))
	}
	return done(cli.ExitFailure, autoOutcomeRolledBack, fmt.Sprintf("%s rejected: %v; %s restored and its links admitted again", candidate, err, installed))
}

// holdsBack reports whether a rejected release is still within its hold, and
// when that hold ends. A record written by an older build carries no
// FailedAt: it is held from now, so upgrading the tool cannot silently
// reinstall a release this host already rejected.
func holdsBack(rec autoUpgradeRecord, now time.Time) (bool, time.Time) {
	at, err := time.Parse(time.RFC3339, rec.FailedAt)
	if err != nil {
		return true, now.Add(autoUpgradeHoldBack)
	}
	until := at.Add(autoUpgradeHoldBack)
	return now.Before(until), until
}

func short12(sum string) string {
	if len(sum) > 12 {
		return sum[:12]
	}
	return sum
}

// activeTransaction names a hardening or proxy transaction in progress, empty
// otherwise. The automatic pass stays away from such a host.
func activeTransaction() string {
	if fsx.Exists(guard.Default(runner).Active()) || fsx.Exists(layout.ProxyActive) {
		return "a transaction is active"
	}
	return ""
}

// runsInProgress counts the runs, over every linked connector instance, whose
// journal moved within autoUpgradeRunWindow and does not end on a terminal
// event. The automatic pass defers a release on it.
func runsInProgress(now time.Time) int {
	n := 0
	for _, inst := range linkedInstances() {
		n += connector.ActiveRuns(filepath.Join(stateDirOf(inst), "runs"), now, autoUpgradeRunWindow)
	}
	return n
}

// busyReason says why the host must not be disturbed now, empty when it is
// idle. It is the signal the automatic pass holds itself back on
// (activeTransaction, runsInProgress), kept in one place so that restarting the
// gateway after a unit change and installing a release agree on what idle means.
func busyReason(now time.Time) string {
	if reason := activeTransaction(); reason != "" {
		return reason
	}
	if n := runsInProgress(now); n > 0 {
		return fmt.Sprintf("%d run(s) in progress", n)
	}
	return ""
}

// runAutoUpgrade is `upgrade --auto --yes`, run by hermes-setup-upgrade.service.
func runAutoUpgrade(env cli.Env, releaseURL string) int {
	ctx, cancel := ctxWithSignals()
	defer cancel()
	a, _ := arch()
	rel, relErr := release(releaseURL)
	sd := systemd.Client{Runner: runner}
	running, _, _ := selfupdate.SelfSHA256()
	targets := upgradeTargets(layout.ToolInstalledPath, running, "")
	targets = append(targets, pathCopies(layout.ToolPathCopies, "", targets, fsx.Lstat)...)
	targets = append(targets, promotedCanonicalCopies(layout.ToolPathCopies, layout.ToolLegacyPathCopies, targets, fsx.Lstat)...)
	u := autoUpgrader{
		now:         time.Now,
		logf:        func(f string, args ...any) { printf(env.Stdout, f, args...) },
		recordPath:  layout.AutoUpgradeRecord,
		asset:       selfupdate.AssetName(a.Go),
		legacyAsset: selfupdate.LegacyAssetName(a.Go),
		busy:        activeTransaction,
		activeRuns:  func() int { return runsInProgress(time.Now()) },
		// LATEST is read once: the binary is then fetched from the version
		// whose signature was checked, never from a pointer read again.
		manifest: func(ctx context.Context) (map[string]string, string, error) {
			if relErr != nil {
				return nil, "", relErr
			}
			r, err := rel.Resolve(ctx)
			if err != nil {
				return nil, "", err
			}
			sums, err := r.Manifest(ctx)
			return sums, r.Version, err
		},
		download: func(ctx context.Context, version string) ([]byte, string, error) {
			c, err := releaseCandidate(ctx, releaseURL, version)
			if err == nil && c.version != version {
				err = fmt.Errorf("release %s resolved instead of %s", c.version, version)
			}
			return c.data, c.sum, err
		},
		installed: func(ctx context.Context) ([]byte, string, error) {
			data, err := readCapped(layout.ToolInstalledPath)
			if err != nil {
				return nil, "", err
			}
			return data, installedVersion(ctx, layout.ToolInstalledPath), nil
		},
		version: func(ctx context.Context, data []byte) (string, error) {
			return candidateVersion(ctx, layout.ToolInstallDir, data, fsx.Root)
		},
		keep: func(data []byte) error {
			return fsx.WriteAtomic(layout.ToolPreviousPath, data, 0o755, fsx.Root)
		},
		install: func(data []byte) error {
			if err := releaseAdoptedCanonical(layout.ToolInstalledPath, layout.ToolAliasPath); err != nil {
				return err
			}
			if _, err := selfupdate.Install(data, fsx.Root, targets...); err != nil {
				return err
			}
			return ensureLegacyPathAliases()
		},
		finish: func(ctx context.Context, previous string, rollback bool) error {
			return runInstalledFinish(ctx, env, previous, rollback)
		},
		watch: func(ctx context.Context) []watchedLink { return activeLinks(ctx, sd) },
		prove: func(ctx context.Context, since time.Time, version string, links []watchedLink) error {
			return proveUpgrade(ctx, sd, since, version, links, autoUpgradeProofTimeout, autoUpgradeSettle)
		},
	}
	code, _ := u.run(ctx)
	return code
}

func readCapped(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, selfupdate.MaxBinarySize))
}

// proveUpgrade waits until the operator serves its socket and every watched
// link has been admitted by openedbot after since, announcing version,
// then checks they are still up after settle. An exit code proves nothing:
// the admission marker is written on link.context, which openedbot sends
// only after it accepted the proof of possession.
// activeLinks are the linked connector instances running now: those an
// upgrade must see admitted by openedbot again.
func activeLinks(ctx context.Context, sd systemd.Client) []watchedLink {
	var links []watchedLink
	for _, inst := range linkedInstances() {
		if active, _ := sd.IsActive(ctx, inst.Unit()); active {
			links = append(links, watchedLink{Unit: inst.Unit(), StateDir: stateDirOf(inst)})
		}
	}
	return links
}

func proveUpgrade(ctx context.Context, sd systemd.Client, since time.Time, version string, links []watchedLink, timeout, settle time.Duration) error {
	agent := ""
	if version != "" {
		agent = "edge-setup/" + version
	}
	pending := func() string {
		if active, _ := sd.IsActive(ctx, layout.OperatorUnit); !active {
			return layout.OperatorUnit + ".service is not active"
		}
		if !fsx.Exists(layout.OperatorSocket) {
			return layout.OperatorSocket + " is missing"
		}
		for _, l := range links {
			at, got, ok := linkAdmitted(l.StateDir)
			if !ok || at.Before(since) {
				return l.Unit + ".service was not admitted by openedbot again"
			}
			if agent != "" && !admittedAs(got, agent) {
				return fmt.Sprintf("%s.service was admitted as %s, not %s", l.Unit, got, agent)
			}
		}
		return ""
	}
	deadline := time.Now().Add(timeout)
	for {
		reason := pending()
		if reason == "" {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s within %s", reason, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(settle):
	}
	for _, l := range links {
		if active, _ := sd.IsActive(ctx, l.Unit); !active {
			return fmt.Errorf("%s.service stopped after its admission", l.Unit)
		}
	}
	// The runtime itself: a gateway that runs must still answer /health.
	if active, _ := sd.IsActive(ctx, layout.GatewayUnit); active {
		if err := waitGatewayHealthy(ctx); err != nil {
			return fmt.Errorf("%s does not answer /health: %w", layout.GatewayUnit, err)
		}
	}
	return nil
}

// lockUpgrade serialises a manual upgrade and an automatic pass.
func lockUpgrade(path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, errors.New("another upgrade is running")
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

func autoUpgradeUnitPaths() (service, timer string) {
	base := "/etc/systemd/system/" + layout.AutoUpgradeUnit
	return base + ".service", base + ".timer"
}

// writeAutoUpgradeUnits renders the service and timer and rewrites the files
// that differ. It reloads nothing.
func writeAutoUpgradeUnits() error {
	service, err := render.AutoUpgradeService()
	if err != nil {
		return err
	}
	timer, err := render.AutoUpgradeTimer()
	if err != nil {
		return err
	}
	servicePath, timerPath := autoUpgradeUnitPaths()
	for path, text := range map[string]string{servicePath: service, timerPath: timer} {
		if cur, err := os.ReadFile(path); err == nil && string(cur) == text {
			continue
		}
		if err := fsx.WriteAtomic(path, []byte(text), 0o644, fsx.Root); err != nil {
			return err
		}
	}
	return nil
}

// ---- auto-upgrade enable | disable | status --------------------------------

func runAutoUpgradeCommand(env cli.Env, args []string) int {
	if len(args) == 0 {
		return fail(env, cli.ExitUsage, "auto-upgrade enable --yes | disable --yes | status [--json]")
	}
	switch args[0] {
	case "enable":
		return autoUpgradeEnable(env, args[1:])
	case "disable":
		return autoUpgradeDisable(env, args[1:])
	case "status":
		return autoUpgradeStatus(env, args[1:])
	}
	return fail(env, cli.ExitUsage, "auto-upgrade: unknown action %q (enable, disable, status)", args[0])
}

func autoUpgradeEnable(env cli.Env, args []string) int {
	fs := newFlagSet("auto-upgrade enable", env)
	yes := fs.Bool("yes", false, "confirm the mutation")
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if fs.NArg() != 0 {
		return fail(env, cli.ExitUsage, "auto-upgrade enable takes no positional argument")
	}
	if !*yes {
		return fail(env, cli.ExitRefused, "auto-upgrade enable installs a timer that replaces this binary with newer releases; add --yes (nothing was changed)")
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	return enableAutoUpgrade(ctx, env)
}

// enableAutoUpgrade installs and starts the timer, then reads the latest
// release once so the operator learns now whether a pass can install
// anything. It is `auto-upgrade enable --yes` and `up --auto-upgrade --yes`.
func enableAutoUpgrade(ctx context.Context, env cli.Env) int {
	sd := systemd.Client{Runner: runner}
	if err := writeAutoUpgradeUnits(); err != nil {
		return fail(env, cli.ExitFailure, "auto-upgrade: %v", err)
	}
	if err := sd.DaemonReload(ctx); err != nil {
		return fail(env, cli.ExitFailure, "auto-upgrade: %v", err)
	}
	if err := sd.EnableNow(ctx, layout.AutoUpgradeUnit+".timer"); err != nil {
		return fail(env, cli.ExitFailure, "auto-upgrade: %v", err)
	}
	if err := forgetAutoUpgradeRefusal(layout.AutoUpgradeDeclined); err != nil {
		return fail(env, cli.ExitFailure, "auto-upgrade: the timer is enabled, but the earlier refusal could not be cleared: %v", err)
	}
	printf(env.Stdout, "auto-upgrade %s %s.timer enabled: every 6 h (random delay up to 1 h), vX.Y.Z releases newer than this one", env.Color.Green("✓"), layout.AutoUpgradeUnit)
	rel, err := release("")
	if err == nil {
		checkCtx, cancelCheck := context.WithTimeout(ctx, 30*time.Second)
		_, err = rel.Manifest(checkCtx)
		cancelCheck()
	}
	if err != nil {
		printf(env.Stdout, "auto-upgrade %s the latest release cannot be read yet (%v): each pass installs nothing until it can", env.Color.Yellow("!"), err)
	} else {
		printf(env.Stdout, "auto-upgrade %s the latest release publishes its SHA256SUMS", env.Color.Green("✓"))
	}
	return cli.ExitOK
}

func autoUpgradeDisable(env cli.Env, args []string) int {
	fs := newFlagSet("auto-upgrade disable", env)
	yes := fs.Bool("yes", false, "confirm the mutation")
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if fs.NArg() != 0 {
		return fail(env, cli.ExitUsage, "auto-upgrade disable takes no positional argument")
	}
	if !*yes {
		return fail(env, cli.ExitRefused, "auto-upgrade disable removes the upgrade timer; add --yes (nothing was changed)")
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	sd := systemd.Client{Runner: runner}
	servicePath, timerPath := autoUpgradeUnitPaths()
	if fsx.Exists(timerPath) {
		if err := sd.Disable(ctx, layout.AutoUpgradeUnit+".timer"); err != nil {
			return fail(env, cli.ExitFailure, "auto-upgrade: %v", err)
		}
		if err := sd.Stop(ctx, layout.AutoUpgradeUnit+".timer"); err != nil {
			return fail(env, cli.ExitFailure, "auto-upgrade: %v", err)
		}
	}
	for _, path := range []string{timerPath, servicePath} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fail(env, cli.ExitFailure, "auto-upgrade: %v", err)
		}
	}
	if err := sd.DaemonReload(ctx); err != nil {
		return fail(env, cli.ExitFailure, "auto-upgrade: %v", err)
	}
	if err := declineAutoUpgrade(layout.AutoUpgradeDeclined, time.Now()); err != nil {
		return fail(env, cli.ExitFailure, "auto-upgrade: the timer is removed, but the refusal could not be recorded (the next `up` would enable it again): %v", err)
	}
	printf(env.Stdout, "auto-upgrade %s disabled, and the next `up` keeps it off; `sudo edge-setup upgrade --yes` stays available", env.Color.Green("✓"))
	return cli.ExitOK
}

// autoUpgradeSummary is the auto-upgrade entry of `status` and
// `auto-upgrade status`.
type autoUpgradeSummary struct {
	Enabled bool              `json:"enabled"`
	NextRun string            `json:"next_run,omitempty"`
	Last    autoUpgradeRecord `json:"last"`
}

func readAutoUpgradeSummary(ctx context.Context, sd systemd.Client) autoUpgradeSummary {
	s := autoUpgradeSummary{Last: loadAutoUpgradeRecord(layout.AutoUpgradeRecord)}
	if _, timerPath := autoUpgradeUnitPaths(); fsx.Exists(timerPath) {
		s.Enabled, _ = sd.IsEnabled(ctx, layout.AutoUpgradeUnit+".timer")
		if next, err := sd.Show(ctx, layout.AutoUpgradeUnit+".timer", "NextElapseUSecRealtime"); err == nil && next != "" && next != "n/a" {
			s.NextRun = next
		}
	}
	return s
}

func autoUpgradeStatusLine(c term.Color, s autoUpgradeSummary) string {
	enabled := c.Red("false")
	if s.Enabled {
		enabled = c.Green("true")
	}
	line := "auto-upgrade enabled=" + enabled
	if s.NextRun != "" {
		line += " next=" + strings.ReplaceAll(s.NextRun, " ", "_")
	}
	if s.Last.Outcome == "" {
		return line + " last=never"
	}
	outcome := s.Last.Outcome
	switch outcome {
	case autoOutcomeRollbackFailed:
		outcome = c.Red(outcome)
	case autoOutcomeRolledBack, autoOutcomeFailed:
		outcome = c.Yellow(outcome)
	}
	line += " last=" + outcome + " at=" + s.Last.CheckedAt
	if s.Last.Detail != "" {
		line += " (" + s.Last.Detail + ")"
	}
	return line
}

func autoUpgradeStatus(env cli.Env, args []string) int {
	fs := newFlagSet("auto-upgrade status", env)
	asJSON := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	s := readAutoUpgradeSummary(ctx, systemd.Client{Runner: runner})
	if *asJSON {
		b, _ := json.MarshalIndent(s, "", "  ")
		printf(env.Stdout, "%s", b)
		return cli.ExitOK
	}
	printf(env.Stdout, "%s", autoUpgradeStatusLine(env.Color, s))
	return cli.ExitOK
}

// autoUpgradeDoctor is doctor's reading of the last pass: a rollback that
// failed is a problem; a rolled back or failed pass is a warning, and so is
// every later pass that holds the rejected release back.
func autoUpgradeDoctor(r autoUpgradeRecord) (problem, warning string) {
	switch r.Outcome {
	case autoOutcomeRollbackFailed:
		return fmt.Sprintf("automatic upgrade at %s could not restore the previous binary: %s. Run `hermes-setup upgrade --yes` (or reinstall %s) and check the link", r.CheckedAt, r.Detail, layout.ToolPreviousPath), ""
	case autoOutcomeRolledBack, autoOutcomeFailed, autoOutcomeHeldBack:
		return "", fmt.Sprintf("automatic upgrade at %s: %s", r.CheckedAt, r.Detail)
	}
	return "", ""
}

// autoUpgradeEnableCommand is the command doctor, `up` and `link` name when
// the timer is off. Enabling it stays the operator's choice: nothing here
// turns it on without that command or `up --auto-upgrade --yes`.
const autoUpgradeEnableCommand = "sudo edge-setup auto-upgrade enable --yes"

// autoUpgradeOffWarning is empty once the timer is enabled; otherwise it says
// that this host keeps its release until someone upgrades it, and how to
// change that.
func autoUpgradeOffWarning(s autoUpgradeSummary) string {
	if s.Enabled {
		return ""
	}
	return "auto-upgrade is disabled: this host keeps its current release until someone runs `sudo edge-setup upgrade --yes`; to install newer releases automatically (every 6 h, link proven, rollback on failure), run `" + autoUpgradeEnableCommand + "`"
}

// printAutoUpgradeHint ends a successful `up` or `link` with that warning. It
// reads systemd on a fresh short context: the caller's may be spent, and a
// failed read must not pass for a disabled timer more than it already does.
func printAutoUpgradeHint(env cli.Env) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if w := autoUpgradeOffWarning(readAutoUpgradeSummary(ctx, systemd.Client{Runner: runner})); w != "" {
		printf(env.Stdout, "hint %s %s", env.Color.Yellow("!"), w)
	}
}

func init() {
	cli.Register(cli.Command{Name: "auto-upgrade", Summary: "Enable, disable or read the timer that installs newer releases (signature and SHA-256 checked)", Run: runAutoUpgradeCommand})
}
