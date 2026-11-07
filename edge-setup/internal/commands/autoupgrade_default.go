package commands

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// A Linux `up` enables the automatic upgrade unless the owner declined it.
// The refusal is durable: `--no-auto-upgrade` or `auto-upgrade disable`
// leave layout.AutoUpgradeDeclined behind, and every later `up` respects it
// until `auto-upgrade enable` or `up --auto-upgrade` is run on purpose. A
// host that disabled the timer before the marker existed is recognised by
// its record of past passes with no timer left.

// autoUpgradeChoice is what the `up` command line says about the timer.
type autoUpgradeChoice int

const (
	// autoUpgradeDefault: no flag; enable unless declined on this host.
	autoUpgradeDefault autoUpgradeChoice = iota
	// autoUpgradeOn: `--auto-upgrade`; enable, and forget an earlier refusal.
	autoUpgradeOn
	// autoUpgradeOff: `--no-auto-upgrade`; leave it off and remember it.
	autoUpgradeOff
)

// autoUpgradeFlag is `--auto-upgrade` (on=true) or `--no-auto-upgrade`
// (on=false). Both write the same choice; saying both ways is refused rather
// than letting the last one win silently.
type autoUpgradeFlag struct {
	choice *autoUpgradeChoice
	on     bool
}

func (f autoUpgradeFlag) IsBoolFlag() bool { return true }

func (f autoUpgradeFlag) String() string {
	if f.choice == nil {
		return "false"
	}
	if f.on {
		return strconv.FormatBool(*f.choice == autoUpgradeOn)
	}
	return strconv.FormatBool(*f.choice == autoUpgradeOff)
}

func (f autoUpgradeFlag) Set(value string) error {
	v, err := strconv.ParseBool(value)
	if err != nil {
		return errors.New("must be true or false")
	}
	next := autoUpgradeOff
	if v == f.on {
		next = autoUpgradeOn
	}
	if *f.choice != autoUpgradeDefault && *f.choice != next {
		return errors.New("--auto-upgrade and --no-auto-upgrade contradict each other")
	}
	*f.choice = next
	return nil
}

// autoUpgradeDeclined says whether this host refused the automatic upgrade,
// and why. It only reads files.
func autoUpgradeDeclined(markerPath, recordPath, timerPath string) (bool, string) {
	if fsx.Exists(markerPath) {
		return true, "declined earlier (`auto-upgrade disable` or `up --no-auto-upgrade`)"
	}
	if fsx.Exists(recordPath) && !fsx.Exists(timerPath) {
		return true, "disabled earlier (past passes are recorded but the timer was removed)"
	}
	return false, ""
}

func hostDeclinedAutoUpgrade() (bool, string) {
	_, timerPath := autoUpgradeUnitPaths()
	return autoUpgradeDeclined(layout.AutoUpgradeDeclined, layout.AutoUpgradeRecord, timerPath)
}

// declineAutoUpgrade remembers the refusal for the next `up`.
func declineAutoUpgrade(path string, now time.Time) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	body := fmt.Sprintf("declined_at=%s\n", now.UTC().Format(time.RFC3339))
	return fsx.WriteAtomic(path, []byte(body), 0o644, fsx.Current())
}

// forgetAutoUpgradeRefusal is the opposite, once the timer is enabled on purpose.
func forgetAutoUpgradeRefusal(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// upAutoUpgrade ends a successful Linux `up`: it enables the timer unless
// the owner declined it, now or earlier.
func upAutoUpgrade(ctx context.Context, env cli.Env, choice autoUpgradeChoice) int {
	switch choice {
	case autoUpgradeOn:
		return enableAutoUpgrade(ctx, env)
	case autoUpgradeOff:
		if err := declineAutoUpgrade(layout.AutoUpgradeDeclined, time.Now()); err != nil {
			return fail(env, cli.ExitFailure, "auto-upgrade: the host is set up, but the refusal could not be recorded: %v", err)
		}
		if _, timerPath := autoUpgradeUnitPaths(); fsx.Exists(timerPath) {
			printf(env.Stdout, "auto-upgrade %s the timer is still installed; `sudo edge-setup auto-upgrade disable --yes` removes it", env.Color.Yellow("!"))
			return cli.ExitOK
		}
		printf(env.Stdout, "auto-upgrade - left off (--no-auto-upgrade), remembered for the next `up`")
		printAutoUpgradeHint(env)
		return cli.ExitOK
	}
	if declined, why := hostDeclinedAutoUpgrade(); declined {
		printf(env.Stdout, "auto-upgrade - left off: %s", why)
		printAutoUpgradeHint(env)
		return cli.ExitOK
	}
	return enableAutoUpgrade(ctx, env)
}

// autoUpgradePlanLine is what `plan` says `up` would do with the timer.
func autoUpgradePlanLine(choice autoUpgradeChoice) string {
	switch choice {
	case autoUpgradeOn:
		return "auto-upgrade  enable the timer (every 6 h, newer vX.Y.Z only, link proven, rollback on failure)"
	case autoUpgradeOff:
		return "auto-upgrade  left off (--no-auto-upgrade), remembered for the next `up`"
	}
	if declined, why := hostDeclinedAutoUpgrade(); declined {
		return "auto-upgrade  left off: " + why + "; `up --auto-upgrade` enables it"
	}
	return "auto-upgrade  enable the timer (default; --no-auto-upgrade declines it)"
}
