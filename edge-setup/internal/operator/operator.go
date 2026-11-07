// Package operator serves the named verbs of the Host routes in
// internal/connector/allowlist.go on behalf of the openedbot link:
// provider credentials and device-code OAuth, a bounded read-only account-usage
// probe, toolsets, MCP servers and their OAuth, named profiles, the session
// inventory, the one gateway restart, A2A card/audit/peer policy and the
// named-profile approval policy.
// It listens on a root-owned Unix socket that only the confined connector unit
// can reach. The only programs it executes are fixed Hermes credential/toolset
// commands, `systemctl restart hermes-gateway`, its embedded Python probes,
// a fixed read-only TCP listener inspection and the approval config reader;
// never a shell or caller-supplied
// path (docs/CONNECTOR.md, « Fournisseurs par le lien »).
package operator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
)

// Bounds of the operator contract.
const (
	MaxBody      = 8 << 10
	MaxAPIKey    = 4000
	SessionTTL   = 15 * time.Minute
	KeyTimeout   = 2 * time.Minute
	LoginTimeout = SessionTTL
	// ToolsetTimeout bounds `hermes tools enable|disable`, which rewrites the
	// whole config file under a cold Python interpreter.
	ToolsetTimeout = 90 * time.Second
)

// toolsetPlatform is the ONLY platform this operator writes.
//
// `GET /v1/toolsets` reports what the api_server platform carries, and that is
// the platform every openedbot run uses. The Hermes Dashboard's own toggle
// defaults to `cli` instead, so a change made there is invisible to the
// gateway, writing anything but api_server here would "succeed" and change
// nothing observable.
const toolsetPlatform = "api_server"

var (
	providerRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	toolsetRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9_]{0,63}$`)
	skillRe       = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	mcpNameRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	profileSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	// modelTokenRe bounds a provider slug or model id written into a
	// profile's `model` block. Wider than providerRe: ids carry dots,
	// colons and slashes (`gpt-5.6-luna`, `openai/gpt-4`).
	modelTokenRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$`)
	labelRe      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	sessionRe    = regexp.MustCompile(`^[A-Za-z0-9._~-]{1,128}$`)
)

// Login is a running `hermes auth add <provider> --no-browser` process.
type Login interface {
	// Lines streams the merged stdout/stderr, one line at a time, and is
	// closed when the process ends.
	Lines() <-chan string
	// Wait blocks until the process ends and returns its failure, if any.
	Wait() error
	// Kill stops the process; Wait then returns.
	Kill()
}

