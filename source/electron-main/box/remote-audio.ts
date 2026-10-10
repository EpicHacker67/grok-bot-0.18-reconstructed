import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LOCAL_DOCKER_BOX_CONTAINER } from "../../shared/box-runtime.js";
import { resolveDockerBinary } from "../../shared/node/remote-docker.js";

// A private Unix socket inside Mengel's container. No microphone or new port.
export const REMOTE_AUDIO_SETUP_SCRIPT = `set -eu
exec 9>/tmp/mengel-audio-setup.lock
flock -w 120 9
refresh_chrome_audio=0
if ! command -v pulseaudio >/dev/null || ! command -v pactl >/dev/null || ! dpkg-query -W -f='\${Status}' libasound2-plugins 2>/dev/null | grep -q 'install ok installed'; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends pulseaudio pulseaudio-utils libasound2-plugins
fi
install -d -m 700 -o box -g box /tmp/mengel-audio
install -d -m 700 -o box -g box /home/box/.config /home/box/.config/pulse
install -d /etc/pulse/client.conf.d
# Chrome may use ALSA if it starts before PulseAudio. There is no hardware
# sound card here; route its default device into Mengel's private speaker.
audio_config="$(cat <<'ALSA'
pcm.!default {
  type pulse
  server "unix:/tmp/mengel-audio/native"
}
ctl.!default {
  type pulse
  server "unix:/tmp/mengel-audio/native"
}
ALSA
)"
if [ "$(cat /etc/asound.conf 2>/dev/null || true)" != "$audio_config" ]; then
  refresh_chrome_audio=1
  printf '%s\\n' "$audio_config" > /etc/asound.conf
fi
printf 'default-server = unix:/tmp/mengel-audio/native\nautospawn = no\n' > /etc/pulse/client.conf.d/99-mengel.conf
if ! runuser -u box -- env PULSE_SERVER=unix:/tmp/mengel-audio/native pactl info >/dev/null 2>&1; then
  refresh_chrome_audio=1
  if ! runuser -u box -- env HOME=/home/box XDG_RUNTIME_DIR=/tmp/mengel-audio pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=file:/tmp/mengel-audio/server.log --file=/dev/null --load="module-native-protocol-unix socket=/tmp/mengel-audio/native" --load="module-null-sink sink_name=mengel_output rate=48000 channels=2 sink_properties=device.description=Mengel" --use-pid-file=yes; then
    tail -n 20 /tmp/mengel-audio/server.log >&2
    exit 1
  fi
fi
runuser -u box -- env PULSE_SERVER=unix:/tmp/mengel-audio/native pactl set-default-sink mengel_output
# Chrome caches the missing sound device if it starts before this setup.
# Refresh only its disposable audio workers after the speaker is ready;
# Chrome recreates them without closing tabs or touching browser profiles.
# A normal reconnect leaves working audio uninterrupted.
if [ "$refresh_chrome_audio" = 1 ]; then
  python3 - <<'PY'
import os, pathlib, pwd, signal
box_uid = pwd.getpwnam('box').pw_uid
for process in pathlib.Path('/proc').iterdir():
    if not process.name.isdigit():
        continue
    try:
        if process.stat().st_uid != box_uid or (process / 'comm').read_text().strip() != 'chrome':
            continue
        args = (process / 'cmdline').read_bytes().replace(bytes([0]), b' ').split()
        if b'--utility-sub-type=audio.mojom.AudioService' in args:
            os.kill(int(process.name), signal.SIGTERM)
    except (ProcessLookupError, FileNotFoundError, PermissionError):
        pass
PY
fi
`;

export const REMOTE_AUDIO_CAPTURE_ARGS = ["exec", "--interactive", "--user", "box", "--env", "PULSE_SERVER=unix:/tmp/mengel-audio/native", LOCAL_DOCKER_BOX_CONTAINER,
  "sh", "-c", `exec 3<&0
ffmpeg -hide_banner -loglevel error -nostdin -f pulse -fragment_size 3840 -i mengel_output.monitor -ac 2 -ar 48000 -f f32le pipe:1 &
capture=$!
(cat <&3 >/dev/null; kill "$capture" 2>/dev/null) &
watcher=$!
wait "$capture"
result=$?
kill "$watcher" 2>/dev/null || true
exit "$result"`];

export async function ensureRemoteAudio(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveDockerBinary(), ["exec", LOCAL_DOCKER_BOX_CONTAINER, "sh", "-c", REMOTE_AUDIO_SETUP_SCRIPT], { stdio: ["ignore", "ignore", "pipe"] });
    let detail = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Audio setup timed out. Try sound again.")); }, 180_000);
    child.stderr.on("data", bytes => { detail = (detail + bytes).slice(-1200); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Remote sound could not start: ${detail}`)); });
  });
}

// Bound queued audio to 250 ms, so a hidden or stalled renderer never builds up
// seconds of delayed sound. Reads keep complete stereo float32 sample frames.
export class AudioQueue {
  private bytes = Buffer.alloc(0);
  push(bytes: Buffer): void {
    this.bytes = Buffer.concat([this.bytes, bytes]);
    const excess = this.bytes.length - 96_000;
    if (excess > 0) this.bytes = this.bytes.subarray(Math.ceil(excess / 8) * 8);
  }
  read(): Uint8Array {
    const length = Math.floor(this.bytes.length / 8) * 8;
    const result = Uint8Array.from(this.bytes.subarray(0, length));
    this.bytes = this.bytes.subarray(length);
    return result;
  }
}

export function createRemoteAudioSession() {
  let owner: number | null = null;
  let generation = 0;
  let child: ChildProcessWithoutNullStreams | null = null;
  let queue = new AudioQueue();
  let failure: string | null = null;
  let lastRead = 0;
  let idle: ReturnType<typeof setInterval> | null = null;
  const stop = (id?: number): void => {
    if (id !== undefined && id !== owner) return;
    generation++; owner = null;
    // Closing stdin makes Docker detach; closing its output ends the capture.
    child?.stdin.end(); child?.kill(); child = null;
    if (idle != null) clearInterval(idle);
    idle = null; queue = new AudioQueue();
  };
  return {
    async start(id: number) {
      stop(); owner = id; failure = null;
      const current = generation;
      await ensureRemoteAudio();
      if (generation !== current || owner !== id) return { started: false };
      child = spawn(resolveDockerBinary(), REMOTE_AUDIO_CAPTURE_ARGS, { stdio: ["pipe", "pipe", "pipe"] });
      let detail = "";
      child.stdout.on("data", bytes => { if (generation === current) queue.push(bytes); });
      child.stderr.on("data", bytes => { detail = (detail + bytes).slice(-1200); });
      child.once("error", error => { if (generation === current) failure = error.message; });
      child.once("close", () => { if (generation === current) failure = detail || "Remote sound disconnected. Click to reconnect."; });
      lastRead = Date.now();
      idle = setInterval(() => { if (Date.now() - lastRead > 5000) stop(id); }, 1000);
      idle.unref();
      return { started: true, sampleRate: 48000, channels: 2 };
    },
    read(id: number) {
      if (owner !== id) return { bytes: new Uint8Array(), error: "Remote sound is not connected." };
      lastRead = Date.now();
      return { bytes: queue.read(), error: failure };
    },
    stop,
  };
}
