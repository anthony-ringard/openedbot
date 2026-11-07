// Package connector implements the outbound link to openedbot: one
// WebSocket, HTTP multiplexed over it toward the loopback gateway, an
// allowlist of gateway routes, and a per-run event journal for replay. The
// wire contract is docs/CONNECTOR.md, shared with openedbot.
package connector

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
)

// Protocol is the wire protocol version announced in hello.
const Protocol = 1

// Bounds of the wire contract.
const (
	MaxInFlight        = 64
	MaxRequestBody     = 1 << 20
	MaxResponseBody    = 4 << 20
	MaxHeaderBytes     = 16 << 10
	MaxTextFrame       = 64 << 10
	FirstResponseLimit = 60 // seconds, except /events
)

// Frame types.
const (
	THello         = "hello"
	TCapabilities  = "capabilities"
	TDiagnostic    = "diagnostic"
	TDiagnosticAck = "diagnostic.ack"
	TLinkIssued    = "link.issued"
	TLinkRotate    = "link.rotate"
	// TLinkRetire is sent by the host on an admitted link when it leaves
	// (uninstall, unlink): openedbot revokes the runtime, answers
	// TLinkRetired and closes the link.
	TLinkRetire    = "link.retire"
	TLinkRetired   = "link.retired"
	TLinkContext   = "link.context"
	TLinkChallenge = "link.challenge"
	TLinkProof     = "link.proof"
	TAuditKey      = "audit.key"
	TAuditAnchor   = "audit.anchor"
	TReq           = "req"
	TRes           = "res"
	TEnd           = "end"
	TErr           = "err"
	TCancel        = "cancel"
	TPing          = "ping"
	TPong          = "pong"
)

// TInventoryChanged is sent by the host when the files behind its inventory
// (toolsets, MCP servers and logins, skills) moved, and once per session for
// what changed while the link was down. It carries nothing: openedbot re-reads
// the inventory through the usual routes. Sent only to an openedbot whose
// link.context lists it in accepts.
const TInventoryChanged = "inventory.changed"