// Server is the operator. Every dependency is injectable so the contract is
// proven offline; Host wires the real ones.
type Server struct {
	// Runner executes `hermes auth add --type api-key` (the key on stdin).
	Runner exec.Runner
	// HermesCommand builds the host-local CLI invocation. Host paths and
	// execution identity are supplied by setup, never by a relay request.
	// nil preserves the established Linux command.
	HermesCommand func(args ...string) exec.Cmd
	// CredentialEnv scopes snapshots and profile mirroring to the runtime
	// selected by host setup. nil retains the Linux store.
	CredentialEnv CredentialEnv
	// Catalogue reads /api/model/options on the loopback gateway.
	Catalogue func(ctx context.Context) ([]byte, error)
	// StartLogin spawns the device-code login for a provider.
	StartLogin func(ctx context.Context, provider string) (Login, error)
	// UsageProbe reads bounded account usage for fixed provider slugs only.
	UsageProbe UsageProbe
	// ProviderSDKs probes imports using the gateway's fixed Python interpreter.
	ProviderSDKs func(ctx context.Context) ([]hermes.ProviderSDKStatus, error)
	// Probe executes one verb of the embedded toolset/MCP program.
	Probe Probe
	// Inventory reads /v1/toolsets on the loopback gateway, so a toolset
	// write is proven on the runtime's own inventory and never on the CLI's
	// exit code, which stays 0 even when the CLI printed a refusal.
	Inventory func(ctx context.Context) ([]byte, error)
	// ProfileInventory reads /p/<slug>/v1/toolsets for a named profile. The
	// fallback to Inventory keeps the handler easy to exercise in small tests;
	// Host always wires the profile-specific reader.
	ProfileInventory func(ctx context.Context, profile string) ([]byte, error)
	// ProfileToolsets applies a profile toolset batch, both directions, in
	// one process scoped to the profile's home (profile_toolsets_apply.go).
	// nil, or an error, falls back on one `hermes tools` call per direction.
	ProfileToolsets func(ctx context.Context, profile string, enable, disable []string) error
	// ProfileCatalogue reads /p/<slug>/api/model/options so a per-profile
	// credential is proven on that profile, never on the root catalogue.
	ProfileCatalogue func(ctx context.Context, profile string) ([]byte, error)
	// GatewayToken reads the root gateway bearer for profile creation. It is
	// sent only to the probe's stdin and never returned or logged.
	GatewayToken func() (string, error)
	// Multiplex is the last value read from the profiles probe. It is refreshed
	// at startup and for every capabilities request, while pure reads remain
	// cached by inventory.go.
	Multiplex bool
	// MCPLiveReload is read with Multiplex from the same profiles probe: the
	// installed gateway reconciles its live MCP servers with every served
	// profile's config on each housekeeping tick (upstream
	// `_mcp_config_reconciler`, every 60 s), and running sessions pick new
	// tools up between turns. An MCP write then needs no gateway restart.
	MCPLiveReload bool
	// AutoUpgradeEnabled reports whether the upgrade timer of this host is
	// enabled; openedbot shows it next to a pending connector release. nil on
	// a host without the timer (macOS, tests).
	AutoUpgradeEnabled func() bool
	// GracefulRestart: RestartGateway drains the running turns before the
	// gateway relaunches (gracefulGatewayRestart), instead of cutting them.
	GracefulRestart bool
	// StartMCPOAuth spawns the MCP OAuth authorization program for one
	// configured server, with the openedbot callback it must register.
	// profile is "" for the runtime root, or the named profile whose home
	// receives the token (`mcp_oauth_profile`).
	// nil when the program is not installed: `mcp_oauth` is then not claimed.
	StartMCPOAuth func(ctx context.Context, server, profile, redirectURI string) (OAuthFlow, error)
	// RestartGateway restarts layout.GatewayUnit, the ONE restart the link
	// carries (gateway.go). nil: `gateway_restart` is not claimed.
	RestartGateway func(ctx context.Context) error
	// GatewayHealthy proves the gateway answers /health after a restart.
	GatewayHealthy func(ctx context.Context) error
	// GatewayActiveSince reads when the gateway unit last became active, so
	// a « restart pending » marker older than that is dropped.
	GatewayActiveSince func(ctx context.Context) (time.Time, error)
	// GatewayRestarted runs once the gateway is known to have (re)started at
	// `at`: the approval policy marks loaded the profiles pending before it.
	GatewayRestarted func(at time.Time)
	// RestartMarker is the file recording a pending gateway restart
	// (layout.GatewayRestartMarker on the host). Empty: no marker is kept.
	RestartMarker string
	// Sessions reads one page of GET /api/sessions on the loopback gateway
	// for the default (empty) or a named profile. nil: `sessions_inventory`
	// is not claimed (sessions.go).
	Sessions func(ctx context.Context, profile string, offset int) ([]byte, error)
	// A2ACard reads the pinned plugin's validated metadata from its fixed
	// loopback listener. nil or unavailable: `a2a_card` is not claimed.
	A2ACard func(ctx context.Context) (A2AAgentCard, error)
	// A2AAudit reads metadata from the fixed local append-only journal.
	A2AAudit            a2aAuditReader
	A2APeers            a2aPolicyReader
	WriteA2APeer        a2aPolicyWriter
	A2APolicyReady      func(context.Context) bool
	ApprovalPolicyRead  func(context.Context, string) (approvalPolicyState, error)
	ApprovalPolicyWrite func(context.Context, string, approvalPolicyRequest) (approvalPolicyState, error)
	Now                 func() time.Time
	Logf                func(string, ...any)
	// InventoryRoots are the files GET /inventory/fingerprint watches. An
	// empty RuntimeRoot answers 404: the connector then never signals.
	InventoryRoots InventoryRoots
	// WorkspaceRoot is the host side of the terminal sandbox's `/workspace`
	// mount (workspace_files.go). Empty answers 404: no file crosses the link.
	WorkspaceRoot string
	// SkillsHubReady forces the skills hub on (tests). Otherwise the fixed
	// probe runs once, lazily, the first time the features are listed: the
	// host start keeps exactly one multiplex refresh and no extra Python call.
	SkillsHubReady  bool
	skillsHubOnce   sync.Once
	skillsHubProbed bool
	// skillsHubRefresh single-flights the background index refresh.
	skillsHubRefresh skillsHubRefresher
	// multiplexFlight is closed when the profiles read in flight for
	// /capabilities ends; nil when none runs. Concurrent requests join it.
	multiplexFlight chan struct{}
	// SkillsOperationDir is the operator's persistent state directory. Tests may
	// redirect it; production uses the durable Linux state directory or the
	// managed macOS state root.
	SkillsOperationDir string

	mu          sync.Mutex
	sessions    map[string]*session
	mcpSessions map[string]*mcpOAuthSession
	skillOps    map[string]*skillOperation
	restart     *restartJob
	usageCache  *usageCache
	usageFlight *usageFlight
	// credBusy serialises `hermes auth add`. The link allows 64 requests in
	// flight; without this, 64 concurrent CLI processes (2 min each) can be
	// started under the service user on a one-vCPU host.
	credBusy sync.Mutex
	// toolsetBusy and mcpBusy serialise the two config-file writers. Both
	// read, mutate and rewrite the whole config.yaml, so two concurrent runs
	// silently lose one of the changes.
	toolsetBusy sync.Mutex
	mcpBusy     sync.Mutex
	// configLocks hold one lock per config.yaml, taken by every writer for
	// its whole read, change and rewrite (config_lock.go). The two mutexes
	// above only keep one toolset or MCP change at a time: model, memory,
	// skill and policy writes go through neither. Guarded by mu.
	configLocks map[string]chan struct{}
	// probeCache and probeFlights make the two READ verbs cheap: each one
	// starts a cold interpreter, and the capability page needs one of them to
	// render at all.
	probeCache   map[string]*probeCacheEntry
	probeFlights map[string]*probeFlight
	// probeGeneration is bumped by every write. A read that started before a
	// write must not cache the state it saw.
	probeGeneration uint64
	// profilesGeneration is bumped by a write to one profile's home only
	// (profileScopedWriteVerbs): it voids a "profiles" read in flight, never a
	// root read, which that write cannot have changed.
	profilesGeneration uint64
	// lastFingerprint is the last inventory fingerprint served; a different
	// one drops the read cache (inventory_fingerprint.go).
	lastFingerprint string
	// lastRootFingerprint is the root's part of it: unchanged, a move dropped
	// only the profile inventory.
	lastRootFingerprint string
}

