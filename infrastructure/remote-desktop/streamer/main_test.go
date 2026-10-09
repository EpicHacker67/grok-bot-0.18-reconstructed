package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestSignalingRequiresAuthenticationBeforeParsing(t *testing.T) {
	s := &server{token: strings.Repeat("a", 64)}
	for _, token := range []string{"", "Bearer wrong", "Bearer " + s.token + "suffix"} {
		r := httptest.NewRequest(http.MethodPost, "/offer", strings.NewReader(`{"type":"offer"}`))
		r.Header.Set("Authorization", token)
		w := httptest.NewRecorder()
		s.offer(w, r)
		if w.Code != 401 {
			t.Fatalf("unauthorized signaling returned %d", w.Code)
		}
	}
}
func TestInvalidAndOversizedOffersAreRejected(t *testing.T) {
	s := &server{token: strings.Repeat("a", 64)}
	for _, body := range []string{`{`, `{"type":"answer","sdp":"bad"}`, `{"type":"offer","sdp":"` + strings.Repeat("a", 70000) + `"}`} {
		r := httptest.NewRequest(http.MethodPost, "/offer", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+s.token)
		w := httptest.NewRecorder()
		s.offer(w, r)
		if w.Code != 400 {
			t.Fatalf("invalid signaling returned %d", w.Code)
		}
	}
}
func TestSessionRemovalCancelsCaptureAndIsIdempotent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	s := &server{sessions: map[string]*session{"test": {pc: pc, cancel: cancel}}}
	s.remove("test")
	s.remove("test")
	if ctx.Err() == nil || len(s.sessions) != 0 {
		t.Fatal("capture/session not released")
	}
}
