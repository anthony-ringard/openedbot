package connector

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
	"github.com/coder/websocket"
)

// Auth is how the client identifies itself to the broker.
type Auth struct {
	// EnrollmentTicket ("<id>.<secret>") is used once at link time.
	EnrollmentTicket string
	// RuntimeID and LinkToken are used for every reconnection.
	RuntimeID string
	LinkToken string
}

func (a Auth) header() string {
	if a.EnrollmentTicket != "" {
		return "Bearer enrollment:" + a.EnrollmentTicket
	}
	return "Bearer link:" + a.RuntimeID + "." + a.LinkToken
}

// Client keeps one link to the broker and serves gateway requests over it.
type Client struct {
	// WSURL is wss://<openedbot>/api/runtime-links/ws.
	WSURL string
	Auth  Auth
	// Agent and HermesVersion go into hello.
	Agent         string
	HermesVersion string
	// Gateway is the loopback base URL; Bearer is added to every request.
	Gateway string
	Bearer  string
	HTTP    *http.Client
	// OperatorSocket is the hermes-operator Unix socket. When it exists the
	// host routes are served through it and hello announces
	// provider_management; when empty or absent the host routes fail
	// before_dispatch and nothing is announced.
	OperatorSocket string
	Journal        *Journal
	Diagnostics    *DiagnosticSpool
	CreationAudit  *CreationAudit
	Logf           func(string, ...any)
	Health         func(component string, available bool)
	// OnLinkIssued receives the credentials during enrollment.
	OnLinkIssued func(runtimeID, token string) error
	// OnLinkRotated durably persists a replacement link token before it is
	// used for reconnects. A linked client must provide it: keeping the token
	// in memory only would strand the runtime after a process restart.
	OnLinkRotated func(runtimeID, token string) error
	// OnLinkContext receives link.context: which openedbot (tier, origin,
	// organization, owner) sits behind the link. The daemon persists it so
	// an alert raised while openedbot is unreachable still names it; the
	// enrollment writes it into link.json. A failing handler is logged and
	// never ends the session: the context is display data, not a credential.
	OnLinkContext func(LinkContext) error
	// OnOriginMoved durably persists the link endpoint the connector moves
	// to when link.context announces a new openedbot origin (see
	// MovedWSURL), and the previous one when a move is rolled back. Without
	// it the connector never moves: an endpoint kept in memory only would
	// return to the old origin at the next restart.
	OnOriginMoved func(wsURL string) error
	// DeviceKey is the host's Ed25519 proof-of-possession key. When set, its
	// public half goes into every hello and link.challenge is answered with
	// link.proof; a req that arrives before the proof, inside PoPWindow, is
	// refused LINK_POP_PENDING. An openedbot that never challenges within
	// PoPWindow is an older broker: the session continues and says so.
	DeviceKey ed25519.PrivateKey
	PoPWindow time.Duration
	// OnLinkUp runs when a session is confirmed by a broker frame; the daemon
	// clears its refusal marker there.
	OnLinkUp func()
	// OnLinkRefused runs once when the link has been refused MaxLinkRefusals
	// times in a row and slows down to RefusedRetryInterval; the daemon writes
	// its refusal marker there.
	OnLinkRefused func(error)
	// Dial overrides the WebSocket dialer (tests).
	Dial func(ctx context.Context, url string, opts *websocket.DialOptions) (*websocket.Conn, *http.Response, error)

	// Keepalive and stream bounds; New sets the documented defaults and the
	// tests shorten them.
	PingInterval time.Duration
	PongTimeout  time.Duration
	IdleTimeout  time.Duration
	// InventoryPollInterval spaces the inventory fingerprint reads; zero means
	// InventoryPollInterval (the constant).
	InventoryPollInterval time.Duration
	// Operator readiness clock and delay can be replaced without sleeping in tests.
	now  func() time.Time
	wait func(context.Context, time.Duration) error

	mu       sync.Mutex
	inflight map[uint32]*stream
	// unsentFeatures are the operator features read for a hello no dial ever
	// carried, and unsentAt when they were read: the next session reuses them
	// within UnsentFeaturesTTL instead of reading the operator again.
	unsentFeatures []string
	unsentAt       time.Time
	// linkContext is the last link.context of any session, or zero.
	linkContext LinkContext
	// featureBound is the most feature names hello and capabilities may list,
	// as the last link.context announced it (limits.features) or as the daemon
	// restored it; zero means none is known and DefaultMaxFeatures applies.
	featureBound int
	// helloCount is how many names the hello of the current session carried,
	// zero until it is written: Run reads it to tell whether a refusal can come
	// from a list longer than every API accepts.
	helloCount int
	// pendingWSURL is the endpoint a link.context asked to move to; Run
	// applies it between two sessions. originFallback is the endpoint left
	// behind, kept until a session on the new one is confirmed;
	// originFailures counts the unconfirmed sessions since the move, and
	// originRefused remembers a target that was rolled back, so the next
	// link.context does not move there again during this process.
	pendingWSURL   string
	originFallback string
	originFailures int
	originRefused  string
	// early holds a streamed request body that arrived immediately after its
	// req control frame, before the goroutine serving that request has created
	// its pipe. The WebSocket reader is serial but serve runs asynchronously;
	// dropping such a chunk corrupts JSON requests under load or race builds.
	early    map[uint32]*earlyBody
	tails    map[string]context.CancelFunc
	operator *http.Client
	// retiring makes the session ask openedbot to revoke this runtime
	// (link.retire) and end once it confirms (link.retired), for Retire.
	retiring bool
}

// LinkContext is the last context openedbot sent, zero until the first
// link.context frame of the process.
func (c *Client) LinkContext() LinkContext {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.linkContext
}

// FeatureBound is the most feature names the next hello, or a capabilities
// frame, may list: what openedbot announced in link.context, otherwise the
// bound every API accepts.
func (c *Client) FeatureBound() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return featureBoundOrDefault(c.featureBound)
}

// SetFeatureBound restores a bound a previous process learned, before the first
// session opens. Zero or less means none was known.
func (c *Client) SetFeatureBound(bound int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.featureBound = bound
}

// relaxFeatureBound forgets the announced bound after a refusal that can come
// from it. It reports how many names the refused hello carried and whether
// that was more than DefaultMaxFeatures: only then can a bound openedbot no
// longer honors (an API rolled back, an older instance behind the same name)
// be the reason, and the next hello must fit what every API accepts.
func (c *Client) relaxFeatureBound() (listed int, relaxed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.helloCount <= DefaultMaxFeatures {
		return c.helloCount, false
	}
	c.featureBound = 0
	return c.helloCount, true
}

func (c *Client) noteHelloFeatures(count int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.helloCount = count
}

// logDroppedFeatures says which names a bound took out of a list, so a
// capability that does not show up in openedbot is explained by the journal.
func (c *Client) logDroppedFeatures(frame string, bound int, dropped []string) {
	if len(dropped) == 0 {
		return
	}
	shown, more := dropped, ""
	if len(shown) > 8 {
		shown, more = shown[:8], fmt.Sprintf(" and %d more", len(dropped)-8)
	}
	c.Logf("%s capped at %d feature names: dropped %s%s", frame, bound, strings.Join(shown, ", "), more)
}

// Features is what hello announces, computed when the session opens.
//
// The list is READ FROM the operator rather than assumed here: an operator
// that could not install its interpreter program serves the provider verbs and
// nothing else, and openedbot must not render a toolset toggle whose write
// would fail. A socket that answers nothing usable still announces the two
// provider features, which every operator has served since the link existed.
func (c *Client) Features() []string {
	if !c.operatorAvailable() {
		return nil
	}
	announced := c.operatorFeatures()
	if len(announced) == 0 {
		return []string{FeatureProviderManagement, FeatureProviderUsage}
	}
	return announced
}

// operatorFeatures reads GET /capabilities on the operator socket. Every
// failure (dial, status, body, an unknown name) yields nil, and the caller
// falls back to the provider pair.
func (c *Client) operatorFeatures() []string {
	features, _ := c.readOperatorFeatures(context.Background())
	return features
}

