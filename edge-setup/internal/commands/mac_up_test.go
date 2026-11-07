package commands

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func TestLockMacSetupExclusivityAndSymlinkRefusal(t *testing.T) {
	t.Run("exclusive lock", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "up.lock")
		unlock, err := lockMacSetup(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := lockMacSetup(path); err == nil {
			t.Fatal("concurrent setup lock was acquired")
		}
		unlock()
		unlockAgain, err := lockMacSetup(path)
		if err != nil {
			t.Fatalf("released lock could not be acquired: %v", err)
		}
		unlockAgain()
	})
	t.Run("symlink lock", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(dir, "target")
		if err := os.WriteFile(target, []byte("unmodified"), 0o600); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(dir, "up.lock")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		if _, err := lockMacSetup(link); err == nil {
			t.Fatal("symlinked setup lock was accepted")
		}
		got, err := os.ReadFile(target)
		if err != nil || string(got) != "unmodified" {
			t.Fatal("setup lock target was modified")
		}
	})
}

func TestCopyMacBinaryWritesPrivateFileAndIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	target := filepath.Join(dir, "app", "bin", "edge-setup")
	if err := os.WriteFile(source, []byte("fixture binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	changed, err := copyMacBinary(source, target)
	if err != nil || !changed {
		t.Fatalf("first binary install failed: changed=%v err=%v", changed, err)
	}
	if _, err := fsx.ReadRegular(target, 0o700, fsx.Current()); err != nil {
		t.Fatalf("installed binary is not private and user-owned: %v", err)
	}
	changed, err = copyMacBinary(source, target)
	if err != nil || changed {
		t.Fatalf("identical binary replay was not a no-op: changed=%v err=%v", changed, err)
	}
}

func TestBackupMacRuntimeConfigCopiesPrivateFiles(t *testing.T) {
	home := t.TempDir()
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.RuntimeRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		".env":        "API_SERVER_KEY=private-token-fixture\nPROVIDER_KEY=provider-fixture\n",
		"runtime.env": "API_SERVER_KEY=shadow-token-fixture\n",
		"config.yaml": "private-runtime-config-fixture\n",
	}
	for name, contents := range want {
		writeCommandFixture(t, filepath.Join(paths.RuntimeRoot, name), contents, 0o600)
	}
	if err := backupMacRuntimeConfig(paths); err != nil {
		t.Fatal(err)
	}
	backups, err := filepath.Glob(filepath.Join(paths.AppRoot, "backups", "*"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("expected one timestamped backup directory: count=%d err=%v", len(backups), err)
	}
	for name, contents := range want {
		path := filepath.Join(backups[0], name)
		data, err := fsx.ReadRegular(path, 0o600, fsx.Current())
		if err != nil || string(data) != contents {
			t.Fatalf("backup file %q was not preserved privately", name)
		}
	}
}

func TestValidateMacUpOptionsRefusesLinuxOnlyProvisioningFlags(t *testing.T) {
	if err := validateMacUpOptions(&upOptions{}); err != nil {
		t.Fatalf("default macOS options should be accepted: %v", err)
	}
	cases := []struct {
		name string
		set  func(*upOptions)
	}{
		{name: "sandbox", set: func(o *upOptions) { o.sandbox = true }},
		{name: "persistent journal", set: func(o *upOptions) { o.persistentJournal = true }},
		{name: "host firewall policy", set: func(o *upOptions) { o.firewall = true }},
		{name: "admin key", set: func(o *upOptions) { o.adminKeyFile = "/tmp/admin.pub" }},
		{name: "console confirmation", set: func(o *upOptions) { o.console = true }},
		{name: "detach", set: func(o *upOptions) { o.detach = true }},
		{name: "inbound port", set: func(o *upOptions) { o.allowedInbound = inboundRules{"8443/tcp"} }},
		{name: "auto-upgrade", set: func(o *upOptions) { o.autoUpgrade = autoUpgradeOn }},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			o := &upOptions{}
			tt.set(o)
			if err := validateMacUpOptions(o); err == nil {
				t.Fatal("unsupported provisioning option was accepted")
			}
		})
	}
}

func writeCommandFixture(t *testing.T, path, contents string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := fsx.WriteAtomic(path, []byte(contents), mode, fsx.Current()); err != nil {
		t.Fatal(err)
	}
}

func TestClearLinkRefusalRequiresSuccessfulRemoval(t *testing.T) {
	dir := t.TempDir()
	if err := clearLinkRefusal(dir); err != nil {
		t.Fatal("missing marker should already be clear")
	}
	marker := filepath.Join(dir, linkRefusedMarker)
	writeCommandFixture(t, marker, "refused", 0o600)
	if err := clearLinkRefusal(dir); err != nil {
		t.Fatal("regular refusal marker could not be cleared")
	}
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatal("refusal marker remains after success")
	}
	if err := os.Mkdir(marker, 0o700); err != nil {
		t.Fatal(err)
	}
	writeCommandFixture(t, filepath.Join(marker, "keep"), "untouched", 0o600)
	if err := clearLinkRefusal(dir); err == nil {
		t.Fatal("failed marker removal was reported as success")
	}
	if _, err := os.Stat(filepath.Join(marker, "keep")); err != nil {
		t.Fatal("failed removal altered the blocked marker")
	}
}
