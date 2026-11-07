package operator

import (
	"bufio"
	"context"
	"io"
	"os"
	osexec "os/exec"
	"strings"
	"sync"
	"syscall"

	"encoding/json"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Host wires the real dependencies: the host runner for the API-key add, the
// bounded usage probe and the toolset/MCP program, the loopback gateway for
// proofs, and a streamed `hermes auth add --no-browser` for device-code
// logins.
//
// The toolset and MCP verbs need the interpreter program on disk. This
// service only CHECKS it: `up` and `upgrade` write it, from root and outside
// the unit. Installing it here fails on every start, the unit is
// ProtectSystem=strict with ReadWritePaths=<runtime root>, so the chmod
// against /usr/local returns EROFS even when the file is already correct, and
// the operator then serves an amputated feature list on a host that is
// perfectly able to do the work.
//
// A missing program is still not fatal: the operator serves the provider
// verbs, and `features()` stops announcing what it cannot do, a host without
// the program must never make openedbot render a toggle.
func Host(runner exec.Runner, token string, logf func(string, ...any)) *Server {
	server := &Server{
		Runner:         runner,
		InventoryRoots: InventoryRoots{RuntimeRoot: layout.RuntimeRoot, ManagedConfig: layout.ManagedConfig},
		WorkspaceRoot:  layout.WorkspaceRoot,
		Catalogue: func(ctx context.Context) ([]byte, error) {
			return gateway.Loopback(token).ModelOptions(ctx)
		},
		Inventory: func(ctx context.Context) ([]byte, error) {
			return gateway.Loopback(token).ToolsetInventory(ctx)
		},
		ProfileInventory: func(ctx context.Context, profile string) ([]byte, error) {
			return gateway.Loopback(token).ProfileToolsetInventory(ctx, profile)
		},
		ProfileCatalogue: func(ctx context.Context, profile string) ([]byte, error) {
			return gateway.Loopback(token).ProfileModelOptions(ctx, profile)
		},
		GatewayToken: hermes.Token,
		StartLogin:   StartHostLogin,
		UsageProbe:   HostUsageProbe(runner),
		ProviderSDKs: func(ctx context.Context) ([]hermes.ProviderSDKStatus, error) {
			return hermes.ProbeProviderSDKs(ctx, runner, layout.VenvBin+"/python")
		},
		Logf: logf,
		// The gateway restart is the one restart the link carries: the unit
		// is fixed here, the route names nothing (gateway.go).
		RestartGateway: func(ctx context.Context) error {
			return gracefulGatewayRestart(ctx, systemd.Client{Runner: runner}, time.Second)
		},
		GracefulRestart: true,
		GatewayHealthy: func(ctx context.Context) error {
			return gateway.Loopback(token).WaitHealthy(ctx, HealthTimeout)
		},
		GatewayActiveSince: func(ctx context.Context) (time.Time, error) {
			return gatewayActiveSince(ctx, systemd.Client{Runner: runner})
		},
		RestartMarker: layout.GatewayRestartMarker,
		Sessions: func(ctx context.Context, profile string, offset int) ([]byte, error) {
			return gateway.Loopback(token).Sessions(ctx, profile, offset)
		},
		A2ACard: func(ctx context.Context) (A2AAgentCard, error) {
			return readLoopbackA2ACard(ctx, runner)
		},
		A2AAudit: func(ctx context.Context, limit int) (a2aAuditSnapshot, error) {
			return readA2AAuditWithPolicyDenials(ctx, layout.RuntimeRoot, limit)
		},
	}
	policyCfg := a2aPolicyHostConfig{
		RuntimeRoot: layout.RuntimeRoot, Owner: hermes.ServiceOwner(), Runner: runner,
		Command: func(string) exec.Cmd {
			return account.AsUser(layout.ServiceUser, serviceEnv(), layout.VenvBin+"/python")
		},
		ObserveProcess: observeA2APolicyProcess(layout.RuntimeRoot, hermes.ServiceOwner()),
	}
	policyCfg.ProbePeer = hostA2APolicyProver(policyCfg)
	wireA2APolicyServer(server, policyCfg)
	approvalPolicy := approvalPolicyService{
		runtimeRoot: layout.RuntimeRoot, owner: hermes.ServiceOwner(), runner: runner,
		command: server.hermesCommand,
		python: func(args ...string) exec.Cmd {
			return account.AsUser(layout.ServiceUser, serviceEnv(), layout.VenvBin+"/python", args...)
		},
		markPending:    server.markGatewayRestartPending,
		restartPending: func() bool { return restartMarkerPending(server.RestartMarker) },
	}
	server.ProfileToolsets = profileToolsetsApplier(runner, layout.RuntimeRoot, approvalPolicy.python)
	server.ApprovalPolicyRead = approvalPolicy.state
	server.ApprovalPolicyWrite = approvalPolicy.write
	server.GatewayRestarted = approvalPolicy.gatewayRestarted
	server.AutoUpgradeEnabled = func() bool {
		// Stat, not Lstat: a link left to a removed timer is not enabled.
		_, err := os.Stat(layout.AutoUpgradeTimerWants)
		return err == nil
	}
	if err := ProbeInstalled(); err != nil {
		if logf != nil {
			logf("the toolset and MCP verbs are unavailable: %v", err)
		}
		return server
	}
	server.Probe = HostProbe(runner)
	server.refreshMultiplex(context.Background())
	if err := OAuthProbeInstalled(); err != nil {
		if logf != nil {
			logf("MCP OAuth is unavailable: %v", err)
		}
		return server
	}
	server.StartMCPOAuth = StartHostMCPOAuth
	return server
}

// gatewayActiveSince reads the gateway unit's ActiveEnterTimestamp.
func gatewayActiveSince(ctx context.Context, sd systemd.Client) (time.Time, error) {
	raw, err := sd.Show(ctx, layout.GatewayUnit, "ActiveEnterTimestamp")
	if err != nil {
		return time.Time{}, err
	}
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "n/a" {
		return time.Time{}, nil
	}
	// systemd prints « Thu 2026-09-04 10:21:07 UTC » in the unit's timezone.
	for _, layoutForm := range []string{"Mon 2006-01-02 15:04:05 MST", "2006-01-02 15:04:05 MST"} {
		if at, err := time.Parse(layoutForm, raw); err == nil {
			return at, nil
		}
	}
	return time.Time{}, nil
}

// StartHostMCPOAuth runs the embedded MCP OAuth program as the service user.
// The request travels on its stdin as one JSON line, never in argv, and the
// same pipe stays open for the callback. stderr, upstream's human transcript,
// is dropped: only the event lines on stdout are read.
func StartHostMCPOAuth(ctx context.Context, server, profile, redirectURI string) (OAuthFlow, error) {
	spec := account.AsUser(layout.ServiceUser, serviceEnv(), layout.VenvBin+"/python", layout.OperatorOAuthProbe)
	return startMCPOAuthWithSpec(ctx, server, profile, redirectURI, spec, os.Stderr)
}

// mcpOAuthKillGrace is how long a cancelled authorization program has to
// exit before its process group gets SIGKILL.
//
// Signals are only the fallback. The program runs as the service user and
// the hardened operator unit has no CAP_KILL: a root operator may signal
// runuser (root) but gets EPERM on the interpreter, which then kept waiting
// for the provider's callback until its 300 s timeout, holding the server's
// authorization (measured 2026-10-31, lab host). Closing the program's stdin
// is what stops it: EOF is its documented "the operator gave up". A variable
// so tests can shorten it.
var mcpOAuthKillGrace = 3 * time.Second

func startMCPOAuthWithSpec(ctx context.Context, server, profile, redirectURI string, spec exec.Cmd, stderr io.Writer) (OAuthFlow, error) {
	cmd := osexec.CommandContext(ctx, spec.Path, spec.Args...)
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "TERM=dumb", "NO_COLOR=1"}
	if spec.Env != nil {
		cmd.Env = spec.Env
	}
	cmd.Dir = spec.Dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Stopping it: EOF on stdin first (see mcpOAuthKillGrace), then the
	// process group, SIGTERM then SIGKILL after the grace, for whatever the
	// operator is allowed to signal. While any member lives the group id
	// cannot be reused, so the late SIGKILL can only reach this program.
	var stdin io.WriteCloser
	var once sync.Once
	kill := func() {
		once.Do(func() {
			if stdin != nil {
				_ = stdin.Close()
			}
			if cmd.Process == nil {
				return
			}
			group := -cmd.Process.Pid
			_ = syscall.Kill(group, syscall.SIGTERM)
			time.AfterFunc(mcpOAuthKillGrace, func() { _ = syscall.Kill(group, syscall.SIGKILL) })
		})
	}
	// A cancelled context (session swept or cancelled) stops the whole group
	// too, not only runuser as CommandContext would.
	cmd.Cancel = func() error {
		kill()
		return nil
	}
	// Upstream's transcript and tracebacks go to the operator's own stderr ,
	// the root-only journal, where a failed authorization can be read.
	cmd.Stderr = stderr
	pipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdin = pipe
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	fields := map[string]string{"name": server, "redirectUri": redirectURI}
	if profile != "" {
		fields["profile"] = profile
	}
	request, _ := json.Marshal(fields)
	if _, err := stdin.Write(append(request, '\n')); err != nil {
		kill()
		return nil, err
	}
	return newPipeFlow(out, stdin, cmd.Wait, kill), nil
}

