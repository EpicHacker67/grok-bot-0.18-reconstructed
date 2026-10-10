import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LOCAL_DOCKER_BOX_CONTAINER } from "../../shared/box-runtime.js";
import { resolveDockerBinary } from "../../shared/node/remote-docker.js";

export const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;
// One SSH/Docker stream, rather than opening a connection for each poll. Only
// CLIPBOARD (explicit Copy), not X11's selection-on-highlight PRIMARY, is read.
export const REMOTE_CLIPBOARD_SCRIPT = String.raw`
import base64, hashlib, json, select, subprocess, sys, tempfile
LIMIT = 16 * 1024 * 1024

def read(target):
    with tempfile.TemporaryFile() as output:
        try:
            result = subprocess.run(['xclip', '-selection', 'clipboard', '-out', '-target', target], stdout=output, stderr=subprocess.DEVNULL, timeout=2)
            if result.returncode or output.tell() > LIMIT:
                return None
            output.seek(0)
            return output.read(LIMIT + 1)
        except subprocess.TimeoutExpired:
            return None

def snapshot():
    targets = read('TARGETS') or b''
    if b'image/png' in targets.splitlines():
        data = read('image/png')
        return ('image/png', data) if data else None
    for target in ['UTF8_STRING', 'text/plain;charset=utf-8', 'text/plain', 'STRING']:
        if target.encode() in targets.splitlines():
            data = read(target)
            if data is not None:
                if target == 'STRING':
                    data = data.decode('latin1').encode('utf-8')
                return ('text/plain', data)
    return None

previous_stamp = read('TIMESTAMP')
initial = snapshot()
previous_hash = hashlib.sha256(initial[0].encode() + initial[1]).digest() if initial else None
print(json.dumps({'ready': True}), flush=True)
while True:
    # Closing the app's stdin also terminates the process inside the container.
    if select.select([sys.stdin], [], [], .25)[0] and not sys.stdin.buffer.read(1):
        break
    stamp = read('TIMESTAMP')
    if stamp is not None and stamp == previous_stamp:
        continue
    value = snapshot()
    after = read('TIMESTAMP')
    if after != stamp:
        continue
    changed_owner = stamp is not None and stamp != previous_stamp
    previous_stamp = stamp
    if value is None:
        previous_hash = None
        continue
    mime, data = value
    digest = hashlib.sha256(mime.encode() + data).digest()
    if digest == previous_hash and not changed_owner:
        continue
    previous_hash = digest
    print(json.dumps({'mime': mime, 'data': base64.b64encode(data).decode('ascii')}), flush=True)
`;

export type RemoteClipboardValue = { mime: "text/plain" | "image/png"; bytes: Buffer };
export function parseRemoteClipboard(value: unknown): RemoteClipboardValue | null {
  if (value == null || typeof value !== "object") return null;
  const { mime, data } = value as { mime?: unknown; data?: unknown };
  if ((mime !== "text/plain" && mime !== "image/png") || typeof data !== "string"
    || data.length > Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4 || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data) || /=/.test(data.slice(0, -2))) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_CLIPBOARD_BYTES) return null;
  if (mime === "image/png" && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { mime, bytes };
}

export function createRemoteClipboardSession(write: (value: RemoteClipboardValue) => void, spawnProcess: typeof spawn = spawn) {
  let owner: number | null = null, child: ChildProcessWithoutNullStreams | null = null;
  let lastPoll = 0, idle: ReturnType<typeof setInterval> | null = null;
  let retryAfter = 0;
  const stop = (sender?: number) => {
    if (sender !== undefined && sender !== owner) return;
    owner = null;
    child?.stdin.end(); child?.kill(); child = null;
    if (idle) clearInterval(idle);
    idle = null;
  };
  const sync = (sender: number): void => {
    lastPoll = Date.now();
    if (owner === sender && child) return;
    if (Date.now() < retryAfter) return;
    stop(); owner = sender;
    const display = process.env.SAND_DOCKER_DISPLAY ?? ":2";
    // Older persistent containers predate xclip. Install it once there; new
    // desktop images include it. No desktop restart or browser changes needed.
    const script = 'set -eu\nif ! command -v xclip >/dev/null; then apt-get update -qq >&2; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xclip >&2; fi\nexec runuser -u box -- env DISPLAY="$1" python3 -u -c "$2"';
    const current = spawnProcess(resolveDockerBinary(), ["exec", "-i", LOCAL_DOCKER_BOX_CONTAINER, "sh", "-c", script, "clipboard", display, REMOTE_CLIPBOARD_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    child = current;
    let buffer = "";
    current.stdout.setEncoding("utf8");
    current.stdout.on("data", (chunk: string) => {
      if (child !== current || owner !== sender) return;
      buffer += chunk;
      if (buffer.length > Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4 + 1024) { stop(sender); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = parseRemoteClipboard(JSON.parse(line));
          if (value && Date.now() - lastPoll < 2000) write(value);
        } catch { /* Ignore malformed clipboard content, never log its data. */ }
      }
    });
    current.stderr.resume();
    current.stdin.on("error", () => {});
    const failed = () => { if (child === current) { stop(sender); retryAfter = Date.now() + 5000; } };
    current.once("error", failed); current.once("close", failed);
    idle = setInterval(() => { if (Date.now() - lastPoll > 3000) stop(sender); }, 1000);
    idle.unref();
  };
  return { sync, stop };
}
