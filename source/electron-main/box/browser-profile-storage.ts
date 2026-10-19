import { spawn } from "node:child_process";
import { resolveDockerBinary } from "../../shared/node/remote-docker.js";

// Keep both the desktop browser (including Fork-* profiles and its machine ID)
// and the browser opened by computer tools across container replacement.
export const BROWSER_PROFILE_PATHS = [
  ["chrome", "/home/box/chrome-profile"],
  ["agent-chrome", "/home/box/agent-chrome"],
  ["google-chrome", "/home/box/.config/google-chrome"],
  ["keyrings", "/home/box/.local/share/keyrings"],
] as const;

export function browserProfileMounts(remote = Boolean(process.env.SAND_REMOTE_DOCKER_SSH)): string[] {
  const prefix = remote ? "mengel-holly" : "grok-bot-local-vm";
  return BROWSER_PROFILE_PATHS.flatMap(([name, path]) => ["--volume", `${prefix}-${name}:${path}`]);
}

interface Result { ok: boolean; output: string }
type RunDocker = (args: readonly string[]) => Promise<Result>;

// Stream archives without decoding them as text or retaining cookies in logs.
async function copyProfile(source: readonly string[], destination: readonly string[]): Promise<Result> {
  const reader = spawn(resolveDockerBinary(), [...source], { stdio: ["ignore", "pipe", "pipe"] });
  const writer = spawn(resolveDockerBinary(), [...destination], { stdio: ["pipe", "ignore", "pipe"] });
  reader.stdout.pipe(writer.stdin);
  writer.stdin.on("error", () => reader.kill());
  let detail = "";
  for (const child of [reader, writer]) child.stderr.on("data", bytes => { detail = (detail + bytes).slice(-2000); });
  const results = await Promise.all([reader, writer].map(child => new Promise<boolean>(resolve => {
    child.once("error", error => { detail = error.message; reader.kill(); writer.kill(); resolve(false); });
    child.once("close", code => resolve(code === 0));
  })));
  return { ok: results.every(Boolean), output: detail };
}

const PREPARE_PROFILE = `set -eu
install -d -m 700 -o box -g box /profile
# A stopped/replaced container cannot own these process locks any longer.
find /profile -maxdepth 2 -type l \\( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie \\) -delete
`;
const IMPORT_PROFILE = `set -eu
source_id="$1"
if [ "$(cat /profile/.mengel-migrated-from 2>/dev/null || true)" != "$source_id" ] && find /profile -mindepth 1 -maxdepth 1 ! -name .mengel-import -print -quit | read -r unused; then
  echo 'Refusing to overwrite an existing browser volume.' >&2
  exit 1
fi
rm -rf /profile/.mengel-import
mkdir -p /profile/.mengel-import
tar -xpf - -C /profile/.mengel-import
# Retrying migration must also preserve changes made after a failed attempt
# restarted the old computer. Replace only our copy, after extraction succeeds.
find /profile -mindepth 1 -maxdepth 1 ! -name .mengel-import -exec rm -rf -- {} +
cp -a /profile/.mengel-import/. /profile/
rm -rf /profile/.mengel-import
printf '%s\\n' "$source_id" > /profile/.mengel-migrated-from
${PREPARE_PROFILE}`;

export async function preserveBrowserProfiles(container: string, image: string, run: RunDocker, copy = copyProfile): Promise<void> {
  const result = await run(["inspect", "--format", "{{json .}}", container]);
  if (!result.ok) throw new Error("Could not inspect the computer before preserving its browser profiles.");
  const state = JSON.parse(result.output) as { Id: string; State: { Running: boolean }; Mounts: { Name?: string; Destination: string }[] };
  const wasRunning = state.State.Running;
  if (wasRunning) {
    const stopped = await run(["stop", "--time", "30", container]);
    if (!stopped.ok) throw new Error("Could not stop the computer safely to preserve its browser profiles.");
  }
  try {
    const mounts = browserProfileMounts();
    for (let index = 0; index < BROWSER_PROFILE_PATHS.length; index++) {
      const [, path] = BROWSER_PROFILE_PATHS[index]!;
      const volume = mounts[index * 2 + 1]!.split(":")[0]!;
      const helper = ["run", "--rm", "--interactive", "--network", "none", "--user", "0", "--volume", `${volume}:/profile`, "--entrypoint", "/bin/sh", image];
      if (!state.Mounts.some(mount => mount.Destination === path && mount.Name === volume)) {
        const copied = await copy(["cp", `${container}:${path}/.`, "-"], [...helper, "-c", IMPORT_PROFILE, "sh", state.Id]);
        // Some installations have never launched the secondary browser. Its
        // missing profile is the only copy failure that can safely be ignored.
        if (!copied.ok && !/Could not find the file .* in container/i.test(copied.output)) {
          throw new Error(`Could not preserve ${path}; the old computer has been kept. ${copied.output}`);
        }
      }
      const prepared = await run([...helper.filter(value => value !== "--interactive"), "-c", PREPARE_PROFILE]);
      if (!prepared.ok) throw new Error(`Could not prepare persistent browser storage: ${prepared.output}`);
    }
  } catch (error) {
    if (wasRunning) await run(["start", container]);
    throw error;
  }
}
