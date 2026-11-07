package operator

import (
	"context"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
)

// fullOperator is an operator with every dependency a feature is claimed from.
// Two switches are still read at request time: the profiles multiplex setting
// and whether the A2A policy is observed. When a feature gains a new
// dependency, wire it here, or the guard below cannot see it.
func fullOperator(multiplex, policyObserved bool) *Server {
	profiles := `{"multiplex":false,"profiles":[]}`
	if multiplex {
		// The busiest host also runs a gateway that reconciles MCP live.
		profiles = `{"multiplex":true,"mcpLiveReload":true,"profiles":[]}`
	}
	recorder := &probeRecorder{replies: map[string]string{"profiles": profiles}}
	return &Server{
		Probe:           recorder.probe(),
		Inventory:       func(context.Context) ([]byte, error) { return []byte(`{"data":[]}`), nil },
		StartMCPOAuth:   func(context.Context, string, string, string) (OAuthFlow, error) { return nil, nil },
		RestartGateway:  func(context.Context) error { return nil },
		GracefulRestart: true,
		Sessions:        func(context.Context, string, int) ([]byte, error) { return []byte(`{}`), nil },
		ProviderSDKs:    func(context.Context) ([]hermes.ProviderSDKStatus, error) { return nil, nil },
		A2ACard:         func(context.Context) (A2AAgentCard, error) { return A2AAgentCard{}, nil },
		A2AAudit:        func(context.Context, int) (a2aAuditSnapshot, error) { return a2aAuditSnapshot{}, nil },
		A2APeers:        func(context.Context) (A2APolicyView, error) { return A2APolicyView{}, nil },
		WriteA2APeer: func(context.Context, a2aPeerMutation) (a2aPolicyWriteStatus, error) {
			return a2aPolicyWriteStatus{}, nil
		},
		A2APolicyReady: func(context.Context) bool { return policyObserved },
		ApprovalPolicyRead: func(context.Context, string) (approvalPolicyState, error) {
			return approvalPolicyState{Mode: approvalPolicyAsk, PluginEnabled: true}, nil
		},
		ApprovalPolicyWrite: func(_ context.Context, _ string, request approvalPolicyRequest) (approvalPolicyState, error) {
			return approvalPolicyState{Mode: request.Mode, PluginEnabled: true}, nil
		},
		SkillsHubReady:     true,
		AutoUpgradeEnabled: func() bool { return true },
	}
}

// beyondDefaultAcknowledged is how many names the busiest host may announce
// past connector.DefaultMaxFeatures. An API that has not announced a bound
// drops them (hello is cut, never refused), so raising this is a decision about
// older APIs, not a formality. The API-side feature bound was raised before
// this host feature shipped. The fourth and fifth names are profile_model_batch
// and profile_bundled_skills, last in priority: an API that drops the first
// writes profiles one by one, as before; one that drops the second never
// applies the capability baseline's bundled-skills step, and its baseline
// waits until the host is reached by an API that announces the bound. The
// sixth is mcp_oauth_profile: an API that drops it offers no bot-level MCP
// connection (never a root fallback), the seventh mcp_profile_disconnect: an
// API that drops it offers no bot-level disconnect, and the eighth
// mcp_live_reload: an API that drops it keeps asking for a gateway restart
// after an MCP change, which stays correct. The ninth is
// gateway_graceful_restart: an API that drops it warns that a restart
// interrupts the running turns, which is only pessimistic. The tenth is
// skills_inventory: an API that drops it shows the gateway's /v1/skills
// failure as is. The eleventh is profile_toolsets_batch: an API that drops it
// writes a profile's toolsets one by one, as before. The twelfth is
// auto_upgrade: an API that drops it shows the command that enables the
// timer even on a host where it already runs, which is only redundant. The
// API in this repository announces a bound of 64.
const beyondDefaultAcknowledged = 12

// The guard behind the incident where the next operator feature would have made
// every updated host's hello 17 names long. It reads the REAL operator, in every
// state it can be in, and checks two things: each name it announces is one the
// link knows how to order (connector.HostFeatures), and the busiest hello a host
// can send still fits the bound every API accepts.
func TestEveryAnnouncedFeatureIsKnownToTheLinkAndFitsTheDefaultBound(t *testing.T) {
	seen, unknown := map[string]bool{}, map[string]bool{}
	widest := 0
	for _, multiplex := range []bool{false, true} {
		for _, policyObserved := range []bool{false, true} {
			srv := httptest.NewServer(fullOperator(multiplex, policyObserved).Handler())
			status, out := call(t, srv, "GET", "/capabilities", "")
			srv.Close()
			features, _ := out["features"].([]any)
			if status != 200 || len(features) == 0 {
				t.Fatalf("multiplex=%v policy=%v: %d %v", multiplex, policyObserved, status, out)
			}
			widest = max(widest, len(features))
			for _, raw := range features {
				name, _ := raw.(string)
				seen[name] = true
				unknown[name] = !slices.Contains(connector.HostFeatures, name)
			}
		}
	}
	for name, isUnknown := range unknown {
		if isUnknown {
			t.Errorf("the operator announces %q, a name the link does not know: add it to connector.HostFeatures at its priority (frames.go) and to the shared hello vector", name)
		}
	}
	// Both ways: a name the operator can no longer announce is dead weight in
	// the vocabulary, and a fixture that stopped reaching a feature would let
	// the size check below pass for the wrong reason.
	for _, name := range connector.HostFeatures {
		if !seen[name] {
			t.Errorf("connector.HostFeatures lists %q, which no state of the operator announces (is fullOperator still wiring it?)", name)
		}
	}
	announced := widest + len(connector.LinkFeatures)
	if over := announced - connector.DefaultMaxFeatures; over > beyondDefaultAcknowledged {
		t.Errorf("the busiest host announces %d names (%d from the operator, %d from the link): %d past connector.DefaultMaxFeatures (%d). "+
			"An API that has not announced a bound drops the %d lowest-priority ones. That is safe, hello is cut and not refused, but it is a choice: "+
			"ship the API bound first (RELAY_MAX_FEATURES, announced in link.context), then raise beyondDefaultAcknowledged here. "+
			"Never raise DefaultMaxFeatures: it is what every released API accepts",
			announced, widest, len(connector.LinkFeatures), over, connector.DefaultMaxFeatures, over)
	}
}
