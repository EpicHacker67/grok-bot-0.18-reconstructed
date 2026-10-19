import { ensureRemoteAudio } from "./remote-audio.js";
import { browserProfileMounts, preserveBrowserProfiles } from "./browser-profile-storage.js";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCAL_DOCKER_BOX_CONTAINER } from "../../shared/box-runtime.js";
import { resolveDockerBinary, stageRemoteDockerDirectory } from "../../shared/node/remote-docker.js";
import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import type { SandRemoteHostConnector } from "./box-host-connector.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";

export const LOCAL_DOCKER_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:289490f863d51a698c900839943311ba30e850efea0d6911edf62e7c07b50fe3";
export { LOCAL_DOCKER_BOX_CONTAINER };
export const LOCAL_DOCKER_GATEWAY_URL = "http://127.0.0.1:1340";
export const LOCAL_DOCKER_OWNER_LABEL = "com.grok-bot.local-vm=1";
export const LOCAL_DOCKER_SCHEMA_VERSION = "9";
const READY_TIMEOUT_MS = 180_000;
const OPTIONAL_CREDENTIAL_TIMEOUT_MS = 3_000;

export interface LocalDockerStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly containerName: string;
  readonly image: string;
  readonly detail: string;
}

interface CommandResult { readonly ok: boolean; readonly output: string }
interface InferenceCredential { readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number }
interface LocalHostBundle { readonly path: string; readonly sha256: string; readonly boxExecDaemonPath: string; readonly boxExecDaemonSha256: string }

function runDocker(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(resolveDockerBinary(), [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => resolve({ ok: false, output: `${output}\n${error.message}`.trim() }));
    child.once("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

function credentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-vm.json");
}

function inferenceCredentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-credential", "inference.json");
}

async function persistInferenceCredential(settingsPath: string, credential: InferenceCredential): Promise<string> {
  const target = inferenceCredentialPath(settingsPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ accessToken: credential.accessToken, expiresAtMs: credential.expiresAtMs })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  const remote = await stageRemoteDockerDirectory(dirname(target), "credential");
  return join(remote, "inference.json");
}

async function readOrCreateToken(settingsPath: string): Promise<string> {
  const target = credentialPath(settingsPath);
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.length >= 32) return parsed.token;
  } catch {}
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ schemaVersion: 1, token }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
  return token;
}

async function gatewayReady(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${LOCAL_DOCKER_GATEWAY_URL}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch { return false; }
}

async function verifyRunningHost(token: string, expectedSha256: string): Promise<void> {
  const response = await fetch(`${LOCAL_DOCKER_GATEWAY_URL}/health`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000),
  });
  const health = await response.json() as { pid?: unknown };
  if (!Number.isInteger(health.pid) || Number(health.pid) < 1) throw new Error("Computer gateway did not report its host process.");
  const script = `const fs=require('fs'),crypto=require('crypto');const argv=fs.readFileSync('/proc/'+process.argv[1]+'/cmdline','utf8').split('\\0');const entry=argv.find(p=>p.endsWith('/host-main.cjs'));if(!entry)process.exit(2);console.log(crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex'));`;
  const result = await runDocker(["exec", LOCAL_DOCKER_BOX_CONTAINER, "/exec-daemon/node", "-e", script, String(health.pid)]);
  if (!result.ok || result.output !== expectedSha256) throw new Error("Computer is not running Mengel's reconstructed host; refusing to connect to a stock host.");
}

async function inspectContainer(): Promise<{ exists: boolean; running: boolean; owned: boolean; image: string; hostSha256: string; hasInferenceCredential: boolean; schemaVersion: string }> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!result.ok) return { exists: false, running: false, owned: false, image: "", hostSha256: "", hasInferenceCredential: false, schemaVersion: "" };
  try {
    const value = JSON.parse(result.output) as { State?: { Running?: unknown }; Config?: { Image?: unknown; Labels?: Record<string, unknown> } };
    return {
      exists: true,
      running: value.State?.Running === true,
      owned: value.Config?.Labels?.["com.grok-bot.local-vm"] === "1",
      image: typeof value.Config?.Image === "string" ? value.Config.Image : "",
      hostSha256: typeof value.Config?.Labels?.["com.grok-bot.local-vm.host-sha256"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.host-sha256"] as string : "",
      hasInferenceCredential: value.Config?.Labels?.["com.grok-bot.local-vm.inference-credential"] === "1",
      schemaVersion: typeof value.Config?.Labels?.["com.grok-bot.local-vm.schema-version"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.schema-version"] as string : "",
    };
  } catch { throw new Error("Docker returned malformed container inspection data."); }
}

export async function getLocalDockerStatus(settingsPath: string): Promise<LocalDockerStatus> {
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) return { available: false, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: daemon.output || "Docker is not running." };
  const inspected = await inspectContainer();
  if (!inspected.exists) return { available: true, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: "Ready to create the local VM." };
  if (!inspected.owned) return { available: true, running: inspected.running, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: `Container ${LOCAL_DOCKER_BOX_CONTAINER} exists but is not owned by Grok Bot.` };
  const ready = inspected.running && await gatewayReady(await readOrCreateToken(settingsPath));
  return { available: true, running: inspected.running, ready, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: ready ? "Local Docker VM is ready." : inspected.running ? "Container is starting." : "Local Docker VM is stopped." };
}