func (c *Client) readOperatorFeatures(parent context.Context) ([]string, bool) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", "http://hermes-operator/capabilities", nil)
	if err != nil {
		return nil, false
	}
	resp, err := c.operatorClient().Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxTextFrame))
	if err != nil {
		return nil, false
	}
	var doc struct {
		Features []string `json:"features"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, false
	}
	out := make([]string, 0, len(doc.Features))
	for _, name := range doc.Features {
		if featureRe.MatchString(name) {
			out = append(out, name)
		}
	}
	return out, true
}

func (c *Client) operatorAvailable() bool {
	if c.OperatorSocket == "" {
		return false
	}
	st, err := os.Stat(c.OperatorSocket)
	return err == nil && st.Mode()&os.ModeSocket != 0
}

func (c *Client) operatorClient() *http.Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.operator == nil {
		socket := c.OperatorSocket
		// Bounded: an API-key add may take up to 2 min in the CLI, a poll
		// answers at once; a hung operator must not pin a link slot forever.
		c.operator = &http.Client{Timeout: 150 * time.Second, Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socket)
			},
		}}
	}
	return c.operator
}

type stream struct {
	cancel context.CancelFunc
	body   *io.PipeWriter
}

type earlyBody struct {
	data   []byte
	ended  bool
	tooBig bool
}

// Bounds of the link, from docs/CONNECTOR.md. Without them a link that a
// NAT dropped silently stays "up" forever, and a slow gateway route pins one
// of the 64 in-flight slots until the process is restarted.
const (
	// PingInterval is how often an application-level WebSocket ping is sent.
	PingInterval = 15 * time.Second
	// PongTimeout bounds the wait for its pong before the session is cut.
	PongTimeout = 30 * time.Second
	// FirstResponseTimeout bounds `req` → first `res` on a non-events route.
	FirstResponseTimeout = 60 * time.Second
	// EventsIdleTimeout bounds silence on an events stream.
	EventsIdleTimeout = 15 * time.Minute
	// PoPWindow is how long a session waits for link.challenge before
	// treating the broker as one that predates proof of possession.
	PoPWindow = 10 * time.Second
)

// New returns a client with sane defaults.
func New(wsURL string, auth Auth, gateway, bearer string, journal *Journal) *Client {
	return &Client{
		WSURL: wsURL, Auth: auth, Gateway: gateway, Bearer: bearer, Journal: journal,
		Agent: "edge-setup", now: time.Now, wait: waitOperatorRetry,
		// No overall client timeout: an events stream is long-lived. The
		// bound that matters is the time to the response header.
		HTTP: &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: FirstResponseTimeout}},
		Logf: func(string, ...any) {}, Health: func(string, bool) {}, Dial: websocket.Dial,
		PingInterval: PingInterval, PongTimeout: PongTimeout, IdleTimeout: EventsIdleTimeout, PoPWindow: PoPWindow,
		inflight: map[uint32]*stream{}, early: map[uint32]*earlyBody{}, tails: map[string]context.CancelFunc{},
	}
}

// dialHTTPClient is the client behind the WebSocket upgrade toward
// openedbot. TLS 1.3 is the floor: a public proxy that only offers 1.2
// (or a downgrade in the path) refuses the link rather than weakening it. A
// ws:// loopback URL (development tunnel) never reaches TLS and is unaffected.
func dialHTTPClient() *http.Client { return dialHTTPClientWithRoots(nil) }

// dialHTTPClientWithRoots lets a test trust its own server certificate; a nil
// pool means the system roots, which is what production uses.
func dialHTTPClientWithRoots(roots *x509.CertPool) *http.Client {
	return &http.Client{Transport: &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots},
		TLSHandshakeTimeout: 15 * time.Second,
	}}
}

// A healthy session retires old incident backoff. Requiring sustained activity
// avoids reconnect storms when a flapping peer sends one frame then closes.
func reconnectBackoff(previous, healthyFor time.Duration) time.Duration {
	if healthyFor >= 30*time.Second {
		return time.Second
	}
	return previous
}

// LoopbackRefusedBackoff caps the reconnect delay while the openedbot
// origin is this host's own loopback and the dial is refused. That origin is
// a development tunnel (`make link-dev-up`): a refused dial costs nothing on
// either side and only says the tunnel is down. Measured 2026-10-06 on
// the lab runtime: at the 60 s cap, the link came back 33 s after the tunnel
// had reopened. A public origin keeps the full incident backoff.
const LoopbackRefusedBackoff = 2 * time.Second

// UnsentFeaturesTTL bounds how long the features read for a hello that never
// left (its dial failed) stand in for a fresh read. Reading them asks the
// operator for /capabilities, which runs a Python probe on the host: a dev
// tunnel that stays down redialed every LoopbackRefusedBackoff and kept about
// twenty of them a minute running on a two-core lab host (2026-10-21), which
// slowed every console read of that host. Same bound as the operator's read
// cache: a hello never carries features older than a cached read would.
const UnsentFeaturesTTL = time.Minute

// LoopbackDownLimit is how long a loopback origin may refuse every dial, with
// no session confirmed in between, before Run gives up with ErrOriginDown.
const LoopbackDownLimit = time.Minute

// gatewayDialRefused reports a request that failed because the gateway
// refused the TCP connection: the dial failed, so nothing was sent.
func gatewayDialRefused(err error) bool {
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Op == "dial" && errors.Is(err, syscall.ECONNREFUSED)
}

// operatorDialFailed reports a failure to connect to the operator's socket
// (missing, refused, or cancelled before connecting): no byte of the request
// was written.
func operatorDialFailed(err error) bool {
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Op == "dial"
}

// loopbackRefusal reports a connection refused by a loopback openedbot
// origin: the only failure the short LoopbackRefusedBackoff applies to.
func loopbackRefusal(wsURL string, err error) bool {
	if err == nil {
		return false
	}
	u, parseErr := url.Parse(wsURL)
	if parseErr != nil {
		return false
	}
	host := u.Hostname()
	if host != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return false
		}
	}
	return errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(err.Error(), "connection refused")
}

// MaxLinkRefusals is how many refusals in a row (HTTP 401/403 on the
// upgrade, close 4401) the connector accepts at its incident pace. Past it
// the link is reported refused (OnLinkRefused) and retried only every
// RefusedRetryInterval: a deleted runtime or a replaced token does not heal
// by knocking, but a refusal caused on the openedbot side (a faulty
// deployment, a restored database) does, and a stopped unit never saw it.
// Network failures never count.
const MaxLinkRefusals = 10

// RefusedRetryInterval is the pace of a link refused MaxLinkRefusals times in
// a row, until a session is confirmed or `edge-setup link` restarts it.
const RefusedRetryInterval = 30 * time.Minute

// ErrLinkRefused ends Run when openedbot revoked the link (close 4004).
// The daemon exits with a status systemd does not restart.
var ErrLinkRefused = errors.New("link refused by openedbot")

// ErrOriginDown stops Run when a loopback origin stayed unreachable for
// LoopbackDownLimit: the dev tunnel behind it is gone, and knocking it every
// LoopbackRefusedBackoff only spends the host. A public origin never stops:
// an openedbot outage must heal without anyone on the host.
var ErrOriginDown = errors.New("openedbot origin unreachable")

// errHandshakeRefused marks a WebSocket upgrade answered 401 or 403.
var errHandshakeRefused = errors.New("handshake refused")

// errOriginMoved ends a session whose link.context announced a new origin:
// Run persists it and dials it at once.
var errOriginMoved = errors.New("openedbot announced a new origin")

// MaxOriginMoveFailures is how many sessions in a row may fail on a moved
// origin, none of them confirmed, before the connector moves back.
const MaxOriginMoveFailures = 3

// MovedWSURL is the link endpoint to adopt when openedbot announces
// origin `openedbot` (link.context) while the connector dials `current`. Only a
// production link moves, and only within one domain:
//   - both sides are HTTPS (`wss://` dialled, `https://` announced, no path,
//     no port change), so a development tunnel never moves;
//   - one host is a dot-suffix of the other (console.openedbot.app and
//     openedbot.app): an openedbot can rename itself under the domain it
//     already answers on, never send a host to another domain.
//
// The token, the runtime and the device key do not change: the proof of the
// next session names the new endpoint, which the server accepts as its
// public origin.
func MovedWSURL(current, openedbot string) (string, bool) {
	cur, err := url.Parse(current)
	if err != nil || cur.Scheme != "wss" || cur.Path != RuntimeLinkWSPath || cur.RawQuery != "" {
		return "", false
	}
	next, err := url.Parse(strings.TrimRight(openedbot, "/"))
	if err != nil || next.Scheme != "https" || next.Path != "" || next.RawQuery != "" || next.User != nil || next.Port() != cur.Port() {
		return "", false
	}
	from, to := strings.ToLower(cur.Hostname()), strings.ToLower(next.Hostname())
	if from == to || net.ParseIP(to) != nil || net.ParseIP(from) != nil {
		return "", false
	}
	shorter := to
	if len(from) < len(to) {
		shorter = from
	}
	if strings.Count(shorter, ".") < 1 || (!strings.HasSuffix(from, "."+to) && !strings.HasSuffix(to, "."+from)) {
		return "", false
	}
	return "wss://" + next.Host + RuntimeLinkWSPath, true
}

// RuntimeLinkWSPath is the only broker path a link targets.
const RuntimeLinkWSPath = "/api/runtime-links/ws"

// afterSession applies what a session decided about the origin: a requested
// move (persisted first, then dialled), the confirmation that retires the
// previous origin, or the rollback after MaxOriginMoveFailures unconfirmed
// sessions. It reports whether Run should redial at once.
func (c *Client) afterSession(err error, confirmed bool) bool {
	if errors.Is(err, errOriginMoved) && c.pendingWSURL != "" {
		target := c.pendingWSURL
		c.pendingWSURL = ""
		if c.OnOriginMoved == nil {
			return false
		}
		if perr := c.OnOriginMoved(target); perr != nil {
			c.Logf("link origin %s not persisted (%v); staying on %s", target, perr, c.WSURL)
			c.originRefused = target
			return true
		}
		c.Logf("link origin moved: %s -> %s; the previous one is kept until a session is confirmed", c.WSURL, target)
		c.originFallback, c.originFailures = c.WSURL, 0
		c.WSURL = target
		return true
	}
	if c.originFallback == "" {
		return false
	}
	if confirmed {
		c.Logf("link origin %s confirmed; %s retired", c.WSURL, c.originFallback)
		c.originFallback, c.originFailures = "", 0
		return false
	}
	c.originFailures++
	if c.originFailures < MaxOriginMoveFailures {
		return false
	}
	back := c.originFallback
	if c.OnOriginMoved != nil {
		if perr := c.OnOriginMoved(back); perr != nil {
			c.Logf("link origin rollback to %s not persisted: %v", back, perr)
		}
	}
	c.Logf("link origin %s failed %d times without a confirmed session; back to %s", c.WSURL, c.originFailures, back)
	c.originRefused = c.WSURL
	c.WSURL = back
	c.originFallback, c.originFailures = "", 0
	return true
}

// Run keeps the link up until ctx ends, reconnecting with backoff.
func (c *Client) Run(ctx context.Context) error {
	backoff := time.Second
	refusals := 0
	// downSince is when the loopback origin started refusing every dial; zero
	// while it answers or when the origin is public.
	var downSince time.Time
	for {
		var confirmedAt time.Time
		err := c.session(ctx, func() {
			confirmedAt = c.now()
			if c.OnLinkUp != nil {
				c.OnLinkUp()
			}
		})
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !confirmedAt.IsZero() {
			backoff = reconnectBackoff(backoff, c.now().Sub(confirmedAt))
			refusals = 0
		}
		if c.afterSession(err, !confirmedAt.IsZero()) {
			backoff = time.Second
			continue
		}
		c.reportHealth("link", false, err)
		refused := errors.Is(err, errHandshakeRefused)
		var ce websocket.CloseError
		if errors.As(err, &ce) {
			switch ce.Code {
			case CloseRevoked:
				return fmt.Errorf("%w: link revoked (%s); run `edge-setup link` with a new ticket", ErrLinkRefused, ce.Reason)
			case CloseUnauth:
				refused = true
				// No frame came back: the broker refused this hello. If it listed
				// more names than every API accepts, the bound it relied on may be
				// stale, so the next one fits the default.
				if confirmedAt.IsZero() {
					if listed, relaxed := c.relaxFeatureBound(); relaxed {
						c.Logf("hello of %d feature names refused (close %d): back to %d names until openedbot announces another bound", listed, CloseUnauth, DefaultMaxFeatures)
					}
				}
			case CloseReconnect:
				// openedbot saw this session dead and asked for a fresh one:
				// the incident backoff has nothing to protect against here.
				backoff = time.Second
			}
		}
		if loopbackRefusal(c.WSURL, err) {
			if downSince.IsZero() || !confirmedAt.IsZero() {
				downSince = c.now()
			} else if down := c.now().Sub(downSince); down >= LoopbackDownLimit {
				return fmt.Errorf("%w: %s refused every dial for %s (dev tunnel down); `make link-dev-up` restarts this connector", ErrOriginDown, c.WSURL, down.Round(time.Second))
			}
			if backoff > LoopbackRefusedBackoff {
				backoff = LoopbackRefusedBackoff
			}
		} else {
			downSince = time.Time{}
		}
		delay := backoff
		if refused {
			refusals++
			if refusals >= MaxLinkRefusals {
				delay = RefusedRetryInterval
				if refusals == MaxLinkRefusals && c.OnLinkRefused != nil {
					c.OnLinkRefused(fmt.Errorf("%w %d times in a row (last: %v); retrying every %s", ErrLinkRefused, refusals, err, RefusedRetryInterval))
				}
				c.Logf("link refused %d times in a row: %v; retrying in %s (`edge-setup link` with a new ticket if the runtime was deleted)", refusals, err, delay)
			} else {
				c.Logf("link refused (%d/%d): %v; reconnecting in %s", refusals, MaxLinkRefusals, err, delay)
			}
		} else {
			c.Logf("link lost: %v; reconnecting in %s", err, delay)
		}
		jitter := time.Duration(rand.Int63n(int64(delay) / 5))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay + jitter - delay/10):
		}
		backoff *= 2
		if backoff > 60*time.Second {
			backoff = 60 * time.Second
		}
	}
}

