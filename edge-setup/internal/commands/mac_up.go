package commands

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

func macService(p layout.MacRuntimePaths, home string, kind launchd.Kind) (*launchd.Client, error) {
	binary := p.ExecutablePath
	if kind == launchd.Gateway {
		binary = filepath.Join(p.VenvBin, "python")
	}
	return launchd.New(launchd.Config{Runner: runner, LaunchctlPath: "/bin/launchctl", UID: os.Geteuid(), HomeDir: home,
		ExecutablePath: binary, CredentialsDirectory: p.ConnectorRoot, StateDirectory: p.StateRoot, Kind: kind, RuntimeRoot: p.RuntimeRoot, VenvBin: p.VenvBin, NodeBin: p.NodeBin})
}

func validateMacUpOptions(o *upOptions) error {
	if o.sandbox || o.persistentJournal || o.requestedFeatures().HostPolicyEnabled() || o.adminKeyFile != "" || o.console || o.detach || len(o.allowedInbound) > 0 {
		return errors.New("the Linux host-policy and rootless-Docker provisioning flags are unavailable on macOS; no policy was applied")
	}
	if o.autoUpgrade == autoUpgradeOn {
		return errors.New("--auto-upgrade: auto-upgrade is unavailable on macOS; nothing was applied")
	}
	return nil
}