// hostLogin is the streamed subprocess. It bypasses exec.Runner on purpose:
// the runner buffers output until exit, and a device-code login must expose
// its URL and code while it is still waiting for the user.
type hostLogin struct {
	cmd   *osexec.Cmd
	lines chan string
	done  chan struct{}
	err   error
	once  sync.Once
}

// hostLoginSpec is the `hermes auth add <provider> --no-browser` invocation.
// Same as hermes.CLI, plus HOME under the runtime root (the operator unit
// protects /home; the gateway unit already runs the service user with this
// HOME) and PYTHONUNBUFFERED=1: stdout is a pipe, not a TTY, and a
// block-buffered Python CLI would hold the device URL and code until exit,
// which for a login waiting on the user is never.
func hostLoginSpec(provider string) exec.Cmd {
	return account.AsUser(layout.ServiceUser, serviceEnv(),
		layout.VenvBin+"/hermes", "auth", "add", provider, "--no-browser")
}

// StartHostLogin runs `hermes auth add <provider> --no-browser` as the
// service user, stdin at EOF so every upstream prompt takes its default.
func StartHostLogin(ctx context.Context, provider string) (Login, error) {
	spec := hostLoginSpec(provider)
	return startLoginWithSpec(ctx, spec)
}

func startLoginWithSpec(ctx context.Context, spec exec.Cmd) (Login, error) {
	cmd := osexec.CommandContext(ctx, spec.Path, spec.Args...)
	cmd.Stdin = strings.NewReader("")
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "TERM=dumb", "NO_COLOR=1"}
	if spec.Env != nil {
		cmd.Env = spec.Env
	}
	cmd.Dir = spec.Dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	l := &hostLogin{cmd: cmd, lines: make(chan string, 64), done: make(chan struct{})}
	go l.pump(out)
	return l, nil
}

func (l *hostLogin) pump(out io.Reader) {
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 64<<10)
	for sc.Scan() {
		select {
		case l.lines <- sc.Text():
		default:
			// A chatty CLI never blocks the process: drop the oldest line.
			select {
			case <-l.lines:
			default:
			}
			l.lines <- sc.Text()
		}
	}
	l.err = l.cmd.Wait()
	close(l.lines)
	close(l.done)
}

func (l *hostLogin) Lines() <-chan string { return l.lines }

func (l *hostLogin) Wait() error {
	<-l.done
	return l.err
}

func (l *hostLogin) Kill() {
	l.once.Do(func() {
		if l.cmd.Process != nil {
			_ = syscall.Kill(-l.cmd.Process.Pid, syscall.SIGTERM)
		}
	})
}