// waitOperatorRetry is cancellable both before hello and during late recovery.
func waitOperatorRetry(ctx context.Context, delay time.Duration) error {
	t := time.NewTimer(delay)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// reuseUnsentFeatures returns the features read for a hello that was never
// written, while they are younger than UnsentFeaturesTTL, else nil.
func (c *Client) reuseUnsentFeatures() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.unsentFeatures) == 0 || c.now().Sub(c.unsentAt) >= UnsentFeaturesTTL {
		return nil
	}
	return append([]string(nil), c.unsentFeatures...)
}

// keepUnsentFeatures records features about to go into hello, or forgets them
// (nil) once hello is written. An empty read is never kept: an operator that
// did not answer is asked again by the next session.
func (c *Client) keepUnsentFeatures(features []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(features) == 0 {
		c.unsentFeatures, c.unsentAt = nil, time.Time{}
		return
	}
	c.unsentFeatures, c.unsentAt = append([]string(nil), features...), c.now()
}

func (c *Client) helloFeatures(ctx context.Context) []string {
	if c.OperatorSocket == "" {
		return nil
	}
	deadline := c.now().Add(15 * time.Second)
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	for {
		if features, ok := c.readOperatorFeatures(probeCtx); ok {
			c.reportHealth("operator", true, nil)
			c.Logf("operator ready: %d features read for hello", len(features))
			return features
		}
		remaining := deadline.Sub(c.now())
		if remaining <= 0 || probeCtx.Err() != nil {
			break
		}
		if c.wait(probeCtx, min(500*time.Millisecond, remaining)) != nil {
			break
		}
	}
	if ctx.Err() == nil {
		c.reportHealth("operator", false, nil)
		c.Logf("operator unavailable after 15s: sending hello without features; watching for recovery")
	}
	return nil
}

