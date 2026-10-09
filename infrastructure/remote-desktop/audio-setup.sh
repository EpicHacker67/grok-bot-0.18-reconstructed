set -eu
exec 9>/tmp/mengel-audio-setup.lock
flock -w 120 9
refresh_chrome_audio=0
if ! command -v pulseaudio >/dev/null || ! command -v pactl >/dev/null || ! dpkg-query -W -f='${Status}' libasound2-plugins 2>/dev/null | grep -q 'install ok installed'; then
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
  printf '%s\n' "$audio_config" > /etc/asound.conf
fi
printf 'default-server = unix:/tmp/mengel-audio/native
autospawn = no
' > /etc/pulse/client.conf.d/99-mengel.conf
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