// errNoInventory is returned when the operator was built without a gateway
// reader: a toolset write cannot then be proven, and an unproven write is
// reported as unverified rather than as a success.
var errNoInventory = errors.New("the gateway inventory reader is not configured")

// Session is the wire shape of an OAuth session.
type Session struct {
	SessionID       string  `json:"sessionId"`
	Provider        string  `json:"provider"`
	Status          string  `json:"status"`
	VerificationURI *string `json:"verificationUri"`
	UserCode        *string `json:"userCode"`
	Error           *string `json:"error"`
	ExpiresAt       string  `json:"expiresAt"`
}

// Session statuses.
const (
	StatusStarting  = "starting"
	StatusPending   = "pending"
	StatusConnected = "connected"
	StatusFailed    = "failed"
	StatusCancelled = "cancelled"
)

// CredentialResult is the wire shape of an API-key add.
type CredentialResult struct {
	Provider     string  `json:"provider"`
	Label        string  `json:"label"`
	Verification string  `json:"verification"`
	Detail       *string `json:"detail"`
}

type session struct {
	id        string
	provider  string
	status    string
	uri       string
	code      string
	err       string
	startedAt time.Time
	expiresAt time.Time
	login     Login
	cancel    context.CancelFunc
	parser    loginParser
	envBefore map[string]string
}