// OperatorRefreshInterval is how often a connected link reads the operator's
// features again. Some of them are states that change while the link stays up
// (auto_upgrade when the timer is enabled or disabled); a list that changed is
// sent in a capabilities frame, an unchanged one sends nothing.
const OperatorRefreshInterval = 5 * time.Minute

// sendCapabilities announces operator features on the existing link, under
// the bound in force now, not the one hello was built with: a link.context
// may have raised it since.
func (c *Client) sendCapabilities(send func(websocket.MessageType, []byte) error, features []string) error {
	bound := c.FeatureBound()
	kept, dropped := announceFeatures(nil, features, bound)
	c.logDroppedFeatures("capabilities", bound, dropped)
	frame, err := EncodeText(Text{T: TCapabilities, Features: kept})
	if err != nil {
		return err
	}
	return send(websocket.MessageText, frame)
}

// watchOperator waits for an operator that hello found unavailable, announces
// its features and returns them; nil once ctx ends first.
func (c *Client) watchOperator(ctx context.Context, send func(websocket.MessageType, []byte) error) []string {
	for c.wait(ctx, 500*time.Millisecond) == nil {
		if features, ok := c.readOperatorFeatures(ctx); ok && len(features) > 0 {
			c.reportHealth("operator", true, nil)
			if err := c.sendCapabilities(send, features); err != nil {
				if ctx.Err() == nil {
					c.Logf("operator capabilities update failed; retrying on the existing link")
				}
				continue
			}
			c.Logf("operator recovered: capabilities updated on the existing link")
			return features
		}
	}
	return nil
}

// followOperator keeps the capabilities of this link in step with the
// operator for as long as the session lasts. announced is what hello carried
// (empty when the operator did not answer). A failed read keeps the last list:
// an operator that restarts does not withdraw features for a few seconds.
func (c *Client) followOperator(ctx context.Context, send func(websocket.MessageType, []byte) error, announced []string) {
	if len(announced) == 0 {
		if announced = c.watchOperator(ctx, send); announced == nil {
			return
		}
	}
	for c.wait(ctx, OperatorRefreshInterval) == nil {
		features, ok := c.readOperatorFeatures(ctx)
		if !ok || len(features) == 0 || sameFeatureSet(features, announced) {
			continue
		}
		if err := c.sendCapabilities(send, features); err != nil {
			if ctx.Err() == nil {
				c.Logf("operator capabilities update failed; retrying at the next refresh")
			}
			continue
		}
		announced = features
		c.Logf("operator features changed: capabilities updated on the existing link")
	}
}

func sameFeatureSet(a, b []string) bool {
	x, y := slices.Clone(a), slices.Clone(b)
	slices.Sort(x)
	slices.Sort(y)
	return slices.Equal(x, y)
}

// linkFeatures are what the link itself adds to hello, independent of the
// operator: they never enter the capabilities frame. LinkFeatures lists every
// name this can return.
func (c *Client) linkFeatures() []string {
	if c.CreationAudit == nil {
		return nil
	}
	return []string{FeatureCreationAuditV2}
}

// armAudit decodes an audit.key frame and opens the sealed file with it.
func (c *Client) armAudit(f Text) error {
	master, err := base64.StdEncoding.DecodeString(f.Key)
	if err != nil {
		return err
	}
	previous := map[string][]byte{}
	for _, prior := range f.Previous {
		key, err := base64.StdEncoding.DecodeString(prior.Key)
		if err != nil {
			return err
		}
		previous[prior.KeyID] = key
	}
	return c.CreationAudit.Arm(f.KeyID, master, previous)
}

// streamAnchors forwards every audit anchor of this session, in order, and
// resends the current position first so openedbot learns where the file
// stands after a reconnection. The sink never blocks a write: a full queue
// drops the oldest anchor, which the next one supersedes.
func (c *Client) streamAnchors(ctx context.Context, send sender) func() {
	queue := make(chan AuditAnchor, 64)
	push := func(anchor AuditAnchor) {
		for {
			select {
			case queue <- anchor:
				return
			default:
				select {
				case <-queue:
				default:
				}
			}
		}
	}
	c.CreationAudit.SetAnchorSink(push)
	if anchor, ok := c.CreationAudit.Anchor(); ok {
		push(anchor)
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case anchor := <-queue:
				frame, err := EncodeText(Text{T: TAuditAnchor, RuntimeID: c.Auth.RuntimeID, KeyID: anchor.KeyID, WriteSeq: anchor.WriteSeq, Count: anchor.Count, Dropped: anchor.Dropped, Tail: anchor.Tail})
				if err == nil {
					err = send(websocket.MessageText, frame)
				}
				if err != nil && ctx.Err() == nil {
					c.Logf("audit anchor could not be sent; the next session resends the current position")
				}
			}
		}
	}()
	return func() { c.CreationAudit.SetAnchorSink(nil) }
}

// Session runs one connection to its end. During enrollment it returns nil
// once link.issued has been persisted.
func (c *Client) Session(ctx context.Context) error {
	return c.session(ctx, nil)
}

// Retire opens one session, proves possession like any reconnection, then
// asks openedbot to revoke this runtime (link.retire, repeated every two
// seconds until answered: the broker ignores it until the link is admitted)
// and returns nil once link.retired names this runtime. Requests received
// meanwhile are refused before dispatch. The caller bounds ctx: an older
// openedbot never answers, or closes the link on the unknown frame.
func (c *Client) Retire(ctx context.Context) error {
	if c.Auth.EnrollmentTicket != "" || c.Auth.RuntimeID == "" {
		return errors.New("retire needs a linked runtime")
	}
	c.retiring = true
	defer func() { c.retiring = false }()
	return c.session(ctx, nil)
}

