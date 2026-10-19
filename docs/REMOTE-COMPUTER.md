# Run Mengel's computer on Holly

Mengel manages its own Docker computer over SSH. The app and routed provider
authentication stay on the Mac. The Linux desktop, workspace, and Mengel agent
data run on Holly. The remote host receives no Grok Bot inference credential,
uses a disabled upstream backend, and has cloud data synchronization disabled.
No Docker API or desktop ports are exposed publicly.

Build and install the current Mengel app, quit it, then run:

```sh
node scripts/connect-remote-docker.mjs holly@holly-ms-7d70 /home/holly/mengel-computer "$HOME/Library/Application Support/Mengel/sand-data"
```

Start Mengel normally. Keep the Router's **Use local Docker VM** toggle enabled;
with this profile's `remote-docker.json`, that option uses Holly's Docker daemon.
Runtime bundles are synchronized over SSH before connecting. Local Codex and
Claude directories are not copied. Use Claude Code, Codex, or OpenRouter for
inference; the independent host does not connect to the Grok Bot account backend.
The normal Docker restart and reset actions operate on Holly.

The container is `grok-bot-local-vm`, with restart policy `unless-stopped`.
Docker volumes `mengel-holly-workspace` and `mengel-holly-data` preserve
the workspace and box data separately from earlier Grok Bot containers. The
browser profiles also have dedicated `mengel-holly-chrome`,
`mengel-holly-agent-chrome`, `mengel-holly-google-chrome`, and
`mengel-holly-keyrings` volumes. These retain Chrome accounts, cookies, local
storage, and profile state across computer restarts, resets, and app updates.
Before replacing an older container, Mengel stops it and copies its existing
profiles into these volumes. If the copy fails, replacement stops and the old
computer is retained. This cannot recover sessions already lost before migration;
websites can still expire or revoke their own sessions.
The
base image is pinned by digest. Mengel mounts its reconstructed host at the
image's actual `/opt/sand/sand-host/host-main.cjs` entry point and verifies the
running gateway process's bundle hash before connecting, preventing a silent
fallback to the stock Grok Bot host. Its agent desktop uses display `:2`;
`display` in `remote-docker.json` can override that for a different image.
The Mac's `com.mengel.remote-computer-tunnel` LaunchAgent forwards ports 1337,
1339, 1340, 6080, 6081, and 8790 on loopback and reconnects after network loss
or login. A local Docker computer cannot use these same ports simultaneously.

Check the container using `ssh holly@holly-ms-7d70 docker ps` and tunnel errors
in the profile's `remote-docker-tunnel.log`. To switch back, quit Mengel, unload
the tunnel with `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.mengel.remote-computer-tunnel.plist`,
remove that plist and the profile's `remote-docker.json`, then restart Mengel.
Stop the Holly container separately when it is no longer needed; its volumes
remain available.

## Remote browser zoom

Click inside the computer view, then use **⌘+plus** (or **⌘+=**) to zoom in,
**⌘+minus** to zoom out, and **⌘+0** to reset the remote browser. These
shortcuts act on Mengel itself when its interface has focus. The video surface
stays at its original scale so clicks remain aligned with the picture.

## Clipboard

While the computer view is open, copying text or an image inside the remote
computer updates the Mac clipboard automatically. Use **⌘+C** for selected text,
or Chrome's **Copy image** context-menu command for an image. PNG images up to
16 MiB are transferred as native clipboard images. Merely highlighting text does
not replace the Mac clipboard. Closing the computer view stops the bridge.

Text copied on the Mac can still be pasted into the remote computer. Local Docker
uses a single private SSH/Docker stream for clipboard changes; older containers
install `xclip` on first use. Other desktop backends retain the text-only VNC bridge.

## Remote sound

Open the computer view to hear audio from applications in the container. The
**speaker icon** in its lower-right corner mutes or unmutes playback. Drag
the adjacent slider to adjust volume. The volume and mute preference are
remembered; unmuting restores the previous level. The controls fade after three
seconds without interaction with the volume control and return when you hover
over its area or focus it with the keyboard. Browser activity does not reset this
timer. They stay visible during a drag; fading does not interrupt audio. If playback needs a browser
gesture, click the speaker icon. Closing or hiding the computer view stops capture and playback,
and the small chat preview stays silent to avoid duplicate sound.