// Handler returns the HTTP handler served on the socket.
func (s *Server) Handler() http.Handler {
	s.mu.Lock()
	s.loadSkillOperationsLocked()
	s.mu.Unlock()
	mux := strictMux{http.NewServeMux()}
	mux.HandleFunc("GET /capabilities", func(w http.ResponseWriter, r *http.Request) {
		s.refreshMultiplex(r.Context())
		features := s.features()
		if s.A2ACard != nil {
			if _, err := s.A2ACard(r.Context()); err == nil {
				features = append(features, A2ACardFeature)
				if s.A2AAudit != nil {
					if s.A2APeers != nil && s.WriteA2APeer != nil && s.A2APolicyReady != nil && s.A2APolicyReady(r.Context()) {
						features = append(features, "a2a_management")
					} else {
						features = append(features, "a2a_audit")
					}
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"features": features})
	})
	mux.HandleFunc("GET /usage", s.usage)
	mux.HandleFunc("GET /provider-sdks", s.providerSDKs)
	mux.HandleFunc("POST /providers/{provider}/credentials", s.addCredential)
	mux.HandleFunc("POST /providers/{provider}/oauth", s.startOAuth)
	mux.HandleFunc("GET /providers/{provider}/oauth/{session}", s.pollOAuth)
	mux.HandleFunc("DELETE /providers/{provider}/oauth/{session}", s.cancelOAuth)
	// La fenetre de contexte du modele configure. Lecture seule, aucun
	// argument hors un slug de profil : le gateway ne la publie nulle part.
	mux.HandleFunc("GET /model-context", s.modelContext)
	mux.HandleFunc("GET /inventory/fingerprint", s.inventoryFingerprint)
	mux.HandleFunc("GET /skills", s.skills)
	mux.HandleFunc("GET /toolsets", s.toolsets)
	mux.HandleFunc("POST /toolsets/{name}", s.setToolset)
	mux.HandleFunc("GET /mcp/servers", s.mcpInventory)
	mux.HandleFunc("POST /mcp/servers", s.mcpAdd)
	mux.HandleFunc("POST /mcp/catalog/{name}", s.mcpInstall)
	mux.HandleFunc("DELETE /mcp/servers/{name}", s.mcpRemove)
	// MCP OAuth: the browser leg of an `auth: oauth` server, played through
	// openedbot because a headless host has no browser and no loopback
	// listener a provider could redirect to (mcp_oauth.go).
	mux.HandleFunc("POST /mcp/servers/{name}/oauth", s.startMCPOAuth)
	mux.HandleFunc("GET /mcp/servers/{name}/oauth/{session}", s.pollMCPOAuth)
	mux.HandleFunc("POST /mcp/servers/{name}/oauth/callback", s.callbackMCPOAuth)
	mux.HandleFunc("DELETE /mcp/servers/{name}/oauth/{session}", s.cancelMCPOAuth)
	// The gateway loads its MCP servers at boot only: these three routes say
	// whether a restart is pending, start the ONE restart the link carries,
	// and follow it (gateway.go).
	mux.HandleFunc("GET /gateway", s.gatewayStatus)
	mux.HandleFunc("POST /gateway/restart", s.startGatewayRestart)
	mux.HandleFunc("GET /gateway/restart/{job}", s.pollGatewayRestart)
	// Profile inventory and the named profile lifecycle/capability routes. No
	// .env, memories or sessions cross the operator boundary.
	mux.HandleFunc("GET /profiles", s.profiles)
	mux.HandleFunc("GET /profiles/{slug}/avatar", s.profileAvatar)
	mux.HandleFunc("POST /profiles", s.createProfile)
	mux.HandleFunc("DELETE /profiles/{slug}", s.deleteProfile)
	mux.HandleFunc("POST /profiles/{slug}/toolsets/{toolset}", s.setProfileToolset)
	mux.HandleFunc("POST /profiles/{slug}/toolsets", s.setProfileToolsets)
	mux.HandleFunc("GET /profiles/{slug}/memory", s.profileMemory)
	mux.HandleFunc("POST /profiles/{slug}/memory", s.writeProfileMemory)
	mux.HandleFunc("POST /profiles/{slug}/mcp/servers/{server}", s.setProfileMCP)
	mux.HandleFunc("DELETE /profiles/{slug}/mcp/servers/{server}", s.removeProfileMCP)
	mux.HandleFunc("POST /profiles/{slug}/model", s.setProfileModel)
	mux.HandleFunc("POST /profiles/models", s.setProfileModels)
	mux.HandleFunc("GET /profiles/{slug}/approval-policy", approvalPolicyHandler(s.ApprovalPolicyRead, s.lockedApprovalPolicyWrite()))
	mux.HandleFunc("PUT /profiles/{slug}/approval-policy", approvalPolicyHandler(s.ApprovalPolicyRead, s.lockedApprovalPolicyWrite()))
	mux.HandleFunc("POST /profiles/{slug}/skills/{skill}", s.setProfileSkill)
	mux.HandleFunc("POST /profiles/{slug}/bundled-skills", s.setProfileBundledSkills)
	mux.HandleFunc("POST /profiles/{slug}/providers/{provider}/credentials", s.addProfileCredential)
	mux.HandleFunc("DELETE /profiles/{slug}/providers/{provider}/credentials", s.deleteProfileCredential)
	mux.HandleFunc("POST /skills/hub/search", s.skillsSearch)
	mux.HandleFunc("POST /skills/hub/inspect", s.skillsInspect)
	mux.HandleFunc("POST /profiles/{slug}/skills/hub/scan", s.skillsScan)
	mux.HandleFunc("POST /profiles/{slug}/skills/hub/install", s.installSkill)
	mux.HandleFunc("GET /profiles/{slug}/skills/hub/operations/{uuid}", s.getSkillOperation)
	mux.HandleFunc("DELETE /profiles/{slug}/skills/{skill}", s.deleteSkill)
	// The bounded session inventory: identifiers, owning profile and start
	// time, so openedbot can spot a run created outside the link.
	mux.HandleFunc("GET /sessions-inventory", s.sessionsInventory)
	mux.HandleFunc("GET /workspace/files/{file}", s.workspaceFile)
	mux.HandleFunc("GET /a2a/agent-card", s.a2aAgentCard)
	mux.HandleFunc("GET /a2a/audit", newA2AAuditHandler(s.A2AAudit))
	mux.HandleFunc("GET /a2a/peers", a2aPolicyListHandler(s.A2APeers))
	mux.HandleFunc("POST /a2a/peers/{peer}/trust", a2aPolicyTrustHandler(s.WriteA2APeer))
	mux.HandleFunc("POST /a2a/peers/{peer}/token", a2aPolicyTokenHandler(s.WriteA2APeer))
	mux.HandleFunc("DELETE /a2a/peers/{peer}/token", a2aPolicyTokenDeleteHandler(s.WriteA2APeer))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "ROUTE_UNKNOWN", "the operator serves provider credentials, bounded account usage, the toolset and MCP verbs, MCP OAuth, the gateway restart, the profile inventory, the session inventory and the bounded A2A Agent Card read only")
	})
	return strictPath(mux)
}