// Features announced in hello describe the fixed host routes served through
// hermes-operator (docs/CONNECTOR.md, « Fournisseurs par le lien »).
const (
	FeatureProviderManagement = "provider_management"
	FeatureProviderUsage      = "provider_usage"
	// FeatureToolsetManagement covers GET /hermes-setup/toolsets and the
	// per-toolset write; FeatureMCPManagement covers the MCP inventory,
	// custom HTTP servers, and catalogue installs.
	FeatureToolsetManagement = "toolset_management"
	FeatureMCPManagement     = "mcp_management"
	// FeatureMCPOAuth covers the four MCP OAuth routes; FeatureGatewayRestart
	// the gateway status read and the one restart verb.
	FeatureMCPOAuth       = "mcp_oauth"
	FeatureGatewayRestart = "gateway_restart"
	// FeatureProfileInventory is the named READ of Hermes profiles already
	// on this host. Profile management/capabilities are advertised only when
	// multiplexing and their named writes are available.
	FeatureProfileInventory     = "profile_inventory"
	FeatureProfileManagement    = "profile_management"
	FeatureProfileCapabilities  = "profile_capabilities"
	FeatureProfileBundledSkills = "profile_bundled_skills"
	// FeatureProfileCredentials is a per-profile API-key write, advertised
	// under the same conditions as profile_management.
	FeatureProfileCredentials = "profile_credentials"
	// FeatureProfileMemory is the read and the named writes (add / replace /
	// remove) of a profile's MEMORY.md and USER.md through the upstream store.
	FeatureProfileMemory = "profile_memory"
	// FeatureSessionsInventory is the bounded READ of session identifiers per
	// profile, so openedbot can reconcile them with its own dispatches.
	FeatureSessionsInventory = "sessions_inventory"
	// FeatureA2ACard is the fixed, metadata-only read of the loopback card.
	FeatureA2ACard = "a2a_card"
	// FeatureA2AAudit is the bounded read of sanitized journal metadata.
	FeatureA2AAudit       = "a2a_audit"
	FeatureA2AManagement  = "a2a_management"
	FeatureApprovalPolicy = "approval_policy"
	// FeatureModelContext is GET /hermes-setup/model-context, the context window
	// of the configured model. openedbot has its own table to fall back on,
	// so it is the name to lose first when a bound is too small.
	FeatureModelContext = "model_context"
	// FeatureProviderSDKs is the read-only host report for provider SDK imports.
	FeatureProviderSDKs = "provider_sdks"
	FeatureSkillsHub    = "skills_hub"
	// FeatureProfileModelBatch is POST /hermes-setup/profiles/models, one write
	// of the same model into many profiles. openedbot falls back on the
	// per-profile route without it, so it is the first name a bound drops.
	FeatureProfileModelBatch = "profile_model_batch"
	// FeatureMCPOAuthProfile is the `profile` field of the MCP OAuth start:
	// the token lands in that named profile's home, the only one its runs
	// read. Without it openedbot offers no bot-level MCP connection.
	FeatureMCPOAuthProfile = "mcp_oauth_profile"
	// FeatureMCPProfileDisconnect is DELETE /hermes-setup/profiles/{slug}/mcp/servers/{server}:
	// one bot's MCP server and its OAuth state removed from that profile only.
	// Without it openedbot offers no bot-level disconnect.
	FeatureMCPProfileDisconnect = "mcp_profile_disconnect"
	// FeatureMCPLiveReload says the host's gateway reconciles its live MCP
	// servers with the config on disk by itself (within a housekeeping tick):
	// an MCP change needs no gateway restart. Without it openedbot keeps
	// asking for one, which stays correct, only slower.
	FeatureMCPLiveReload = "mcp_live_reload"
	// FeatureGatewayGracefulRestart says the gateway restart route drains:
	// the running turns finish, new runs are refused with 503
	// `gateway_draining` (requeued by openedbot), then the gateway relaunches.
	// Without it the restart interrupts the running turns, and openedbot says
	// so before the owner confirms.
	FeatureGatewayGracefulRestart = "gateway_graceful_restart"
	// FeatureSkillsInventory is GET /hermes-setup/skills: the root's installed
	// skills, read by the operator. openedbot reads it only when the gateway's
	// /v1/skills fails (Hermes 0.21.3 to 0.22.6, upstream #142575).
	FeatureSkillsInventory = "skills_inventory"
	// FeatureProfileToolsetsBatch is POST /hermes-setup/profiles/{slug}/toolsets:
	// several toolsets of one profile written in one request, one CLI call per
	// direction. openedbot falls back on the per-toolset route without it,
	// which stays correct, only slower (a profile's capability baseline).
	FeatureProfileToolsetsBatch = "profile_toolsets_batch"
	// FeatureAutoUpgrade is a state, not a route: the upgrade timer of the
	// host is enabled, so a newer edge-setup release installs itself (every
	// 6 h, idle-aware, link proven, rollback on failure). It can appear or
	// vanish during a link: the connector re-reads the operator and sends a
	// capabilities frame when the list changes.
	FeatureAutoUpgrade = "auto_upgrade"
)

// HostFeatures is every feature name the operator may announce, in the fixed
// priority order hello and capabilities list them in. When the bound in force
// is smaller than the list, the names at the end are the ones that go: the
// provider verbs every host has served since the link existed come first, the
// newest and the ones openedbot can do without come last.
//
// It is also the closed set InjectFeatures clears before setting the announced
// ones, so a feature a host stops serving disappears from /v1/capabilities
// instead of lingering there from an older answer.
var HostFeatures = []string{
	FeatureProviderManagement,
	FeatureProviderUsage,
	FeatureToolsetManagement,
	FeatureMCPManagement,
	FeatureMCPOAuth,
	FeatureGatewayRestart,
	FeatureProfileInventory,
	FeatureProfileManagement,
	FeatureProfileCapabilities,
	FeatureProfileCredentials,
	FeatureProfileMemory,
	FeatureApprovalPolicy,
	FeatureSessionsInventory,
	FeatureA2ACard,
	FeatureA2AAudit,
	FeatureA2AManagement,
	FeatureModelContext,
	FeatureProviderSDKs,
	FeatureSkillsHub,
	FeatureProfileModelBatch,
	FeatureProfileBundledSkills,
	FeatureMCPOAuthProfile,
	FeatureMCPProfileDisconnect,
	FeatureMCPLiveReload,
	FeatureGatewayGracefulRestart,
	FeatureSkillsInventory,
	FeatureProfileToolsetsBatch,
	FeatureAutoUpgrade,
}