Mengel provisions a PulseAudio virtual speaker in its container on connection
and after recreation. Stereo output travels through the existing Docker/SSH
connection. No microphone, additional public port, or host audio device is used.
If Chrome started before the speaker was ready, setup refreshes its audio
workers so existing tabs can play sound. Browser tabs and profiles remain open;
normal audio reconnects do not restart the workers.
If the connection drops, click the speaker icon to reconnect.

## GPU desktop and streaming

The optional GPU image in `infrastructure/remote-desktop` uses NVIDIA-backed
Xorg on display `:2` at 1920×1080. Chrome uses GPU rendering, with a 1 GiB shared
memory allocation. The headless compositor redraws without physical-display
VSync or frame pacing, which otherwise repeats stale frames. Video and audio
have separate capture processes so PulseAudio startup cannot stall video. They
also use separate WebRTC stream IDs: desktop video stays responsive instead of
waiting for the audio jitter buffer. Audio capture uses continuous 48 kHz sample
timestamps and 10 ms Opus frames. Current clients receive those frames on an
unordered WebRTC data channel without retransmission, decode with WebCodecs, and
schedule playback against their capture times. The playback target is 120 ms
with a 150 ms queue ceiling; stale packets and decoder backlogs are discarded.
These limits exclude capture, network, and device output latency. They reduce
accumulating audio delay without adding video/input delay, but long network gaps
can still cause short audio dropouts. Older clients or unavailable decoders use
the standard RTP audio track, whose adaptive buffering can be longer.
A private Go/Pion service captures the desktop at 60 fps,
encodes H.264 using NVENC, and sends video plus Opus audio over WebRTC. Mengel enables hardware decoding and compositing on the Mac. The app
keeps VNC for input, clipboard, previews, and automatic fallback. Its existing
speaker and volume controls also control WebRTC audio. Hidden viewers stop their
stream; failed streams fall back to VNC and retry after ten seconds.

Build on a Linux host with NVIDIA CDI support:

```sh
docker build -t mengel-desktop:gpu-v1 infrastructure/remote-desktop
docker image inspect mengel-desktop:gpu-v1 --format '{{.Id}}'
```

Add `gpuDesktop` to the existing profile's `remote-docker.json`, with `image`
set to that immutable `sha256:…` image ID and `mediaAddress` set to Holly's
Tailscale IPv4 address. Restart Mengel. The connector preserves its browser
volumes when replacing the base container. This image currently targets Holly's
NVIDIA GPU at PCI `1:0:0`; adjust `xorg.conf` when moving to another host.

Only UDP port 8841 is published, bound specifically to the VPN address. It carries
encrypted WebRTC media. HTTP signaling is loopback-only inside the container,
uses the existing gateway credential, and is reached through authenticated
Docker/SSH. No streaming credentials reach the renderer. Without VPN media
connectivity the viewer falls back to the existing SSH-tunneled VNC path.

The standalone `verify-client.cjs` runs a disposable Electron receiver on the
Mac. Its default target is the isolated `mengel-gpu-preview` validation container;
it writes frame statistics and a screenshot under `/tmp/mengel-stream-*`.
Set `MENGEL_TEST_PACKET_AUDIO=1` to exercise the bounded audio receiver;
`MENGEL_TEST_CONTAINER=grok-bot-local-vm` selects the live container.
`audio-sync-check.html` provides a finite tone/flash test with an immediate pause
button.
Run the Go service's authentication, capture-clock, and cleanup tests with `go test -race ./...`
from `infrastructure/remote-desktop/streamer`.

The authenticated `/health` endpoint on container loopback port 8840 also reports
active capture frame rate and encoding speed. Viewer frame, drop, decode-time,
and audio-energy counters are available on the local VNC page’s document dataset
for diagnostics. `MENGEL_DISABLE_GPU=1` provides a Mac software-rendering escape
hatch; it is off by default. The `stream-check.html` page is a manual motion and
sound fixture, not part of the product UI. When checking motion, measure changes
in the moving dot as well as decoded FPS: a compositor can repeat the same
picture while both Chrome and WebRTC still report 60 fps.