// features returns the static operator verbs backed by configured functions.
// GET /capabilities adds `a2a_card` only when its live listener and card checks
// pass. A feature is claimed only when this operator can serve it.
func (s *Server) features() []string {
	features := []string{"provider_management", "provider_usage"}
	s.mu.Lock()
	multiplex := s.Multiplex
	liveReload := s.MCPLiveReload
	s.mu.Unlock()
	if s.Probe != nil && s.Inventory != nil {
		features = append(features, "toolset_management")
	}
	if s.Probe != nil {
		features = append(features, "mcp_management", "profile_inventory", "model_context")
	}
	if s.ProviderSDKs != nil {
		features = append(features, "provider_sdks")
	}
	if s.skillsHubEnabled() {
		features = append(features, "skills_hub")
	}
	if s.Probe != nil && multiplex {
		features = append(features, "profile_management", "profile_credentials", "profile_memory")
		if s.Inventory != nil {
			features = append(features, "profile_capabilities", "profile_model_batch", "profile_bundled_skills")
		}
	}
	if s.Probe != nil && s.StartMCPOAuth != nil {
		features = append(features, "mcp_oauth")
	}
	if s.RestartGateway != nil {
		features = append(features, "gateway_restart")
	}
	if s.Sessions != nil {
		features = append(features, "sessions_inventory")
	}
	if s.ApprovalPolicyRead != nil && s.ApprovalPolicyWrite != nil {
		features = append(features, approvalPolicyFeature)
	}
	// Last on purpose: the newest name, and the first one an API at a small
	// bound drops. Without it openedbot never offers a bot-level MCP
	// connection, it does not fall back to the root (whose token a profile
	// would not read).
	if s.Probe != nil && s.StartMCPOAuth != nil && multiplex {
		features = append(features, "mcp_oauth_profile")
	}
	// Disconnecting a bot is a profile config write plus a token removal in
	// the profile home: it needs the verbs and a multiplexing host, not the
	// OAuth program.
	if s.Probe != nil && multiplex {
		features = append(features, "mcp_profile_disconnect")
	}
	// The newest: without it openedbot keeps asking for a gateway restart
	// after an MCP change, which stays correct, only slower.
	if s.Probe != nil && liveReload {
		features = append(features, "mcp_live_reload")
	}
	// Newer still: without it openedbot warns that a restart interrupts the
	// running turns, which is what an ungraceful restart does.
	if s.RestartGateway != nil && s.GracefulRestart {
		features = append(features, "gateway_graceful_restart")
	}
	// Newest: without it openedbot shows the gateway's skills failure as is.
	if s.Probe != nil {
		features = append(features, SkillsInventoryFeature)
	}
	// Newer than newest: without it openedbot writes a profile's toolsets
	// one request at a time, which stays correct, only slower.
	if s.Probe != nil && multiplex && s.Inventory != nil {
		features = append(features, profileToolsetsBatchFeature)
	}
	// Not a verb but a state: the host installs newer releases on its own.
	// Without it openedbot shows the command that enables the timer.
	if s.AutoUpgradeEnabled != nil && s.AutoUpgradeEnabled() {
		features = append(features, AutoUpgradeFeature)
	}
	return features
}

