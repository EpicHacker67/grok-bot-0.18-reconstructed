package main

import (
	"context"
	"encoding/binary"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

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

// Reproduce Pulse's timestamp corrections without needing a running desktop.
// The production encoder must turn those corrections into a continuous sample
// clock; timestamp holes otherwise make NetEq conceal samples and grow delay.
func TestAudioRTPHasContinuousSampleClock(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg required for RTP integration test")
	}
	socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	audio := captureArgs(0, socket.LocalAddr().(*net.UDPAddr).Port)[1]
	var output []string
	for i, arg := range audio {
		if arg == "-i" {
			output = audio[i+2:]
			break
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := append([]string{"-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=600:sample_rate=48000,asetpts=PTS+floor(N/960)*48", "-t", "0.3"}, output...)
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	var errors strings.Builder
	cmd.Stderr = &errors
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	socket.SetReadDeadline(time.Now().Add(2 * time.Second))
	var previous uint32
	count := 0
	discontinuity := false
	for {
		packet := make([]byte, 2048)
		n, _, err := socket.ReadFromUDP(packet)
		if err != nil {
			break
		}
		if n < 12 {
			continue
		}
		stamp := binary.BigEndian.Uint32(packet[4:8])
		if count > 0 && stamp-previous != 480 {
			discontinuity = true
		}
		previous = stamp
		count++
	}
	if err = cmd.Wait(); err != nil {
		t.Fatalf("ffmpeg: %v: %s", err, errors.String())
	}
	if count < 20 || discontinuity {
		t.Fatalf("noncontinuous 10ms audio: packets=%d, discontinuity=%v", count, discontinuity)
	}
}