// askRetire sends link.retire now and every two seconds until ctx ends.
func (c *Client) askRetire(ctx context.Context, send func(websocket.MessageType, []byte) error) {
	frame, err := EncodeText(Text{T: TLinkRetire})
	if err != nil {
		return
	}
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			if err := send(websocket.MessageText, frame); err != nil {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

// devicePublicKey renders hello.devicePublicKey, empty without a key.
func (c *Client) devicePublicKey() string {
	if c.DeviceKey == nil {
		return ""
	}
	return enroll.DevicePublicKey(c.DeviceKey)
}

func (c *Client) session(ctx context.Context, onConfirmed func()) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	features := c.reuseUnsentFeatures()
	if features == nil {
		features = c.helloFeatures(ctx)
		c.keepUnsentFeatures(features)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// The list is cut here, link features counted, never earlier: an API at the
	// bound closes 4401 on one name more, and the host reads that as a refusal.
	bound := c.FeatureBound()
	announced, dropped := announceFeatures(c.linkFeatures(), features, bound)
	// No hello feature for this: hello is bounded, and a link feature would
	// push an operator capability out for an API that announced no bound.
	// openedbot learns that this host watches from the first inventory.changed
	// of the session. Enrollment and retirement never watch.
	watchInventory := c.Auth.EnrollmentTicket == "" && !c.retiring && c.operatorAvailable()
	c.logDroppedFeatures("hello", bound, dropped)
	c.noteHelloFeatures(0)
	// One endpoint per session: the dial and the proof must name the same.
	wsURL := c.WSURL
	conn, resp, err := c.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPClient:   dialHTTPClient(),
		HTTPHeader:   http.Header{"Authorization": {c.Auth.header()}, "User-Agent": {c.Agent}},
		Subprotocols: []string{"hermes-connector.v1"},
	})
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			err = fmt.Errorf("%w (HTTP %d): %w", errHandshakeRefused, resp.StatusCode, err)
		}
		return reportableError(fmt.Errorf("dial: %w", err), "LINK_DIAL_FAILED")
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")
	conn.SetReadLimit(MaxResponseBody + 4)
	hello, err := EncodeText(Text{T: THello, Protocol: Protocol, Agent: c.Agent, HermesVersion: c.HermesVersion, Features: announced, DevicePublicKey: c.devicePublicKey()})
	if err != nil {
		return err
	}
	if err := conn.Write(ctx, websocket.MessageText, hello); err != nil {
		return err
	}
	c.noteHelloFeatures(len(announced))
	c.keepUnsentFeatures(nil)
	var wmu sync.Mutex
	send := func(kind websocket.MessageType, b []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
		defer wcancel()
		return conn.Write(wctx, kind, b)
	}
	if c.OperatorSocket != "" {
		go c.followOperator(ctx, send, features)
	}
	var stopAnchors func()
	defer func() {
		if stopAnchors != nil {
			stopAnchors()
		}
	}()
	defer c.abortAll()
	// Keepalive: a dropped NAT mapping produces no read error, so without a
	// ping the link stays "connected" and unreachable. A missed pong cancels
	// the session and Run reconnects with its backoff.
	if c.PingInterval > 0 {
		go func() {
			t := time.NewTicker(c.PingInterval)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					pctx, pcancel := context.WithTimeout(ctx, c.PongTimeout)
					err := conn.Ping(pctx)
					pcancel()
					if err != nil {
						if ctx.Err() == nil {
							c.Logf("no pong within %s: dropping the link", c.PongTimeout)
						}
						cancel(reportableError(err, "LINK_PONG_TIMEOUT"))
						return
					}
				}
			}
		}()
	}
	confirmed := false
	inventoryWatchStarted := false
	// Proof of possession: until the broker challenges (or PoPWindow passes
	// without a challenge, older broker), no request is dispatched.
	popStart, proved, popSkipped := c.now(), false, false
	// Unsolicited frames (audit anchors, pending diagnostics) go out only once
	// the broker can take them: a gateway that challenged refuses any frame but
	// link.proof and closes 4401. An armed audit resends its anchor at once, so
	// every reconnection of a running connector failed the proof. Without a
	// device key, or while enrolling, there is no proof to wait for; an older
	// broker that never challenges gets them once PoPWindow has passed.
	unsolicitedStarted := false
	startUnsolicited := func() {
		if unsolicitedStarted {
			return
		}
		unsolicitedStarted = true
		if c.retiring {
			// A retiring host only asks to be revoked: no anchor, no
			// diagnostic, no request served.
			c.askRetire(ctx, send)
			return
		}
		if c.CreationAudit != nil {
			stopAnchors = c.streamAnchors(ctx, send)
		}
		if c.Diagnostics != nil && c.Auth.EnrollmentTicket == "" {
			go c.sendDiagnostics(ctx, send)
		}
	}
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			if cause := context.Cause(ctx); cause != nil {
				return cause
			}
			code := "LINK_CLOSED"
			if errors.Is(err, io.EOF) {
				code = "LINK_EOF"
			}
			return reportableError(err, code)
		}
		if !confirmed {
			c.reportHealth("link", true, nil)
			c.Logf("link active: broker frame received")
			confirmed = true
			if onConfirmed != nil {
				onConfirmed()
			}
		}
		if c.DeviceKey == nil || c.Auth.EnrollmentTicket != "" || proved || c.now().Sub(popStart) >= c.PoPWindow {
			startUnsolicited()
		}
		if kind == websocket.MessageBinary {
			id, chunk, err := DecodeBinary(data)
			if err != nil {
				continue
			}
			c.feedBody(id, chunk)
			continue
		}
		f, err := DecodeText(data)
		if err != nil {
			c.Logf("ignoring frame: %v", err)
			continue
		}
		switch f.T {
		case TDiagnosticAck:
			if c.Diagnostics != nil {
				if err := c.Diagnostics.Ack(f.EventID); err != nil {
					c.Logf("diagnostic acknowledgment could not be persisted; retry pending")
				}
			}
		case TPing:
			b, _ := EncodeText(Text{T: TPong})
			_ = send(websocket.MessageText, b)
		case TPong:
		case TLinkIssued:
			if c.OnLinkIssued == nil {
				return errors.New("unexpected link.issued outside enrollment")
			}
			if err := c.OnLinkIssued(f.RuntimeID, f.LinkToken); err != nil {
				return err
			}
			return nil
		case TAuditKey:
			if c.CreationAudit == nil || c.Auth.EnrollmentTicket != "" {
				continue
			}
			if f.RuntimeID != c.Auth.RuntimeID {
				return fmt.Errorf("audit.key runtime %q does not match this runtime", f.RuntimeID)
			}
			if err := c.armAudit(f); err != nil {
				// Fail closed, keep the link: reads still work, creations are
				// refused with AUDIT_KEY_MISSING until a key opens the file.
				c.Logf("creation audit could not be armed: %v; creations are refused", err)
				continue
			}
			c.Logf("creation audit armed under key %s", f.KeyID)
		case TLinkChallenge:
			if c.DeviceKey == nil {
				c.Logf("link.challenge received but this host has no device key; run `edge-setup up --yes` to seal one, or re-link this host with a new ticket if openedbot already holds a key for this runtime")
				continue
			}
			nonce, err := enroll.ParsePoPNonce(f.Nonce)
			if err != nil {
				return err
			}
			proof, err := EncodeText(Text{T: TLinkProof, Signature: enroll.SignPoP(c.DeviceKey, nonce, c.Auth.RuntimeID, wsURL)})
			if err != nil {
				return err
			}
			if err := send(websocket.MessageText, proof); err != nil {
				return err
			}
			proved = true
			startUnsolicited()
			c.Logf("proof of possession sent")
			continue
		case TLinkRotate:
			if c.Auth.EnrollmentTicket != "" || c.Auth.RuntimeID == "" {
				return errors.New("unexpected link.rotate during enrollment")
			}
			if f.RuntimeID != c.Auth.RuntimeID {
				return fmt.Errorf("link.rotate runtime %q does not match this runtime", f.RuntimeID)
			}
			if c.OnLinkRotated == nil {
				return errors.New("link.rotate received without a persistence handler")
			}
			if err := c.OnLinkRotated(f.RuntimeID, f.LinkToken); err != nil {
				return fmt.Errorf("persist rotated link token: %w", err)
			}
			// Change the in-memory credential only after the durable write. Run's
			// next Session then authenticates with the same token a restart reads.
			c.Auth.LinkToken = f.LinkToken
		case TLinkContext:
			lc := LinkContext{Environment: f.Environment, Openedbot: f.Openedbot}
			if f.Organization != nil {
				lc.Organization = *f.Organization
			}
			if f.Owner != nil {
				lc.Owner = *f.Owner
			}
			// The last announcement wins: a frame without limits sends the host
			// back to DefaultMaxFeatures, as an API that never announces one.
			if f.Limits != nil && f.Limits.Features != nil {
				lc.FeatureLimit = *f.Limits.Features
			}
			c.mu.Lock()
			announcedBefore := c.featureBound
			c.linkContext = lc
			c.featureBound = lc.FeatureLimit
			c.mu.Unlock()
			if lc.FeatureLimit != announcedBefore {
				if lc.FeatureLimit == 0 {
					c.Logf("feature bound: openedbot announced none, hello and capabilities stay within %d names", DefaultMaxFeatures)
				} else {
					c.Logf("feature bound: openedbot accepts %d names in hello and capabilities", featureBoundOrDefault(lc.FeatureLimit))
				}
			}
			if c.OnLinkContext != nil {
				if err := c.OnLinkContext(lc); err != nil {
					c.Logf("link context could not be persisted: %v; kept in memory", err)
				}
			}
			c.Logf("link context: environment=%s openedbot=%s owner=%s", lc.Environment, lc.Openedbot, lc.Owner.Email)
			// Only an openedbot that lists inventory.changed may receive it:
			// an older one closes the link on an unknown frame type.
			if watchInventory && !inventoryWatchStarted && acceptsInventoryChanged(f) {
				inventoryWatchStarted = true
				go c.watchInventory(ctx, send)
			}
			if c.Auth.EnrollmentTicket == "" && c.OnOriginMoved != nil && c.originFallback == "" {
				if moved, ok := MovedWSURL(wsURL, lc.Openedbot); ok && moved != c.originRefused {
					c.pendingWSURL = moved
					return errOriginMoved
				}
			}
		case TLinkRetired:
			if c.retiring && f.RuntimeID == c.Auth.RuntimeID {
				c.Logf("openedbot revoked runtime %s at this host's request", f.RuntimeID)
				return nil
			}
		case TReq:
			if c.retiring {
				c.sendErr(send, f.ID, "HOST_RETIRING", "this host is leaving openedbot", StageBeforeDispatch)
				continue
			}
			// An enrollment session is never challenged: the runtime does not
			// exist yet, and the enrollment itself registers the key carried
			// by hello. Holding its probe back would refuse every enrollment
			// made with a device key (LINK_POP_PENDING -> LINK_PROBE_FAILED).
			if c.DeviceKey != nil && !proved && c.Auth.EnrollmentTicket == "" {
				if c.now().Sub(popStart) < c.PoPWindow {
					c.sendErr(send, f.ID, "LINK_POP_PENDING", "proof of possession not yet exchanged", StageBeforeDispatch)
					continue
				}
				if !popSkipped {
					popSkipped = true
					c.Logf("pop not requested: openedbot did not challenge within %s; continuing without proof of possession", c.PoPWindow)
				}
			}
			c.noteRequest(f)
			go c.serve(ctx, f, send)
		case TEnd:
			c.endBody(f.ID)
		case TCancel:
			c.cancel(f.ID)
		case TErr:
			c.cancel(f.ID)
		}
	}
}