func runMacUp(env cli.Env, o *upOptions) int {
	if err := validateMacUpOptions(o); err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	if code := prepareConnectorHost(env); code != 0 {
		return code
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	p, err := layout.MacRuntime(home)
	if err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	a, ok := pins.MacArches[runtime.GOARCH]
	if !ok {
		return fail(env, cli.ExitRefused, "macOS architecture has no verified pins")
	}
	unlock, err := lockMacRuntime(p)
	if err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	defer unlock()
	if err := fsx.EnsureDir(p.AppRoot, 0o700, fsx.Current()); err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	st, err := state.LoadFrom(p.ToolConfig, fsx.Current())
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if st == nil {
		st = state.New(env.Version)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	gw, err := macService(p, home, launchd.Gateway)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	op, err := macService(p, home, launchd.Operator)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	gwState, err := gw.Status(ctx)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if !gwState.Registered {
		if err := requireFreeMacGatewayPort(); err != nil {
			return fail(env, cli.ExitRefused, "%v", err)
		}
	}
	// Reading every old identity happens before replacing this binary.
	for _, inst := range linkedInstances() {
		if err := preflightDeviceKey(ctx, inst); err != nil {
			return fail(env, cli.ExitRefused, "instance %s device key is inaccessible; existing setup was preserved", inst.Label())
		}
	}
	installer := hermes.MacInstaller{Runner: runner, Download: download.Default(), Paths: p, Home: home, Arch: a, PreserveExistingVenv: gwState.Running}
	printf(env.Stdout, "preparing pinned Hermes, uv, Python and Node in the private macOS runtime")
	if err := installer.Prepare(ctx); err != nil {
		return fail(env, cli.ExitFailure, "%v (existing services were not stopped)", err)
	}
	if err := backupMacRuntimeConfig(p); err != nil {
		return fail(env, cli.ExitFailure, "runtime configuration backup failed")
	}
	envChanged, err := hermes.PrepareMacEnv(p)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	configChanged, err := installer.Configure(ctx)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	for _, name := range pins.ForbiddenToolsets {
		cmd := installer.Command("hermes", "tools", "disable", name, "--platform", "api_server")
		result, err := runner.Run(ctx, cmd)
		if err != nil || result.ExitCode != 0 {
			return fail(env, cli.ExitFailure, "root toolset policy could not be written")
		}
	}
	if err := operator.InstallMacProbe(p); err != nil {
		return fail(env, cli.ExitFailure, "operator program preparation failed")
	}
	self, err := os.Executable()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	binaryChanged, err := copyMacBinary(self, p.ExecutablePath)
	if err != nil {
		return fail(env, cli.ExitFailure, "installed macOS binary could not be prepared")
	}
	if _, err := fsx.ReadRegular(p.ExecutablePath, 0o700, fsx.Current()); err != nil {
		return fail(env, cli.ExitFailure, "installed macOS binary proof failed")
	}
	if err := refreshConnectorDefinition(ctx, layout.DefaultConnectorInstance, func(string, ...any) {}); err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	gwPlistChanged, err := macDefinitionChanged(gw)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	opPlistChanged, err := macDefinitionChanged(op)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if err := activateMacService(ctx, gw, gwPlistChanged || envChanged || configChanged); err != nil {
		return fail(env, cli.ExitFailure, "gateway LaunchAgent: %v", err)
	}
	token, err := connectorGatewayToken()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	client := gateway.Loopback(token)
	if err := client.WaitHealthy(ctx, 60*time.Second); err != nil {
		return fail(env, cli.ExitFailure, "macOS gateway health proof failed")
	}
	if err := client.RequireUnauthorizedWithoutBearer(ctx); err != nil {
		return fail(env, cli.ExitFailure, "macOS gateway does not prove the anonymous-call boundary")
	}
	enabled, err := client.Toolsets(ctx)
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS gateway toolsets could not be read back")
	}
	if err := gateway.RequireToolsetPolicy(enabled); err != nil {
		return fail(env, cli.ExitFailure, "macOS gateway root toolset policy did not read back as requested")
	}
	if err := activateMacService(ctx, op, opPlistChanged || binaryChanged); err != nil {
		return fail(env, cli.ExitFailure, "operator LaunchAgent: %v", err)
	}
	if err := proveMacOperator(ctx, p.OperatorSocket); err != nil {
		return fail(env, cli.ExitFailure, "macOS operator readiness proof failed")
	}
	for _, inst := range linkedInstances() {
		if err := persistConnectorRuntimeCredential(inst, token); err != nil {
			return fail(env, cli.ExitFailure, "instance credentials could not be refreshed")
		}
		if err := refreshConnectorDefinition(ctx, inst, func(string, ...any) {}); err != nil {
			return fail(env, cli.ExitFailure, "instance service definition could not be refreshed")
		}
		service, err := connectorService(inst)
		if err != nil {
			return fail(env, cli.ExitFailure, "%v", err)
		}
		active, err := service.Active(ctx)
		if err != nil {
			return fail(env, cli.ExitFailure, "instance activity could not be checked")
		}
		if active && binaryChanged {
			if err := service.Restart(ctx); err != nil {
				return fail(env, cli.ExitFailure, "instance restart failed")
			}
		}
	}
	st.Mode = state.ModeConnector
	st.ToolVersion = env.Version
	st.PinsApplied["hermes"] = pins.HermesVersion
	st.PinsApplied["hermes_commit"] = pins.HermesInstallerCommit
	st.PinsApplied["uv"] = pins.UVVersion
	st.PinsApplied["python"] = pins.PythonVersion
	st.PinsApplied["node"] = pins.NodeVersion
	st.MarkPhase("mac-runtime", pins.HermesInstallerCommit)
	if err := st.SaveTo(p.ToolConfig, fsx.Current()); err != nil {
		return fail(env, cli.ExitFailure, "macOS setup state could not be saved")
	}
	printf(env.Stdout, "macOS runtime prepared and verified; pair it with edge-setup link --openedbot https://... --yes")
	return cli.ExitOK
}

func macDefinitionChanged(c *launchd.Client) (bool, error) {
	want, err := c.RenderPlist()
	if err != nil {
		return false, err
	}
	old, err := fsx.ReadRegular(c.PlistPath(), 0o600, fsx.Current())
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return string(old) != string(want), nil
}

func activateMacService(ctx context.Context, c *launchd.Client, changed bool) error {
	s, err := c.Status(ctx)
	if err != nil {
		return err
	}
	if s.Registered && !changed {
		if s.Running {
			return nil
		}
		return c.Restart(ctx)
	}
	if s.Registered {
		if err := c.Stop(ctx); err != nil {
			return err
		}
	}
	return c.Start(ctx)
}

func requireFreeMacGatewayPort() error {
	c, err := net.DialTimeout("tcp", "127.0.0.1:8642", 300*time.Millisecond)
	if err == nil {
		_ = c.Close()
		return errors.New("loopback port 8642 belongs to a gateway outside the managed openedbot LaunchAgent; it was left running")
	}
	if !errors.Is(err, syscall.ECONNREFUSED) {
		return errors.New("loopback gateway port availability could not be proved")
	}
	return nil
}

func lockMacSetup(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || !ok || int(stat.Uid) != os.Geteuid() {
		f.Close()
		return nil, errors.New("macOS setup lock is not private and user-owned")
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another macOS setup is already running")
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}

func copyMacBinary(source, target string) (bool, error) {
	data, err := os.ReadFile(source)
	if err != nil {
		return false, err
	}
	old, err := fsx.ReadRegular(target, 0o700, fsx.Current())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if string(old) == string(data) {
		return false, nil
	}
	if err := fsx.EnsureDir(filepath.Dir(target), 0o700, fsx.Current()); err != nil {
		return false, err
	}
	return true, fsx.WriteAtomic(target, data, 0o700, fsx.Current())
}

func backupMacRuntimeConfig(p layout.MacRuntimePaths) error {
	dir := filepath.Join(p.AppRoot, "backups", time.Now().UTC().Format("20060102T150405.000000000Z"))
	for _, name := range []string{".env", "runtime.env", "config.yaml"} {
		data, err := fsx.ReadRegular(filepath.Join(p.RuntimeRoot, name), 0o600, fsx.Current())
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if err := fsx.EnsureDir(dir, 0o700, fsx.Current()); err != nil {
			return err
		}
		if err := fsx.WriteAtomic(filepath.Join(dir, name), data, 0o600, fsx.Current()); err != nil {
			return err
		}
	}
	return nil
}

func runMacOperatorDaemon(env cli.Env, ctx context.Context) int {
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	p, err := layout.MacRuntime(home)
	if err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	token, err := connectorGatewayToken()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	g, err := macService(p, home, launchd.Gateway)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	srv, err := operator.MacHost(runner, token, operator.MacHostConfig{Paths: p, Home: home, Token: connectorGatewayToken, RestartGateway: g.Restart}, func(f string, a ...any) { printf(env.Stderr, f, a...) })
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if err := operator.ListenAsUser(ctx, p.OperatorSocket, srv.Handler()); err != nil {
		return fail(env, cli.ExitFailure, "operator: %v", err)
	}
	return cli.ExitOK
}

func proveMacOperator(ctx context.Context, path string) error {
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", path)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://operator/capabilities", nil)
		res, err := client.Do(req)
		if err == nil {
			var doc struct {
				Features []string `json:"features"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&doc)
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK && decodeErr == nil {
				ready := true
				for _, required := range []string{"provider_management", "toolset_management", "mcp_management", "mcp_oauth", "profile_management", "profile_credentials", "gateway_restart"} {
					found := false
					for _, name := range doc.Features {
						if name == required {
							found = true
							break
						}
					}
					if !found {
						ready = false
						break
					}
				}
				if ready {
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return errors.New("operator did not prove the required runtime features")
}