// AutoUpgradeFeature announces that the upgrade timer is enabled. It is read
// on every /capabilities request, so the link re-announces a change.
const AutoUpgradeFeature = "auto_upgrade"

// refreshMultiplex reads the profiles document so capability advertisement is
// fail-closed when an administrator changes the root config at the console.
// The profiles document itself remains a cacheable pure read.
//
// Requests that arrive while a read is running join it rather than start their
// own: opening one console screen asks /capabilities from several API routes
// at once, and each read is a Python start on the host. A joined read began
// at most one probe earlier, so the answer stays fail-closed.
func (s *Server) refreshMultiplex(ctx context.Context) {
	if s.Probe == nil {
		s.mu.Lock()
		s.Multiplex = false
		s.MCPLiveReload = false
		s.mu.Unlock()
		return
	}
	s.mu.Lock()
	if flight := s.multiplexFlight; flight != nil {
		s.mu.Unlock()
		select {
		case <-flight:
		case <-ctx.Done():
		}
		return
	}
	flight := make(chan struct{})
	s.multiplexFlight = flight
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.multiplexFlight = nil
		s.mu.Unlock()
		close(flight)
	}()
	var doc ProfileInventory
	if err := s.runFreshProbe(ctx, "profiles", nil, &doc); err != nil {
		s.mu.Lock()
		s.Multiplex = false
		s.MCPLiveReload = false
		s.mu.Unlock()
		return
	}
	s.mu.Lock()
	s.Multiplex = doc.Multiplex
	s.MCPLiveReload = doc.MCPLiveReload
	s.mu.Unlock()
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) logf(format string, args ...any) {
	if s.Logf != nil {
		s.Logf(format, args...)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func provider(w http.ResponseWriter, r *http.Request) (string, bool) {
	p := r.PathValue("provider")
	if !providerRe.MatchString(p) {
		writeError(w, http.StatusBadRequest, "PROVIDER_INVALID", "provider slug is invalid")
		return "", false
	}
	return p, true
}

func optional(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// --- API key -------------------------------------------------------------

type credentialBody struct {
	APIKey string `json:"apiKey"`
	Label  string `json:"label"`
}

func (s *Server) addCredential(w http.ResponseWriter, r *http.Request) {
	p, ok := provider(w, r)
	if !ok {
		return
	}
	var body credentialBody
	raw, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(raw) > MaxBody {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is missing or too large")
		return
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is not JSON")
		return
	}
	key := body.APIKey
	if key == "" || len(key) > MaxAPIKey || strings.ContainsAny(key, "\r\n") || hasControl(key) {
		writeError(w, http.StatusBadRequest, "API_KEY_INVALID", "the API key must be one non-empty line without control characters")
		return
	}
	label := body.Label
	if label == "" {
		label = "openedbot-" + s.now().UTC().Format("20060102") + "-" + randomHex(2)
	}
	if !labelRe.MatchString(label) {
		writeError(w, http.StatusBadRequest, "LABEL_INVALID", "the label is invalid")
		return
	}
	if !s.credBusy.TryLock() {
		writeError(w, http.StatusConflict, "CREDENTIAL_IN_PROGRESS", "an API-key add is already running; retry once it completes")
		return
	}
	defer s.credBusy.Unlock()
	before, err := s.snapshotRootEnv()
	if err != nil {
		writeError(w, http.StatusBadGateway, "CREDENTIAL_MIRROR_FAILED", "the runtime credential environment could not be read safely")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), KeyTimeout)
	defer cancel()
	cmd := s.hermesCommand("auth", "add", p, "--type", "api-key", "--label", label)
	cmd.Stdin = []byte(key + "\n")
	cmd.Timeout = KeyTimeout
	_, commandErr := exec.Must(ctx, s.Runner, cmd)
	mirrorErr := s.mirrorCredentialEnv(before)
	if mirrorErr != nil {
		s.logf("credential environment mirroring failed after adding %s", p)
		writeError(w, http.StatusBadGateway, "CREDENTIAL_MIRROR_FAILED", "the credential was written but could not be mirrored to profiles")
		return
	}
	if commandErr != nil {
		s.logf("credential add for %s refused by the CLI", p)
		writeError(w, http.StatusBadGateway, "CLI_REFUSED", "the runtime refused the credential: "+redact(commandErr.Error(), key))
		return
	}
	verdict, detail := s.verify(ctx, p)
	writeJSON(w, http.StatusOK, CredentialResult{Provider: p, Label: label, Verification: verdict, Detail: optional(detail)})
}

// verify re-reads the catalogue: « the CLI said yes » is not a proof.
func (s *Server) verify(ctx context.Context, p string) (string, string) {
	body, err := s.Catalogue(ctx)
	if err != nil {
		return "unverified", "the runtime catalogue could not be read: " + err.Error()
	}
	state, err := gateway.ProviderState(body, p)
	if err != nil {
		return "unverified", err.Error()
	}
	switch state {
	case gateway.Authenticated:
		return "confirmed", ""
	case gateway.Denied:
		return "denied", p + " still does not authenticate against the runtime catalogue"
	default:
		return "denied", p + " does not appear in the runtime catalogue"
	}
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func redact(msg, secret string) string {
	if secret == "" {
		return msg
	}
	return strings.ReplaceAll(msg, secret, "[redacted]")
}

func mirrorCredentialEnv(before map[string]string) error {
	after, err := hermes.SnapshotRuntimeEnv()
	if err != nil {
		return err
	}
	return hermes.MirrorRuntimeEnvDelta(before, after)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strings.Repeat("0", n*2)
	}
	return hex.EncodeToString(b)
}

// --- OAuth device code ---------------------------------------------------

func (s *Server) startOAuth(w http.ResponseWriter, r *http.Request) {
	p, ok := provider(w, r)
	if !ok {
		return
	}
	// The body is "{}" or empty; anything else is a client bug, not a secret.
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, MaxBody))
	s.mu.Lock()
	s.sweepLocked()
	if s.sessions == nil {
		s.sessions = map[string]*session{}
	}
	for _, existing := range s.sessions {
		if existing.provider == p && (existing.status == StatusStarting || existing.status == StatusPending) {
			view := s.viewLocked(existing)
			s.mu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":   map[string]string{"code": "OAUTH_IN_PROGRESS", "message": "an authorization is already pending for " + p},
				"session": view,
			})
			return
		}
	}
	if s.StartLogin == nil {
		s.mu.Unlock()
		writeError(w, http.StatusServiceUnavailable, "OAUTH_UNAVAILABLE", "device-code login is not available on this host")
		return
	}
	before, err := s.snapshotRootEnv()
	if err != nil {
		s.mu.Unlock()
		writeError(w, http.StatusBadGateway, "CREDENTIAL_MIRROR_FAILED", "the runtime credential environment could not be read safely")
		return
	}
	now := s.now()
	ctx, cancel := context.WithTimeout(context.Background(), LoginTimeout)
	sess := &session{id: randomHex(16), provider: p, status: StatusStarting, startedAt: now, expiresAt: now.Add(SessionTTL), cancel: cancel, envBefore: before}
	s.sessions[sess.id] = sess
	s.mu.Unlock()

	login, err := s.StartLogin(ctx, p)
	if err != nil {
		cancel()
		s.mu.Lock()
		sess.status = StatusFailed
		sess.err = "the login could not be started: " + err.Error()
		view := s.viewLocked(sess)
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, view)
		return
	}
	s.mu.Lock()
	sess.login = login
	view := s.viewLocked(sess)
	s.mu.Unlock()
	go s.follow(ctx, sess)
	writeJSON(w, http.StatusOK, view)
}