func (c *Client) feedBody(id uint32, chunk []byte) {
	c.mu.Lock()
	s := c.inflight[id]
	if s == nil {
		if early := c.early[id]; early != nil {
			if len(early.data)+len(chunk) > MaxRequestBody {
				early.tooBig = true
			} else if !early.tooBig {
				early.data = append(early.data, chunk...)
			}
		}
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	if s.body != nil {
		_, _ = s.body.Write(chunk)
	}
}

func (c *Client) endBody(id uint32) {
	c.mu.Lock()
	s := c.inflight[id]
	if s == nil {
		if early := c.early[id]; early != nil {
			early.ended = true
		}
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	if s.body != nil {
		_ = s.body.Close()
	}
}

// noteRequest reserves bounded pre-pipe storage only for a streamed body.
// A binary frame without a preceding allowed stream has nowhere to land.
func (c *Client) noteRequest(f Text) {
	if f.Body != "stream" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.inflight[f.ID]; !exists {
		if _, exists := c.early[f.ID]; !exists {
			c.early[f.ID] = &earlyBody{}
		}
	}
}

func (c *Client) dropEarly(id uint32) {
	c.mu.Lock()
	delete(c.early, id)
	c.mu.Unlock()
}

func (c *Client) cancel(id uint32) {
	c.mu.Lock()
	s := c.inflight[id]
	delete(c.inflight, id)
	delete(c.early, id)
	c.mu.Unlock()
	if s != nil {
		s.cancel()
		if s.body != nil {
			_ = s.body.CloseWithError(errors.New("cancelled"))
		}
	}
}

func (c *Client) abortAll() {
	c.mu.Lock()
	ids := make([]uint32, 0, len(c.inflight))
	for id := range c.inflight {
		ids = append(ids, id)
	}
	c.mu.Unlock()
	for _, id := range ids {
		c.cancel(id)
	}
	c.mu.Lock()
	clear(c.early)
	c.mu.Unlock()
}

type sender func(websocket.MessageType, []byte) error

func (c *Client) sendErr(send sender, id uint32, code, msg, stage string) {
	b, _ := EncodeText(Text{T: TErr, ID: id, Code: code, Message: msg, Stage: stage})
	_ = send(websocket.MessageText, b)
}

// serve handles one req frame: allowlist, bearer injection, streaming.
func (c *Client) serve(parent context.Context, f Text, send sender) {
	defer c.dropEarly(f.ID)
	route := Match(f.Method, f.Path)
	if route == nil {
		c.sendErr(send, f.ID, "HERMES_LINK_PATH_FORBIDDEN", "route not in the connector allowlist", StageBeforeDispatch)
		return
	}
	trace, traced := traceOf(f.Headers)
	if traced {
		c.logRelayTrace(f, trace)
	}
	c.mu.Lock()
	if len(c.inflight) >= MaxInFlight {
		c.mu.Unlock()
		c.sendErr(send, f.ID, "LINK_BUSY", "too many requests in flight", StageBeforeDispatch)
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s := &stream{cancel: cancel}
	var bodyReader io.Reader
	var early *earlyBody
	var pipeReader *io.PipeReader
	if f.Body == "stream" {
		pipeReader, s.body = io.Pipe()
		early = c.early[f.ID]
	}
	c.inflight[f.ID] = s
	c.mu.Unlock()
	// Installed as soon as the slot is taken: every return below, the early
	// refusals included, must give it back, or MaxInFlight of them leave the
	// link answering LINK_BUSY until it reconnects.
	defer func() {
		cancel()
		if s.body != nil {
			_ = s.body.Close()
		}
		c.mu.Lock()
		delete(c.inflight, f.ID)
		c.mu.Unlock()
	}()
	if early != nil && early.tooBig {
		c.sendErr(send, f.ID, "HERMES_PROTOCOL_LIMIT", "request exceeds the stream limit", StageBeforeDispatch)
		return
	}
	if f.Body == "stream" {
		if early != nil && len(early.data) > 0 {
			bodyReader = io.LimitReader(io.MultiReader(bytes.NewReader(early.data), pipeReader), MaxRequestBody)
		} else {
			bodyReader = io.LimitReader(pipeReader, MaxRequestBody)
		}
		if early != nil && early.ended {
			_ = s.body.Close()
		}
	}
	if route.Events {
		if since, ok := replaySince(f); ok && c.Journal != nil {
			c.serveReplay(ctx, f, send, since)
			return
		}
	}
	if route.Host {
		c.serveHost(ctx, f, send, bodyReader)
		return
	}
	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(f.Method), c.Gateway+f.Path, bodyReader)
	if err != nil {
		c.sendErr(send, f.ID, "HERMES_LINK_BAD_REQUEST", err.Error(), StageBeforeDispatch)
		return
	}
	for k, v := range f.Headers {
		if name := strings.ToLower(k); ForwardedRequestHeaders[name] && name != TraceparentHeader {
			req.Header.Set(k, v)
		}
	}
	if traced {
		req.Header.Set(TraceparentHeader, trace.Header)
	}
	req.Header.Set("Authorization", "Bearer "+c.Bearer)
	req.Header.Del("Cookie")
	req.Host = ""
	var attempt CreationAuditEvent
	audited := c.CreationAudit != nil && req.Method == "POST" && strippedPath(f.Path) == "/v1/runs"
	if audited {
		attempt, err = c.CreationAudit.attempt(req)
		if errors.Is(err, ErrAuditKeyMissing) {
			c.sendErr(send, f.ID, "AUDIT_KEY_MISSING", "creation audit is enabled but the link has not provisioned its key", StageBeforeDispatch)
			return
		}
		if err != nil {
			c.sendErr(send, f.ID, "LINK_AUDIT_UNAVAILABLE", "creation audit could not persist dispatch evidence", StageBeforeDispatch)
			return
		}
	}
	dispatchClient := c.HTTP
	if audited {
		// Keep one creation dispatch per durable attempt: no redirect replay and
		// no net/http automatic replay of an empty idempotent request.
		copyClient := *c.HTTP
		copyClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
		dispatchClient = &copyClient
		req.GetBody = nil
		if req.Body == nil || req.Body == http.NoBody {
			req.Body = io.NopCloser(strings.NewReader(""))
		}
	}
	resp, err := dispatchClient.Do(req)
	if audited {
		if auditErr := c.CreationAudit.outcome(attempt, resp, err); auditErr != nil {
			c.Logf("creation audit outcome persistence failed; attempt remains unresolved")
		}
	}
	if err != nil {
		// A refused dial proves no byte reached the gateway (it is relaunching
		// after a graceful restart, or down): the platform may safely retry.
		// Any other failure may have followed the request's delivery.
		stage := StageAfterDispatch
		if gatewayDialRefused(err) {
			stage = StageBeforeDispatch
		}
		c.sendErr(send, f.ID, "HERMES_UNREACHABLE", "gateway did not answer", stage)
		return
	}
	defer resp.Body.Close()
	// Capabilities: the gateway does not know what the link adds. Rewrite
	// its JSON with the link features (docs/CONNECTOR.md); a body that is
	// not JSON is relayed untouched.
	if strippedPath(f.Path) == "/v1/capabilities" && resp.StatusCode == 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBody))
		body = InjectFeatures(body, c.Journal != nil, c.Features())
		c.relayBuffered(f, send, resp, body)
		return
	}
	c.relayStream(ctx, f, send, resp)
}