let ensureInFlight: Promise<GatewayConnection> | undefined;

// Make the streamed box display (:2, what the desktop app shows) feel more
// responsive. The box image starts x11vnc with `-noxdamage`, which polls the
// whole framebuffer every cycle — wasteful under emulation. x11vnc's live
// remote control (-R, over an X property) lets us switch it to damage-based
// updates and cut the defer/poll latency on the running instance, without
// restarting it or fighting the desktop supervisor. Re-applied on every connect
// so it survives box recreation; retried because the desktop comes up shortly
// after the gateway is ready.
async function tuneBoxStream(): Promise<void> {
  const display = process.env.SAND_DOCKER_DISPLAY ?? ":2";
  if (!/^:[0-9]+$/.test(display)) return;
  // damage-based updates, low defer/poll latency, and progressive:0 so updates
  // are sent whole and immediately rather than in progressive vertical bands.
  // (ncache client-side caching is deliberately not set: it is a startup-only
  // option that resizes the framebuffer and can show through with noVNC, and it
  // cannot be toggled on a running instance.)
  const commands = `x11vnc -display ${display} -sync -R xdamage >/dev/null 2>&1; x11vnc -display ${display} -sync -R defer:3 >/dev/null 2>&1; x11vnc -display ${display} -sync -R wait:5 >/dev/null 2>&1; x11vnc -display ${display} -sync -R progressive:0 >/dev/null 2>&1; x11vnc -display ${display} -Q noxdamage 2>/dev/null`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await runDocker(["exec", "-e", `DISPLAY=${display}`, LOCAL_DOCKER_BOX_CONTAINER, "bash", "-lc", commands]).catch(() => ({ ok: false, output: "" }));
    if (result.ok && result.output.includes("noxdamage:0")) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function stageCurrentHostBundle(settingsPath: string): Promise<LocalHostBundle> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const readRuntime = async (relative: string): Promise<Buffer> => {
    const candidates = [resolve(moduleDirectory, `../${relative}`), resolve(moduleDirectory, `../../${relative}`)];
    for (const candidate of candidates) {
      try { return await readFile(candidate); } catch {}
    }
    throw new Error(`The reconstructed runtime is unavailable at ${candidates.join(" or ")}; refusing to start a stock local VM.`);
  };
  const hostBytes = await readRuntime("host/host-main.cjs");
  const boxExecDaemonBytes = await readRuntime("box-exec-daemon/main.cjs");
  const agentWorkerBytes = await readRuntime("host/agent-isolation/agent-store-worker.cjs");
  const transcriptWorkerBytes = await readRuntime("host/agent-isolation/transcript-mirror-worker.cjs");
  const sha256 = createHash("sha256").update(hostBytes).digest("hex");
  const boxExecDaemonSha256 = createHash("sha256").update(boxExecDaemonBytes).digest("hex");
  const directory = join(dirname(settingsPath), "local-docker-runtime", `${sha256}-${boxExecDaemonSha256}`);
  const persistRuntime = async (name: string, bytes: Buffer): Promise<string> => {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw new Error(`Content-addressed local runtime ${target} has unexpected bytes.`);
    } catch (error) {
      if (error instanceof Error && !Reflect.has(error, "code")) throw error;
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
    }
    return target;
  };
  await mkdir(directory, { recursive: true });
  await persistRuntime("host-main.cjs", hostBytes);
  await persistRuntime("box-exec-daemon/main.cjs", boxExecDaemonBytes);
  await persistRuntime("agent-isolation/agent-store-worker.cjs", agentWorkerBytes);
  await persistRuntime("agent-isolation/transcript-mirror-worker.cjs", transcriptWorkerBytes);
  const staged = await stageRemoteDockerDirectory(directory, `runtime/${sha256}-${boxExecDaemonSha256}`);
  return {
    path: join(staged, "host-main.cjs"),
    sha256,
    boxExecDaemonPath: join(staged, "box-exec-daemon/main.cjs"),
    boxExecDaemonSha256,
  };
}