// follow reads the login output until the process ends, then proves the
// result on the catalogue.
func (s *Server) follow(ctx context.Context, sess *session) {
	for line := range sess.login.Lines() {
		s.mu.Lock()
		if sess.status == StatusStarting || sess.status == StatusPending {
			sess.parser.feed(line)
			if sess.parser.uri != "" && sess.parser.code != "" {
				sess.uri, sess.code = sess.parser.uri, sess.parser.code
				sess.status = StatusPending
			} else if sess.parser.uri != "" && sess.uri == "" {
				sess.uri = sess.parser.uri
			}
		}
		s.mu.Unlock()
	}
	err := sess.login.Wait()
	mirrorErr := s.mirrorCredentialEnv(sess.envBefore)
	s.mu.Lock()
	if sess.status == StatusCancelled {
		s.mu.Unlock()
		return
	}
	if mirrorErr != nil {
		sess.status = StatusFailed
		sess.err = "the credential was written but could not be mirrored to profiles"
		s.mu.Unlock()
		return
	}
	if ctx.Err() != nil && err != nil {
		sess.status = StatusFailed
		sess.err = "the authorization timed out"
		s.mu.Unlock()
		return
	}
	if err != nil {
		sess.status = StatusFailed
		sess.err = "the login did not complete: " + sess.parser.lastError(err)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	// The login is in the pool: the replaced logins of this provider leave
	// before the proof, so the catalogue reflects the account that stays.
	pctx, pcancel := context.WithTimeout(context.Background(), pruneLoginsTimeout)
	if removed := s.pruneStaleLogins(pctx, sess.provider); len(removed) > 0 {
		s.logf("removed %d stale login(s) of %s after a new one", len(removed), sess.provider)
	}
	pcancel()
	if adoptErr := s.adoptRootOAuthGrant(sess.provider); adoptErr != nil {
		s.mu.Lock()
		sess.status = StatusFailed
		sess.err = adoptErr.Error()
		s.mu.Unlock()
		return
	}
	vctx, vcancel := context.WithTimeout(context.Background(), 30*time.Second)
	verdict, detail := s.verify(vctx, sess.provider)
	vcancel()
	s.mu.Lock()
	if verdict == "confirmed" {
		sess.status = StatusConnected
	} else {
		sess.status = StatusFailed
		sess.err = detail
	}
	s.mu.Unlock()
}

func (s *Server) lookup(w http.ResponseWriter, r *http.Request) (*session, bool) {
	p, ok := provider(w, r)
	if !ok {
		return nil, false
	}
	id := r.PathValue("session")
	if !sessionRe.MatchString(id) {
		writeError(w, http.StatusNotFound, "OAUTH_SESSION_NOT_FOUND", "this authorization no longer exists")
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	sess := s.sessions[id]
	if sess == nil || sess.provider != p {
		writeError(w, http.StatusNotFound, "OAUTH_SESSION_NOT_FOUND", "this authorization no longer exists")
		return nil, false
	}
	return sess, true
}

func (s *Server) pollOAuth(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.lookup(w, r)
	if !ok {
		return
	}
	s.mu.Lock()
	view := s.viewLocked(sess)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) cancelOAuth(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.lookup(w, r)
	if !ok {
		return
	}
	s.mu.Lock()
	if sess.status == StatusStarting || sess.status == StatusPending {
		sess.status = StatusCancelled
		if sess.login != nil {
			sess.login.Kill()
		}
		sess.cancel()
	}
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) viewLocked(sess *session) Session {
	return Session{
		SessionID: sess.id, Provider: sess.provider, Status: sess.status,
		VerificationURI: optional(sess.uri), UserCode: optional(sess.code), Error: optional(sess.err),
		ExpiresAt: sess.expiresAt.UTC().Format(time.RFC3339),
	}
}

// sweepLocked expires sessions: a pending one past its TTL is killed and
// reported failed; terminal ones are forgotten after the same delay.
func (s *Server) sweepLocked() {
	now := s.now()
	for id, sess := range s.sessions {
		if now.Before(sess.expiresAt) {
			continue
		}
		if sess.status == StatusStarting || sess.status == StatusPending {
			sess.status = StatusFailed
			sess.err = "the authorization expired after 15 minutes"
			if sess.login != nil {
				sess.login.Kill()
			}
			sess.cancel()
			continue
		}
		if now.After(sess.expiresAt.Add(SessionTTL)) {
			delete(s.sessions, id)
		}
	}
}
