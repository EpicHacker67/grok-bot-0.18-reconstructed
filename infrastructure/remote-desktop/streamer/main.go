// Mengel's private desktop media endpoint. Signaling stays inside Docker/SSH;
// encrypted WebRTC media uses the single port published on Holly's VPN address.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

type session struct {
	pc       *webrtc.PeerConnection
	cancel   context.CancelFunc
	once     sync.Once
	sockets  []*net.UDPConn
	progress atomic.Value
}

func (s *session) close() {
	s.once.Do(func() {
		s.cancel()
		for _, c := range s.sockets {
			c.Close()
		}
		go s.pc.Close()
	})
}

type server struct {
	api      *webrtc.API
	mu       sync.Mutex
	sessions map[string]*session
	token    string
}

func (s *server) remove(id string) {
	s.mu.Lock()
	v := s.sessions[id]
	delete(s.sessions, id)
	s.mu.Unlock()
	if v != nil {
		v.close()
	}
}
func (s *server) authorize(w http.ResponseWriter, r *http.Request) bool {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) != 1 {
		http.Error(w, "Unauthorized", 401)
		return false
	}
	return true
}
func (s *server) offer(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r) {
		return
	}
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
		return
	}
	var offer webrtc.SessionDescription
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&offer); err != nil || offer.Type != webrtc.SDPTypeOffer {
		http.Error(w, "Invalid offer", 400)
		return
	}
	s.mu.Lock()
	full := len(s.sessions) >= 2
	s.mu.Unlock()
	if full {
		http.Error(w, "Viewer limit reached", 429)
		return
	}
	pc, err := s.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		http.Error(w, "Peer unavailable", 503)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	v := &session{pc: pc, cancel: cancel}
	idBytes := make([]byte, 16)
	if _, err = rand.Read(idBytes); err != nil {
		v.close()
		http.Error(w, "Session unavailable", 500)
		return
	}
	id := hex.EncodeToString(idBytes)
	success := false
	defer func() {
		if !success {
			s.remove(id)
			v.close()
		}
	}()
	s.mu.Lock()
	if len(s.sessions) >= 2 {
		s.mu.Unlock()
		http.Error(w, "Viewer limit reached", 429)
		return
	}
	s.sessions[id] = v
	s.mu.Unlock()
	ports := make([]int, 0, 2)
	for _, kind := range []string{"video", "audio"} {
		codec := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"}
		if kind == "audio" {
			codec = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"}
		}
		// Desktop feedback must not wait for the audio jitter buffer. Sharing
		// an MSID makes browsers gradually delay video to synchronize audio.
		track, e := webrtc.NewTrackLocalStaticRTP(codec, kind, "mengel-"+kind)
		if e != nil {
			http.Error(w, "Track unavailable", 500)
			return
		}
		sender, e := pc.AddTrack(track)
		if e != nil {
			http.Error(w, "Track unavailable", 500)
			return
		}
		go func() {
			buf := make([]byte, 1500)
			for {
				if _, _, e := sender.Read(buf); e != nil {
					return
				}
			}
		}()
		socket, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if e != nil {
			http.Error(w, "Capture unavailable", 500)
			return
		}
		socket.SetReadBuffer(1024 * 1024)
		v.sockets = append(v.sockets, socket)
		ports = append(ports, socket.LocalAddr().(*net.UDPAddr).Port)
		go func() {
			buf := make([]byte, 2048)
			for {
				n, _, e := socket.ReadFromUDP(buf)
				if e != nil {
					return
				}
				if _, e = track.Write(buf[:n]); e != nil && ctx.Err() != nil {
					return
				}
			}
		}()
	}
	var start sync.Once
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("viewer %s: %s", id, state)
		if state == webrtc.PeerConnectionStateConnected {
			start.Do(func() {
				for _, args := range captureArgs(ports[0], ports[1]) {
					go func(args []string) {
						cmd := exec.CommandContext(ctx, "setpriv", append([]string{"--reuid=box", "--regid=box", "--init-groups", "--pdeathsig", "SIGKILL", "env", "HOME=/home/box", "PULSE_SERVER=unix:/tmp/mengel-audio/native", "ffmpeg"}, args...)...)
						// setpriv execs ffmpeg directly; the death signal also prevents
						// a capture surviving an unexpected media-service exit.
						cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
						cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
						cmd.WaitDelay = 3 * time.Second
						// Bounded status only: no desktop pixels, URLs, or audio are logged.
						output, pipeErr := cmd.StdoutPipe()
						if pipeErr != nil {
							s.remove(id)
							return
						}
						go func() {
							values := map[string]string{}
							scanner := bufio.NewScanner(output)
							for scanner.Scan() {
								pair := strings.SplitN(scanner.Text(), "=", 2)
								if len(pair) != 2 {
									continue
								}
								values[pair[0]] = pair[1]
								if pair[0] == "progress" {
									v.progress.Store(values)
									values = map[string]string{}
								}
							}
						}()
						cmd.Stderr = os.Stderr
						if e := cmd.Run(); e != nil && ctx.Err() == nil {
							log.Printf("capture exited: %v", e)
						}
						s.remove(id)
					}(args)
				}
			})
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			s.remove(id)
		}
		if state == webrtc.PeerConnectionStateDisconnected {
			go func() {
				select {
				case <-time.After(8 * time.Second):
					if pc.ConnectionState() == webrtc.PeerConnectionStateDisconnected {
						s.remove(id)
					}
				case <-ctx.Done():
				}
			}()
		}
	})
	if err = pc.SetRemoteDescription(offer); err != nil {
		http.Error(w, "Unsupported offer", 400)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		http.Error(w, "Answer unavailable", 500)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(answer); err != nil {
		http.Error(w, "Answer unavailable", 500)
		return
	}
	select {
	case <-gathered:
	case <-time.After(8 * time.Second):
		http.Error(w, "ICE timeout", 504)
		return
	case <-r.Context().Done():
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"id": id, "type": "answer", "sdp": pc.LocalDescription().SDP})
	success = true
	go func() {
		select {
		case <-time.After(20 * time.Second):
			if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
				s.remove(id)
			}
		case <-ctx.Done():
		}
	}()
}