// FeatureCreationAuditV2 is a LINK feature, announced in hello only: the
// host keeps a sealed creation audit and expects audit.key before any
// creation. It is not an operator capability and never enters the
// capabilities frame or /v1/capabilities.
const FeatureCreationAuditV2 = "creation_audit_v2"

// LinkFeatures is every feature name the link itself adds to hello. They come
// before every operator feature in the announce order, so a bound that is too
// small takes operator features and never one of these: a host that lost
// creation_audit_v2 would keep its sealed audit and wait for a key nobody sends.
var LinkFeatures = []string{FeatureCreationAuditV2}

// MaxAuditPreviousKeys bounds the keys audit.key still accepts for reading.
const MaxAuditPreviousKeys = 2

// Bounds of the feature list in hello and capabilities
// (docs/CONNECTOR.md, « Borne des features »).
const (
	// DefaultMaxFeatures is the bound a host applies until openedbot
	// announces another one in link.context: what every API released before
	// limits.features accepts, and 4401 for a longer hello. Never raise it.
	DefaultMaxFeatures = 16
	// MaxFeatures is the most names a hello or capabilities frame may list,
	// whoever sends it, and the ceiling of the bound a host honors.
	MaxFeatures = 64
)

// featureBoundOrDefault is the bound a list is cut to: DefaultMaxFeatures when
// none is known (zero or less), never more than MaxFeatures.
func featureBoundOrDefault(bound int) int {
	switch {
	case bound < 1:
		return DefaultMaxFeatures
	case bound > MaxFeatures:
		return MaxFeatures
	}
	return bound
}

// featureRank is the position of a name in the announce order: link features,
// then HostFeatures.
var featureRank = func() map[string]int {
	rank := make(map[string]int, len(LinkFeatures)+len(HostFeatures))
	for _, name := range slices.Concat(LinkFeatures, HostFeatures) {
		if _, listed := rank[name]; !listed {
			rank[name] = len(rank)
		}
	}
	return rank
}()

// compareFeatures orders two names by featureRank. A name outside it, from an
// operator newer than this connector, comes after every known one, in name
// order, so the result never depends on the order the operator listed them in.
func compareFeatures(a, b string) int {
	ra, okA := featureRank[a]
	rb, okB := featureRank[b]
	switch {
	case okA && okB:
		return ra - rb
	case okA:
		return -1
	case okB:
		return 1
	}
	return strings.Compare(a, b)
}

// announceFeatures builds the list a hello (link features, then the
// operator's) or a capabilities frame (the operator's only) carries. Link
// names come first, each group is sorted by compareFeatures, a name listed
// twice counts once, and at most bound names are kept. kept goes on the wire;
// dropped is what the bound took, from the end, in the same order.
func announceFeatures(link, operator []string, bound int) (kept, dropped []string) {
	bound = featureBoundOrDefault(bound)
	seen := make(map[string]bool, len(link)+len(operator))
	ordered := make([]string, 0, len(link)+len(operator))
	for _, group := range [][]string{link, operator} {
		start := len(ordered)
		for _, name := range group {
			if !seen[name] {
				seen[name] = true
				ordered = append(ordered, name)
			}
		}
		slices.SortStableFunc(ordered[start:], compareFeatures)
	}
	if len(ordered) <= bound {
		return ordered, nil
	}
	return ordered[:bound:bound], ordered[bound:]
}

