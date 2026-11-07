package commands

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func parseUpFlags(t *testing.T, args ...string) (*upOptions, error) {
	t.Helper()
	fs := flag.NewFlagSet("up", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	o := bindUpFlags(fs)
	return o, fs.Parse(args)
}

// No flag leaves the decision to the host; each flag pins it; saying both
// ways is a usage error rather than a silent last-one-wins.
func TestUpAutoUpgradeFlags(t *testing.T) {
	cases := []struct {
		args []string
		want autoUpgradeChoice
	}{
		{nil, autoUpgradeDefault},
		{[]string{"--auto-upgrade"}, autoUpgradeOn},
		{[]string{"--no-auto-upgrade"}, autoUpgradeOff},
		{[]string{"--auto-upgrade=false"}, autoUpgradeOff},
		{[]string{"--no-auto-upgrade=false"}, autoUpgradeOn},
		{[]string{"--auto-upgrade", "--auto-upgrade"}, autoUpgradeOn},
	}
	for _, tt := range cases {
		o, err := parseUpFlags(t, tt.args...)
		if err != nil {
			t.Fatalf("%v: %v", tt.args, err)
		}
		if o.autoUpgrade != tt.want {
			t.Fatalf("%v: got %d, want %d", tt.args, o.autoUpgrade, tt.want)
		}
	}
	if _, err := parseUpFlags(t, "--auto-upgrade", "--no-auto-upgrade"); err == nil {
		t.Fatal("contradicting flags were accepted")
	}
	if _, err := parseUpFlags(t, "--auto-upgrade=maybe"); err == nil {
		t.Fatal("a non-boolean value was accepted")
	}
}

// macOS has no timer: the default and the refusal are accepted, only an
// explicit request is refused.
func TestValidateMacUpOptionsOnlyRefusesAnExplicitAutoUpgrade(t *testing.T) {
	for _, choice := range []autoUpgradeChoice{autoUpgradeDefault, autoUpgradeOff} {
		if err := validateMacUpOptions(&upOptions{autoUpgrade: choice}); err != nil {
			t.Fatalf("choice %d refused on macOS: %v", choice, err)
		}
	}
	if err := validateMacUpOptions(&upOptions{autoUpgrade: autoUpgradeOn}); err == nil {
		t.Fatal("an explicit --auto-upgrade was accepted on macOS")
	}
}

func TestAutoUpgradeDeclined(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "auto-upgrade.declined")
	record := filepath.Join(dir, "auto-upgrade.json")
	timer := filepath.Join(dir, "hermes-setup-upgrade.timer")
	touch := func(path string) {
		t.Helper()
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if declined, _ := autoUpgradeDeclined(marker, record, timer); declined {
		t.Fatal("a fresh host counts as declined")
	}
	// Enabled and passes recorded: not a refusal.
	touch(record)
	touch(timer)
	if declined, _ := autoUpgradeDeclined(marker, record, timer); declined {
		t.Fatal("an enabled host counts as declined")
	}
	// Disabled before the marker existed: passes recorded, timer gone.
	if err := os.Remove(timer); err != nil {
		t.Fatal(err)
	}
	if declined, why := autoUpgradeDeclined(marker, record, timer); !declined || !strings.Contains(why, "disabled earlier") {
		t.Fatalf("a host that removed its timer is not seen as declined: %v %q", declined, why)
	}
	// The marker wins, and survives a record that was never written.
	if err := os.Remove(record); err != nil {
		t.Fatal(err)
	}
	if err := declineAutoUpgrade(marker, time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if body, _ := os.ReadFile(marker); string(body) != "declined_at=2026-11-07T12:00:00Z\n" {
		t.Fatalf("marker body: %q", body)
	}
	if declined, why := autoUpgradeDeclined(marker, record, timer); !declined || !strings.Contains(why, "declined earlier") {
		t.Fatalf("the marker is ignored: %v %q", declined, why)
	}
	// Enabling on purpose forgets it, twice without error.
	for i := 0; i < 2; i++ {
		if err := forgetAutoUpgradeRefusal(marker); err != nil {
			t.Fatal(err)
		}
	}
	if declined, _ := autoUpgradeDeclined(marker, record, timer); declined {
		t.Fatal("the refusal survived an explicit enable")
	}
}