// serveHost relays one host route to hermes-operator. The operator is a
// Unix socket only root and the confined hermes connector unit can open; a missing socket
// means nothing reached the host.
func (c *Client) serveHost(ctx context.Context, f Text, send sender, bodyReader io.Reader) {
	if !c.operatorAvailable() {
		c.sendErr(send, f.ID, "HERMES_OPERATOR_UNAVAILABLE", "the host operator is not running", StageBeforeDispatch)
		return
	}
	target, err := hostTarget(f.Path)
	if err != nil {
		c.sendErr(send, f.ID, "HERMES_LINK_BAD_REQUEST", err.Error(), StageBeforeDispatch)
		return
	}
	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(f.Method), target, bodyReader)
	if err != nil {
		c.sendErr(send, f.ID, "HERMES_LINK_BAD_REQUEST", err.Error(), StageBeforeDispatch)
		return
	}
	for k, v := range f.Headers {
		if strings.EqualFold(k, "content-type") || strings.EqualFold(k, "accept") || strings.EqualFold(k, "cache-control") {
			req.Header.Set(k, v)
		}
	}
	resp, err := c.operatorClient().Do(req)
	if err != nil {
		// Only a failed dial proves the operator never saw the request. A
		// connection that broke afterwards may follow a mutation the operator
		// already applied: the platform must not replay it as unsent.
		stage := StageAfterDispatch
		if operatorDialFailed(err) {
			stage = StageBeforeDispatch
		}
		c.sendErr(send, f.ID, "HERMES_OPERATOR_UNAVAILABLE", "the host operator did not answer", stage)
		return
	}
	defer resp.Body.Close()
	c.relayStream(ctx, f, send, resp)
}

// hostTarget is the operator URL of a host route: the /p/<slug> prefix and the
// host prefix removed, the query KEPT.
//
// A gateway route is relayed with its own path (c.Gateway+f.Path), so it never
// lost its query. A host route went through strippedPath, which drops it, and
// that was invisible until a host route took an argument: the operator read
// `GET /hermes-setup/model-context?profile=<slug>` as an empty profile and
// answered every bot with the ROOT profile's model and context window.
//
// The query is re-parsed and re-encoded rather than concatenated: the relay
// allowlist matches on the path alone and never validated it, so a raw `#`
// would otherwise become a fragment and silently truncate the request. What
// the parameters MEAN stays the operator's business, and it validates its own
// (profile slugs are matched against PROFILE_SLUG on the host).
func hostTarget(framePath string) (string, error) {
	path, raw, _ := strings.Cut(framePath, "?")
	if m := profilePrefix.FindString(path); m != "" {
		path = path[len(m):]
	}
	query, err := url.ParseQuery(raw)
	if err != nil {
		return "", fmt.Errorf("query: %w", err)
	}
	u := url.URL{Scheme: "http", Host: "hermes-operator", Path: "/" + strings.TrimPrefix(strings.TrimPrefix(path, HostPrefix), "/"), RawQuery: query.Encode()}
	return u.String(), nil
}

// strippedPath removes the query and the optional /p/<slug> prefix.
func strippedPath(path string) string {
	p := strings.SplitN(path, "?", 2)[0]
	if m := profilePrefix.FindString(p); m != "" {
		p = p[len(m):]
	}
	return p
}

// InjectFeatures sets the capabilities added by the connector in a
// /v1/capabilities body: `event_replay` plus exactly the host features the
// operator announced in hello. Every other key is preserved, and a feature the
// operator no longer serves is removed rather than left stale.
func InjectFeatures(body []byte, replay bool, hostFeatures []string) []byte {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(body, &doc); err != nil || doc == nil {
		return body
	}
	features := map[string]json.RawMessage{}
	if raw, ok := doc["features"]; ok {
		if err := json.Unmarshal(raw, &features); err != nil || features == nil {
			features = map[string]json.RawMessage{}
		}
	}
	set := func(k string, v bool) {
		if v {
			features[k] = json.RawMessage("true")
		} else {
			delete(features, k)
		}
	}
	set("event_replay", replay)
	for _, name := range HostFeatures {
		set(name, false)
	}
	for _, name := range hostFeatures {
		if featureRe.MatchString(name) {
			set(name, true)
		}
	}
	fb, err := json.Marshal(features)
	if err != nil {
		return body
	}
	doc["features"] = fb
	out, err := json.Marshal(doc)
	if err != nil {
		return body
	}
	return out
}

func responseHeaders(resp *http.Response) map[string]string {
	headers := map[string]string{}
	for k := range resp.Header {
		if ForwardedResponseHeaders[strings.ToLower(k)] {
			headers[strings.ToLower(k)] = resp.Header.Get(k)
		}
	}
	return headers
}

func (c *Client) relayBuffered(f Text, send sender, resp *http.Response, body []byte) {
	res, _ := EncodeText(Text{T: TRes, ID: f.ID, Status: resp.StatusCode, Headers: responseHeaders(resp)})
	if err := send(websocket.MessageText, res); err != nil {
		return
	}
	if len(body) > 0 {
		_ = send(websocket.MessageBinary, EncodeBinary(f.ID, body))
	}
	end, _ := EncodeText(Text{T: TEnd, ID: f.ID})
	_ = send(websocket.MessageText, end)
}

// relayStream forwards status, headers and body chunks of resp.
func (c *Client) relayStream(ctx context.Context, f Text, send sender, resp *http.Response) {
	headers := responseHeaders(resp)
	res, _ := EncodeText(Text{T: TRes, ID: f.ID, Status: resp.StatusCode, Headers: headers})
	if err := send(websocket.MessageText, res); err != nil {
		return
	}
	// Runs: on a 2xx to POST /v1/runs, start tailing the run into the journal.
	if f.Method == "POST" && strings.HasSuffix(strings.SplitN(f.Path, "?", 2)[0], "/v1/runs") && resp.StatusCode/100 == 2 && c.Journal != nil {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBody))
		if id := runIDFrom(body); id != "" {
			c.startTail(id, profileOf(f.Path))
		}
		_ = send(websocket.MessageBinary, EncodeBinary(f.ID, body))
		end, _ := EncodeText(Text{T: TEnd, ID: f.ID})
		_ = send(websocket.MessageText, end)
		return
	}
	// An events stream that goes silent must not hold its slot forever.
	var idle *time.Timer
	if c.IdleTimeout > 0 {
		idle = time.AfterFunc(c.IdleTimeout, func() { _ = resp.Body.Close() })
		defer idle.Stop()
	}
	buf := make([]byte, 32<<10)
	var total int64
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if idle != nil {
				idle.Reset(c.IdleTimeout)
			}
			total += int64(n)
			if total > MaxResponseBody {
				c.sendErr(send, f.ID, "HERMES_PROTOCOL_LIMIT", "response exceeds the stream limit", StageAfterDispatch)
				return
			}
			if err := send(websocket.MessageBinary, EncodeBinary(f.ID, buf[:n])); err != nil {
				return
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			if ctx.Err() != nil {
				return
			}
			c.sendErr(send, f.ID, "HERMES_STREAM_INTERRUPTED", "gateway closed the stream", StageAfterDispatch)
			return
		}
	}
	end, _ := EncodeText(Text{T: TEnd, ID: f.ID})
	_ = send(websocket.MessageText, end)
}