// Separate live inputs keep PulseAudio startup and clock correction from
// back-pressuring video capture. WebRTC clocks each RTP track independently.
func captureArgs(videoPort, audioPort int) [][]string {
	return [][]string{
		{"-hide_banner", "-loglevel", "warning", "-nostdin", "-filter_threads", "2", "-stats_period", "1", "-progress", "pipe:1",
			"-thread_queue_size", "4", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "60", "-video_size", "1920x1080", "-i", ":2",
			"-an", "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-rc", "cbr", "-b:v", "10M", "-maxrate", "10M", "-bufsize", "1M", "-g", "60", "-bf", "0", "-zerolatency", "1", "-delay", "0", "-fps_mode", "passthrough", "-f", "rtp", "-payload_type", "96", fmt.Sprintf("rtp://127.0.0.1:%d?pkt_size=1200", videoPort)},
		{"-hide_banner", "-loglevel", "warning", "-nostdin", "-thread_queue_size", "32", "-f", "pulse", "-fragment_size", "3840", "-i", "mengel_output.monitor",
			"-vn", "-c:a", "libopus", "-application", "lowdelay", "-frame_duration", "10", "-ac", "2", "-ar", "48000", "-b:a", "128k", "-f", "rtp", "-payload_type", "111", fmt.Sprintf("rtp://127.0.0.1:%d?pkt_size=1200", audioPort)},
	}
}
func main() {
	token := os.Getenv("SAND_GATEWAY_TOKEN")
	address := os.Getenv("MENGEL_MEDIA_ADDRESS")
	if len(token) < 32 || net.ParseIP(address) == nil {
		log.Fatal("A gateway token and private media address are required")
	}
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 8841})
	if err != nil {
		log.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetICEUDPMux(ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: udp}))
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetNAT1To1IPs([]string{address}, webrtc.ICECandidateTypeHost)
	s := &server{api: webrtc.NewAPI(webrtc.WithSettingEngine(settings)), sessions: map[string]*session{}, token: token}
	mux := http.NewServeMux()
	mux.HandleFunc("/offer", s.offer)
	mux.HandleFunc("/session/", func(w http.ResponseWriter, r *http.Request) {
		if !s.authorize(w, r) {
			return
		}
		if r.Method != "DELETE" {
			http.Error(w, "Method not allowed", 405)
			return
		}
		s.remove(strings.TrimPrefix(r.URL.Path, "/session/"))
		w.WriteHeader(204)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if !s.authorize(w, r) {
			return
		}
		s.mu.Lock()
		n := len(s.sessions)
		captures := []any{}
		for _, viewer := range s.sessions {
			if progress := viewer.progress.Load(); progress != nil {
				captures = append(captures, progress)
			}
		}
		s.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"ready": true, "width": 1920, "height": 1080, "fps": 60, "encoder": "h264_nvenc", "viewers": n, "captures": captures})
	})
	log.Print("Mengel media ready: 1080p60 NVENC, VPN UDP 8841, private signaling")
	httpServer := &http.Server{Addr: "127.0.0.1:8840", Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second}
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-shutdown
		s.mu.Lock()
		ids := []string{}
		for id := range s.sessions {
			ids = append(ids, id)
		}
		s.mu.Unlock()
		for _, id := range ids {
			s.remove(id)
		}
		httpServer.Close()
	}()
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