var featureRe = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)
var eventIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var diagnosticCodeRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
var auditKeyIDRe = regexp.MustCompile(`^[A-Za-z0-9._~-]{1,128}$`)
var auditTailRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Stages of an err frame.
const (
	StageBeforeDispatch = "before_dispatch"
	StageAfterDispatch  = "after_dispatch"
)

// Close codes.
const (
	CloseTooBig      = 1009
	CloseReplaced    = 4001
	CloseProbeFailed = 4003
	CloseRevoked     = 4004
	// CloseReconnect: the broker's WebSocket ping went unanswered, so it hung
	// up this session. The link is not refused; the next dial waits 1 s.
	CloseReconnect = 4005
	CloseUnauth    = 4401
)

// Text is a control frame. Unused fields are omitted on the wire.
type Text struct {
	T             string `json:"t"`
	EventID       string `json:"eventId,omitempty"`
	Component     string `json:"component,omitempty"`
	State         string `json:"state,omitempty"`
	OccurredAt    string `json:"occurredAt,omitempty"`
	Stack         string `json:"stack,omitempty"`
	Protocol      int    `json:"protocol,omitempty"`
	Agent         string `json:"agent,omitempty"`
	HermesVersion string `json:"hermesVersion,omitempty"`
	// Features lists what the host serves beyond the gateway allowlist
	// (hello and capabilities). Unknown names are ignored by the other side.
	Features  []string `json:"features,omitempty"`
	RuntimeID string   `json:"runtimeId,omitempty"`
	LinkToken string   `json:"linkToken,omitempty"`
	// DevicePublicKey (hello) is the host's Ed25519 key; Nonce
	// (link.challenge) and Signature (link.proof) carry the proof of
	// possession, docs/CONNECTOR.md « Preuve de possession ».
	DevicePublicKey string `json:"devicePublicKey,omitempty"`
	Nonce           string `json:"nonce,omitempty"`
	Signature       string `json:"signature,omitempty"`
	// audit.key carries the base64 master key of KeyID plus the keys still
	// accepted for reading; audit.anchor carries the chain position.
	KeyID string `json:"keyId,omitempty"`
	Key   string `json:"key,omitempty"`
	// link.context names the openedbot behind the link: its deployment
	// tier, origin, organization and owner. Alerts and status show them. Limits
	// are the bounds it applies to this host; a host that predates the field
	// ignores it, like latestVersion and minimumVersion, because DecodeText does
	// not reject unknown fields.
	Environment  string            `json:"environment,omitempty"`
	Openedbot    string            `json:"openedbot,omitempty"`
	Organization *LinkOrganization `json:"organization,omitempty"`
	Owner        *LinkOwner        `json:"owner,omitempty"`
	Limits       *LinkLimits       `json:"limits,omitempty"`
	Previous     []AuditKeyRef     `json:"previous,omitempty"`
	WriteSeq     uint64            `json:"writeSeq,omitempty"`
	Count        int               `json:"count,omitempty"`
	Dropped      uint64            `json:"dropped,omitempty"`
	Tail         string            `json:"tail,omitempty"`
	ID           uint32            `json:"id,omitempty"`
	Method       string            `json:"method,omitempty"`
	Path         string            `json:"path,omitempty"`
	Headers      map[string]string `json:"headers,omitempty"`
	Body         string            `json:"body,omitempty"`
	Status       int               `json:"status,omitempty"`
	Code         string            `json:"code,omitempty"`
	Message      string            `json:"message,omitempty"`
	Stage        string            `json:"stage,omitempty"`

	// Accepts (link.context) lists the optional host frames this openedbot
	// understands. An older openedbot closes the link on an unknown frame
	// type, so such a frame is only ever sent when listed here.
	Accepts []string `json:"accepts,omitempty"`
}

// AuditKeyRef is one retired master key openedbot still hands out so the
// host can open a file sealed before a rotation.
type AuditKeyRef struct {
	KeyID string `json:"keyId"`
	Key   string `json:"key"`
}

