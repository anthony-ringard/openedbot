package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A link that stays up re-announces a state the operator changed under it
// (auto_upgrade enabled, then disabled), sends nothing while the list is the
// same, and keeps the last list when the operator does not answer.
func TestFollowOperatorReannouncesChangedFeaturesOnly(t *testing.T) {
	base := []string{FeatureProviderManagement, FeatureProviderUsage}
	withAuto := []string{FeatureProviderManagement, FeatureProviderUsage, FeatureAutoUpgrade}
	reorderedAuto := []string{FeatureAutoUpgrade, FeatureProviderUsage, FeatureProviderManagement}
	// One operator answer per refresh; nil is an operator that does not answer.
	replies := [][]string{base, withAuto, reorderedAuto, nil, base}
	c := New("", Auth{}, "", "", nil)
	c.OperatorSocket = "/configured/operator.sock"
	read := 0
	c.operator = &http.Client{Transport: readinessTransport(func(*http.Request) (*http.Response, error) {
		reply := replies[read]
		read++
		if reply == nil {
			return nil, errors.New("operator restarting")
		}
		body, _ := json.Marshal(map[string]any{"features": reply})
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{}}, nil
	})}
	waits := 0
	c.wait = func(_ context.Context, d time.Duration) error {
		if d != OperatorRefreshInterval {
			t.Fatalf("refresh waited %s", d)
		}
		if waits++; waits > len(replies) {
			return context.Canceled
		}
		return nil
	}
	var sent [][]string
	c.followOperator(context.Background(), func(kind websocket.MessageType, data []byte) error {
		frame, err := DecodeText(data)
		if err != nil || kind != websocket.MessageText || frame.T != TCapabilities {
			t.Fatalf("not a capabilities frame: %+v %v", frame, err)
		}
		sent = append(sent, frame.Features)
		return nil
	}, base)
	want := [][]string{
		{FeatureProviderManagement, FeatureProviderUsage, FeatureAutoUpgrade},
		{FeatureProviderManagement, FeatureProviderUsage},
	}
	if !reflect.DeepEqual(sent, want) {
		t.Fatalf("sent %v, want %v", sent, want)
	}
}

// A failed write is retried at the next refresh, not forgotten.
func TestFollowOperatorRetriesAFailedAnnouncement(t *testing.T) {
	c := New("", Auth{}, "", "", nil)
	c.OperatorSocket = "/configured/operator.sock"
	c.operator = operatorAnnouncing(FeatureProviderManagement, FeatureAutoUpgrade)
	waits := 0
	c.wait = func(context.Context, time.Duration) error {
		if waits++; waits > 3 {
			return context.Canceled
		}
		return nil
	}
	sends := 0
	c.followOperator(context.Background(), func(websocket.MessageType, []byte) error {
		sends++
		if sends == 1 {
			return errors.New("temporary write failure")
		}
		return nil
	}, []string{FeatureProviderManagement})
	if sends != 2 {
		t.Fatalf("sends=%d, want one failure then one success and nothing after", sends)
	}
}
