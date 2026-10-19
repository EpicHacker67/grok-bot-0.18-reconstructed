import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Optional per-profile configuration. Inherited by the coordinator so its
// computer controls use the same Docker daemon as the desktop connector.
export function configureRemoteDocker(dataRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = join(dataRoot, "remote-docker.json");
  if (!existsSync(file)) return;
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (typeof config.sshHost !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(config.sshHost)
    || typeof config.root !== "string" || !/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(config.root)) {
    throw new Error("remote-docker.json requires a safe SSH host and absolute remote root.");
  }
  env.DOCKER_HOST = `ssh://${config.sshHost}`;
  env.SAND_REMOTE_DOCKER_SSH = config.sshHost;
  env.SAND_REMOTE_DOCKER_ROOT = config.root;
  if (config.display != null && !/^:[0-9]+$/.test(config.display)) throw new Error("Invalid remote Docker display.");
  env.SAND_DOCKER_DISPLAY = config.display ?? ":2";
  if (config.gpuDesktop != null) {
    const { image, mediaAddress } = config.gpuDesktop;
    if (typeof image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(image)
      || typeof mediaAddress !== "string" || !/^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})$/.test(mediaAddress)
      || mediaAddress.split(".").some((part: string) => Number(part) > 255)) {
      throw new Error("GPU desktop requires a pinned image and a private Tailscale IPv4 address.");
    }
    env.SAND_DOCKER_GPU_IMAGE = image;
    env.SAND_DOCKER_MEDIA_ADDRESS = mediaAddress;
  }
}

export function resolveDockerBinary(): string {
  const candidates = [process.env.DOCKER_BINARY,
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map(p => join(p, "docker")),
    "/usr/local/bin/docker", "/opt/homebrew/bin/docker", join(homedir(), ".docker/bin/docker"),
    "/Applications/Docker.app/Contents/Resources/bin/docker"];
  return candidates.find(p => p != null && existsSync(p)) ?? "docker";
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out staging the remote computer.`)); }, 120_000);
    child.stderr.on("data", chunk => { error = (error + chunk).slice(-4000); });
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${command} failed: ${error}`)); });
  });
}

export async function stageRemoteDockerDirectory(local: string, relative: string): Promise<string> {
  const host = process.env.SAND_REMOTE_DOCKER_SSH;
  const root = process.env.SAND_REMOTE_DOCKER_ROOT;
  if (!host || !root) return local;
  if (!/^[a-zA-Z0-9/-]+$/.test(relative)) throw new Error("Invalid remote staging path.");
  const target = `${root}/${relative}`;
  await run("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, `umask 077; mkdir -p '${target}'`]);
  await run("/usr/bin/rsync", ["-a", "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=10", `${local}/`, `${host}:${target}/`]);
  return target;
}