func replaySince(f Text) (uint64, bool) {
	if v, ok := f.Headers["last-event-id"]; ok {
		if n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64); err == nil {
			return n, true
		}
	}
	for k, v := range f.Headers {
		if strings.EqualFold(k, "last-event-id") {
			if n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64); err == nil {
				return n, true
			}
		}
	}
	if i := strings.Index(f.Path, "?"); i >= 0 {
		for _, kv := range strings.Split(f.Path[i+1:], "&") {
			if k, v, ok := strings.Cut(kv, "="); ok && k == "since" {
				if n, err := strconv.ParseUint(v, 10, 64); err == nil {
					return n, true
				}
			}
		}
	}
	return 0, false
}

func runIDFrom(body []byte) string {
	var response struct {
		RunID string `json:"run_id"`
		ID    string `json:"id"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return ""
	}
	for _, id := range []string{response.RunID, response.ID} {
		if runIDRe.MatchString(id) {
			return id
		}
	}
	return ""
}

func profileOf(path string) string {
	if m := profilePrefix.FindString(path); m != "" {
		return m
	}
	return ""
}

func runIDOfPath(path string) string {
	p := strings.SplitN(path, "?", 2)[0]
	if m := profilePrefix.FindString(p); m != "" {
		p = p[len(m):]
	}
	parts := strings.Split(strings.TrimPrefix(p, "/v1/runs/"), "/")
	if len(parts) >= 1 && runIDRe.MatchString(parts[0]) {
		return parts[0]
	}
	return ""
}

// serveReplay answers an events request from the journal: entries after
// `since`, then live entries until the run is terminal.
func (c *Client) serveReplay(ctx context.Context, f Text, send sender, since uint64) {
	runID := runIDOfPath(f.Path)
	st := c.Journal.Status(runID)
	res, _ := EncodeText(Text{T: TRes, ID: f.ID, Status: 200, Headers: map[string]string{"content-type": "text/event-stream"}})
	if err := send(websocket.MessageText, res); err != nil {
		return
	}
	if !st.Exists {
		// A new run may not have emitted its first event yet. since=0 has
		// no previous cursor to lose; wait for the first numbered entry.
		// A positive cursor without its journal is an actual replay gap.
		if since > 0 {
			if err := send(websocket.MessageBinary, EncodeBinary(f.ID, []byte("event: replay-gap\ndata: {}\n\n"))); err != nil {
				return
			}
		}
		c.startTail(runID, profileOf(f.Path))
		since = 0
	} else if !st.Terminal && !st.Truncated {
		// A journal the connector filled before it restarted has no tail any
		// more: without one, nothing collects the rest of the run and this
		// replay would wait forever. startTail is a no-op when one runs.
		c.startTail(runID, profileOf(f.Path))
	}
	cursor := since
	for {
		entries, err := c.Journal.After(runID, cursor)
		if err != nil {
			c.sendErr(send, f.ID, "HERMES_STREAM_INTERRUPTED", "journal unreadable", StageAfterDispatch)
			return
		}
		for _, e := range entries {
			if err := send(websocket.MessageBinary, EncodeBinary(f.ID, SSEFrame(e))); err != nil {
				return
			}
			cursor = e.Seq
		}
		st := c.Journal.Status(runID)
		if st.Truncated {
			_ = send(websocket.MessageBinary, EncodeBinary(f.ID, []byte("event: journal-truncated\ndata: {}\n\n")))
			break
		}
		if st.Terminal && st.Seq <= cursor {
			break
		}
		if !c.Journal.Wait(runID, cursor, ctx.Done()) && ctx.Err() != nil {
			return
		}
	}
	end, _ := EncodeText(Text{T: TEnd, ID: f.ID})
	_ = send(websocket.MessageText, end)
}

// Resubscription bounds of a run's tail after its upstream stream ended
// without a terminal event. Variables for the tests.
var (
	tailResubscribeLimit = 5
	tailResubscribeDelay = time.Second
)

// startTail opens one upstream subscription per run and journals it,
// independently of the broker connection.
func (c *Client) startTail(runID, profile string) {
	c.mu.Lock()
	if _, exists := c.tails[runID]; exists {
		c.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.tails[runID] = cancel
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.tails, runID)
			c.mu.Unlock()
		}()
		c.tailRun(ctx, runID, profile)
	}()
}

// tailRun feeds the run's journal until a terminal event. A stream that ends
// without one is a transport event, not the end of the run: the gateway is
// asked for the run's status, and only a finished or unknown run marks the
// journal terminal. A run still going is subscribed again, at most
// tailResubscribeLimit times in a row without a new event; past that the
// journal stays open and the next replay request starts a new tail.
func (c *Client) tailRun(ctx context.Context, runID, profile string) {
	failures := 0
	for {
		terminal, progressed := c.tailOnce(ctx, runID, profile)
		if terminal || ctx.Err() != nil {
			return
		}
		if progressed {
			failures = 0
		}
		if c.runEnded(ctx, runID, profile) {
			c.Journal.MarkTerminal(runID)
			return
		}
		if failures++; failures > tailResubscribeLimit {
			c.Logf("tail %s: upstream stream keeps ending; leaving the journal open", runID)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(tailResubscribeDelay * time.Duration(failures)):
		}
	}
}

// tailOnce reads one upstream subscription into the journal. It reports
// whether a terminal event was journaled and whether any event was.
//
// A subscription opened on a run that already has entries may start by
// sending them again: blocks equal, in order, to the journal's own first
// entries are skipped, and everything from the first difference on is new.
func (c *Client) tailOnce(ctx context.Context, runID, profile string) (terminal, progressed bool) {
	known, err := c.Journal.After(runID, 0)
	if err != nil {
		c.Logf("tail %s: journal unreadable", runID)
		return false, false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Gateway+profile+"/v1/runs/"+runID+"/events", nil)
	if err != nil {
		return false, false
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+c.Bearer)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		c.Logf("tail %s: %v", runID, err)
		return false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		c.Logf("tail %s: HTTP %d", runID, resp.StatusCode)
		return false, false
	}
	replayed := 0
	var pending strings.Builder
	buf := make([]byte, 16<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			pending.Write(buf[:n])
			raw := pending.String()
			if i := strings.LastIndex(raw, "\n\n"); i >= 0 {
				complete, rest := raw[:i+2], raw[i+2:]
				pending.Reset()
				pending.WriteString(rest)
				for _, block := range ParseSSEBlocks(complete) {
					if replayed >= 0 && replayed < len(known) && known[replayed].Event == block {
						replayed++
						continue
					}
					replayed = -1
					terminal := IsTerminal(block)
					if _, _, err := c.Journal.Append(runID, block, terminal); err != nil {
						log.Printf("journal %s: %v", runID, err)
					}
					progressed = true
					if terminal {
						return true, true
					}
				}
			}
		}
		if rerr != nil {
			return false, progressed
		}
	}
}

// runEnded asks the gateway whether the run is over: a terminal status, or a
// run the gateway no longer knows (404), whose events can never come. Any
// other answer, or none, keeps the run open.
func (c *Client) runEnded(ctx context.Context, runID, profile string) bool {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Gateway+profile+"/v1/runs/"+runID, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Bearer)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return true
	}
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var run struct {
		Status string `json:"status"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, MaxResponseBody)).Decode(&run) != nil {
		return false
	}
	switch run.Status {
	case "completed", "failed", "interrupted", "cancelled", "canceled", "error", "stopped":
		return true
	}
	return false
}