async function localAuthMountArguments(): Promise<string[]> {
  // Local provider sessions stay on the Mac; routed inference runs there.
  if (process.env.SAND_REMOTE_DOCKER_SSH) return [];
  const mounts: string[] = [];
  for (const [source, destination] of [[join(homedir(), ".codex"), "/root/.codex"], [join(homedir(), ".claude"), "/root/.claude"]] as const) {
    if (await isDirectory(source)) mounts.push("--mount", `type=bind,src=${source},dst=${destination},readonly`);
  }
  return mounts;
}

async function ensureLocalDockerBox(settingsPath: string, inferenceCredential?: InferenceCredential): Promise<GatewayConnection> {
  const image = process.env.SAND_DOCKER_GPU_IMAGE ?? LOCAL_DOCKER_BOX_IMAGE;
  const token = await readOrCreateToken(settingsPath);
  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) throw new Error(`Local Docker VM is selected, but Docker is unavailable: ${daemon.output || "start Docker and try again"}`);
  const inspected = await inspectContainer();
  if (inspected.exists && !inspected.owned) throw new Error(`Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.`);
  if (inspected.exists && inspected.image !== LOCAL_DOCKER_BOX_IMAGE && inspected.image !== image) throw new Error(`Local Docker VM container uses unexpected image ${inspected.image}. Remove it explicitly before changing images.`);
  if (inspected.exists && (inspected.image !== image || inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || inspected.hostSha256 !== hostBundle.sha256 || (inferenceCredential != null && !inspected.hasInferenceCredential))) {
    await preserveBrowserProfiles(LOCAL_DOCKER_BOX_CONTAINER, LOCAL_DOCKER_BOX_IMAGE, runDocker);
    const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!removed.ok) throw new Error(`Could not replace the local VM with the current app runtime: ${removed.output}`);
  }
  const shouldReplace = inspected.exists && (inspected.image !== image || inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || inspected.hostSha256 !== hostBundle.sha256 || (inferenceCredential != null && !inspected.hasInferenceCredential));
  const current = shouldReplace ? await inspectContainer() : inspected;
  if (current.exists && !current.running) {
    const started = await runDocker(["start", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!started.ok) throw new Error(`Could not start the local Docker VM: ${started.output}`);
  } else if (!current.exists) {
    const authMounts = await localAuthMountArguments();
    const created = await runDocker([
      "run", "--detach", "--name", LOCAL_DOCKER_BOX_CONTAINER,
      "--label", LOCAL_DOCKER_OWNER_LABEL, "--label", `com.grok-bot.local-vm.host-sha256=${hostBundle.sha256}`,
      "--label", `com.grok-bot.local-vm.box-exec-daemon-sha256=${hostBundle.boxExecDaemonSha256}`,
      "--label", `com.grok-bot.local-vm.inference-credential=${inferenceCredential == null ? "0" : "1"}`,
      "--label", `com.grok-bot.local-vm.schema-version=${LOCAL_DOCKER_SCHEMA_VERSION}`,
      "--platform", "linux/amd64", "--restart", "unless-stopped",
      ...(process.env.SAND_DOCKER_GPU_IMAGE ? ["--device", "nvidia.com/gpu=0", "--shm-size", "1g", "--env", `MENGEL_MEDIA_ADDRESS=${process.env.SAND_DOCKER_MEDIA_ADDRESS}`, "--publish", `${process.env.SAND_DOCKER_MEDIA_ADDRESS}:8841:8841/udp`] : []),
      "--env", "SAND_SUPERVISOR_ENABLED=1", "--env", "SAND_BOX_AUTO_UPDATE=0", "--env", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1", "--env", "SAND_TREE_SITTER_NODE_DEPS=/opt/sand/deps", "--env", "NODE_PATH=/opt/sand/deps", "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0", "--env", "SAND_HOST_PORT=1340", "--env", `SAND_GATEWAY_TOKEN=${token}`,
      "--env", "SAND_BOX_STORE_SYNC=0", "--env", "SAND_BOX_STORE_COPY_IN=0", "--env", "SAND_STATE_S3_BACKSTOP=0",
      ...(process.env.SAND_REMOTE_DOCKER_SSH ? ["--env", "SAND_BACKEND_URL=http://127.0.0.1:9"] : []),
      ...(inferenceCredential == null ? [] : ["--env", "SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json", "--env", `SAND_BACKEND_URL=${inferenceCredential.backendUrl}`]),
      "--publish", "127.0.0.1:1337:1337", "--publish", "127.0.0.1:1339:1339", "--publish", "127.0.0.1:1340:1340",
      "--publish", "127.0.0.1:6080:6080", "--publish", "127.0.0.1:6081:6081", "--publish", "127.0.0.1:8790:8790",
      "--volume", `${process.env.SAND_REMOTE_DOCKER_SSH ? "mengel-holly" : "grok-bot-local-vm"}-workspace:/workspace`, "--volume", `${process.env.SAND_REMOTE_DOCKER_SSH ? "mengel-holly" : "grok-bot-local-vm"}-data:/home/box/sand-data`,
      ...browserProfileMounts(),
      "--mount", `type=bind,src=${hostBundle.path},dst=/home/box/sand-host/host-main.cjs,readonly`,
      "--mount", `type=bind,src=${hostBundle.path},dst=/opt/sand/sand-host/host-main.cjs,readonly`,
      "--mount", `type=bind,src=${join(dirname(hostBundle.path), "agent-isolation")},dst=/opt/sand/sand-host/agent-isolation,readonly`,
      "--mount", `type=bind,src=${dirname(hostBundle.boxExecDaemonPath)},dst=/home/box/box-exec-daemon,readonly`,
      ...(inferenceFile == null ? [] : ["--mount", `type=bind,src=${dirname(inferenceFile)},dst=/run/grok-bot,readonly`]),
      ...authMounts,
      image,
    ]);
    if (!created.ok) throw new Error(`Could not create the local Docker VM: ${created.output}`);
  }
  // Docker creates missing parents of nested volume mounts as root. Restore
  // the desktop user's directories before Chrome/PulseAudio need to write them.
  const homeDirectories = await runDocker(["exec", "--user", "0", LOCAL_DOCKER_BOX_CONTAINER, "install", "-d", "-m", "700", "-o", "box", "-g", "box", "/home/box/.config", "/home/box/.local", "/home/box/.local/share"]);
  if (!homeDirectories.ok) throw new Error(`Could not prepare the computer's application settings: ${homeDirectories.output}`);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(token)) { await verifyRunningHost(token, hostBundle.sha256); void tuneBoxStream(); void ensureRemoteAudio().catch(error => console.warn("[mengel:audio]", error.message)); return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token }; }
    const state = await inspectContainer();
    if (!state.running) {
      const logs = await runDocker(["logs", "--tail", "80", LOCAL_DOCKER_BOX_CONTAINER]);
      throw new Error(`Local Docker VM stopped before its gateway became ready.\n${logs.output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Local Docker VM did not expose its gateway within three minutes.");
}

export async function startLocalDockerBox(settingsPath: string): Promise<GatewayConnection> {
  return await ensureLocalDockerBox(settingsPath);
}

export async function stopLocalDockerBox(): Promise<void> {
  const inspected = await inspectContainer();
  if (!inspected.exists || !inspected.running) return;
  if (!inspected.owned) throw new Error(`Refusing to stop unowned container ${LOCAL_DOCKER_BOX_CONTAINER}.`);
  const stopped = await runDocker(["stop", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!stopped.ok) throw new Error(`Could not stop the local Docker VM: ${stopped.output}`);
}

export function createSettingsRoutedHostConnector(
  remote: SandRemoteHostConnector,
  settings: SandSettingsStore,
): SandRemoteHostConnector {
  const localConnect = (): Promise<GatewayConnection> => {
    if (ensureInFlight == null) ensureInFlight = (async () => {
      const issued = process.env.SAND_REMOTE_DOCKER_SSH || remote.issueInferenceCredential == null ? undefined : await Promise.race([
        remote.issueInferenceCredential(),
        new Promise<undefined>((resolve) => setTimeout(resolve, OPTIONAL_CREDENTIAL_TIMEOUT_MS)),
      ]);
      return await ensureLocalDockerBox(settings.settingsPath, issued);
    })().finally(() => { ensureInFlight = undefined; });
    return ensureInFlight;
  };
  return {
    connect: async () => settings.getBoxRuntime() === "local-docker" ? await localConnect() : await remote.connect(),
    ...(remote.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote) }),
    ...(remote.issueInferenceCredential == null ? {} : { issueInferenceCredential: remote.issueInferenceCredential.bind(remote) }),
    recreate: async (args): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.recreate == null) throw new Error("Remote computer recreation is unavailable.");
        return await remote.recreate(args);
      }
      const stopped = await runDocker(["restart", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!stopped.ok) throw new Error(`Could not restart the local Docker VM: ${stopped.output}`);
      await localConnect();
      return { status: "started-untrackable" };
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.forceRecreate == null) return { status: "rejected", reason: "Remote computer reset is unavailable." };
        return await remote.forceRecreate();
      }
      const inspected = await inspectContainer();
      if (inspected.exists) {
        if (!inspected.owned) return { status: "rejected", reason: "Refusing to replace an unowned container." };
        await preserveBrowserProfiles(LOCAL_DOCKER_BOX_CONTAINER, LOCAL_DOCKER_BOX_IMAGE, runDocker);
      }
      const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected", reason: removed.output };
      await localConnect();
      return { status: "started-untrackable" };
    },
  };
}