// LinkOrganization and LinkOwner are the link.context identities: display
// data only, never a credential.
type LinkOrganization struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type LinkOwner struct {
	Email       string `json:"email"`
	DisplayName string `json:"displayName,omitempty"`
}

// LinkLimits are the bounds openedbot announces in link.context. A bound
// it leaves out is one it does not announce.
type LinkLimits struct {
	// Features is the most names hello and capabilities may list.
	Features *int `json:"features,omitempty"`
}

// LinkContext is what link.context conveys, kept by the client and shown in
// alerts and `status`. Environment is dev, preprod or prod.
type LinkContext struct {
	Environment  string
	Openedbot    string
	Organization LinkOrganization
	Owner        LinkOwner
	// FeatureLimit is limits.features as announced, zero when the frame did not
	// carry one. The daemon persists it next to the rest of the context so the
	// first hello after a restart already honors it.
	FeatureLimit int
}

// MaxLinkContextText bounds every link.context string.
const MaxLinkContextText = 256

// MaxLinkContextAccepts bounds link.context accepts.
const MaxLinkContextAccepts = 16

var frameTypeRe = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,63}$`)

// EncodeText serialises a control frame.
func EncodeText(f Text) ([]byte, error) {
	if f.T == "" {
		return nil, errors.New("frame without type")
	}
	b, err := json.Marshal(f)
	if err != nil {
		return nil, err
	}
	if len(b) > MaxTextFrame {
		return nil, fmt.Errorf("text frame of %d bytes exceeds %d", len(b), MaxTextFrame)
	}
	return b, nil
}

// DecodeText parses a control frame and validates the fields its type
// requires.
func DecodeText(b []byte) (Text, error) {
	if len(b) > MaxTextFrame {
		return Text{}, fmt.Errorf("text frame of %d bytes exceeds %d", len(b), MaxTextFrame)
	}
	var f Text
	if err := json.Unmarshal(b, &f); err != nil {
		return Text{}, fmt.Errorf("malformed text frame: %w", err)
	}
	switch f.T {
	case TDiagnostic, TDiagnosticAck:
		if !eventIDRe.MatchString(f.EventID) {
			return f, errors.New("diagnostic requires a UUID eventId")
		}
		if f.T == TDiagnostic {
			if (f.Component != "link" && f.Component != "operator") || (f.State != "unavailable" && f.State != "recovered") || !diagnosticCodeRe.MatchString(f.Code) {
				return f, errors.New("invalid diagnostic component, state or code")
			}
			if len(f.Message) > 256 || len(f.Stack) > 8192 {
				return f, errors.New("diagnostic text exceeds its limit")
			}
			if _, err := time.Parse(time.RFC3339Nano, f.OccurredAt); err != nil {
				return f, errors.New("diagnostic requires an ISO timestamp")
			}
		}
	case THello:
		if f.Protocol != Protocol {
			return f, fmt.Errorf("unsupported protocol %d", f.Protocol)
		}
		if f.DevicePublicKey != "" {
			if _, err := enroll.ParseDevicePublicKey(f.DevicePublicKey); err != nil {
				return f, err
			}
		}
		fallthrough
	case TCapabilities:
		if len(f.Features) > MaxFeatures {
			return f, fmt.Errorf("%s lists %d features, more than %d", f.T, len(f.Features), MaxFeatures)
		}
		for _, name := range f.Features {
			if !featureRe.MatchString(name) {
				return f, fmt.Errorf("%s feature %q is not a feature name", f.T, name)
			}
		}
	case TLinkIssued:
		if f.RuntimeID == "" || f.LinkToken == "" {
			return f, errors.New("link.issued without runtimeId or linkToken")
		}
	case TLinkRotate:
		if f.RuntimeID == "" || f.LinkToken == "" {
			return f, errors.New("link.rotate without runtimeId or linkToken")
		}
	case TLinkRetire, TInventoryChanged:
	case TLinkRetired:
		if f.RuntimeID == "" {
			return f, errors.New("link.retired without runtimeId")
		}
	case TLinkContext:
		if f.Environment != "dev" && f.Environment != "preprod" && f.Environment != "prod" {
			return f, errors.New("link.context requires environment dev, preprod or prod")
		}
		texts := []string{f.Openedbot}
		if f.Organization != nil {
			texts = append(texts, f.Organization.ID, f.Organization.Name, f.Organization.Slug)
		}
		if f.Owner != nil {
			texts = append(texts, f.Owner.Email, f.Owner.DisplayName)
		}
		for _, text := range texts {
			if len(text) > MaxLinkContextText {
				return f, errors.New("link.context text exceeds its limit")
			}
		}
		if f.Limits != nil && f.Limits.Features != nil && *f.Limits.Features < 1 {
			return f, errors.New("link.context limits.features must be an integer of at least 1")
		}
		if len(f.Accepts) > MaxLinkContextAccepts {
			return f, fmt.Errorf("link.context accepts lists more than %d frame types", MaxLinkContextAccepts)
		}
		for _, name := range f.Accepts {
			if !frameTypeRe.MatchString(name) {
				return f, fmt.Errorf("link.context accepts %q, which is not a frame type", name)
			}
		}
	case TLinkChallenge:
		if _, err := enroll.ParsePoPNonce(f.Nonce); err != nil {
			return f, err
		}
	case TLinkProof:
		if sig, err := base64.StdEncoding.DecodeString(f.Signature); err != nil || len(sig) != ed25519.SignatureSize {
			return f, errors.New("link.proof requires a 64-byte base64 signature")
		}
	case TAuditKey:
		if f.RuntimeID == "" || !auditKeyIDRe.MatchString(f.KeyID) || !validAuditKey(f.Key) {
			return f, errors.New("audit.key requires runtimeId, keyId and a 32-byte base64 key")
		}
		if len(f.Previous) > MaxAuditPreviousKeys {
			return f, fmt.Errorf("audit.key lists %d previous keys, more than %d", len(f.Previous), MaxAuditPreviousKeys)
		}
		for _, prior := range f.Previous {
			if !auditKeyIDRe.MatchString(prior.KeyID) || !validAuditKey(prior.Key) {
				return f, errors.New("audit.key previous entry is invalid")
			}
		}
	case TAuditAnchor:
		if f.RuntimeID == "" || !auditKeyIDRe.MatchString(f.KeyID) || !auditTailRe.MatchString(f.Tail) {
			return f, errors.New("audit.anchor requires runtimeId, keyId and a hex tail")
		}
	case TReq:
		if f.ID == 0 || f.Method == "" || f.Path == "" || (f.Body != "none" && f.Body != "stream") {
			return f, errors.New("req requires id, method, path and body none|stream")
		}
	case TRes:
		if f.ID == 0 || f.Status == 0 {
			return f, errors.New("res requires id and status")
		}
	case TEnd, TCancel:
		if f.ID == 0 {
			return f, errors.New(f.T + " requires id")
		}
	case TErr:
		if f.ID == 0 || f.Code == "" || (f.Stage != StageBeforeDispatch && f.Stage != StageAfterDispatch) {
			return f, errors.New("err requires id, code and a valid stage")
		}
	case TPing, TPong:
	default:
		return f, fmt.Errorf("unknown frame type %q", f.T)
	}
	return f, nil
}

func validAuditKey(encoded string) bool {
	key, err := base64.StdEncoding.DecodeString(encoded)
	return err == nil && len(key) == auditKeySize
}

// EncodeBinary builds a body chunk: [u32 BE id][bytes].
func EncodeBinary(id uint32, chunk []byte) []byte {
	out := make([]byte, 4+len(chunk))
	binary.BigEndian.PutUint32(out, id)
	copy(out[4:], chunk)
	return out
}

// DecodeBinary splits a body chunk.
func DecodeBinary(b []byte) (uint32, []byte, error) {
	if len(b) < 4 {
		return 0, nil, errors.New("binary frame shorter than 4 bytes")
	}
	return binary.BigEndian.Uint32(b[:4]), b[4:], nil
}
