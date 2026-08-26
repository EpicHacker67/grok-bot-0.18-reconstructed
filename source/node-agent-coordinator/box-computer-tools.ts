import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { LOCAL_DOCKER_BOX_CONTAINER } from "../shared/box-runtime.js";

// A GUI-launched app inherits a minimal PATH that usually omits /usr/local/bin,
// so resolve the docker CLI from the common install locations rather than
// relying on PATH.
function resolveDockerBinary(): string {
  const candidates = [
    process.env.DOCKER_BINARY,
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "docker")),
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    join(homedir(), ".docker", "bin", "docker"),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  for (const candidate of candidates) if (candidate != null && candidate.length > 0 && existsSync(candidate)) return candidate;
  return "docker";
}

const DOCKER_BINARY = resolveDockerBinary();

// Computer tools that let a routed agent (Claude Code / Codex) drive the local
// Docker box the same way the native agent drives its cloud computer. They shell
// into the running container with `docker exec`, so they are only meaningful
// while the box runtime is "local-docker". The container exposes an X display on
// :1 (1280x800) with Chrome and xdotool, and ffmpeg captures that display.

const BOX_DISPLAY = ":1";
const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
const MAX_SHELL_TIMEOUT_MS = 300_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

type McpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface McpToolResult {
  readonly content: McpContent[];
  readonly isError?: boolean;
}

export interface BoxComputerTools {
  list(): McpToolDefinition[];
  call(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

interface ExecResult { readonly code: number | null; readonly stdout: Buffer; readonly stderr: string; readonly timedOut: boolean }

function runDockerExec(dockerArgs: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(DOCKER_BINARY, ["exec", ...dockerArgs], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 64_000) stderr = stderr.slice(-64_000); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout: Buffer.concat(stdout), stderr: `${stderr}\n${error.message}`.trim(), timedOut }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout), stderr: stderr.trim(), timedOut }); });
  });
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text: text.length === 0 ? "(no output)" : text }], isError };
}

function displayExec(command: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return runDockerExec(["-e", `DISPLAY=${BOX_DISPLAY}`, LOCAL_DOCKER_BOX_CONTAINER, ...command], timeoutMs);
}

async function computerShell(args: Record<string, unknown>): Promise<McpToolResult> {
  const command = typeof args.command === "string" ? args.command : "";
  if (command.trim().length === 0) return textResult("computer_shell requires a non-empty 'command'.", true);
  const requested = typeof args.timeout_seconds === "number" ? args.timeout_seconds * 1_000 : DEFAULT_SHELL_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(requested, 1_000), MAX_SHELL_TIMEOUT_MS);
  const result = await displayExec(["-w", "/home/box", "bash", "-lc", command], timeoutMs);
  const body = `${result.stdout.toString()}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ""}`.trim();
  if (result.timedOut) return textResult(`Command timed out after ${Math.round(timeoutMs / 1_000)}s.\n${body}`, true);
  const header = result.code === 0 ? "" : `[exit ${result.code}]\n`;
  return textResult(`${header}${body}`, result.code !== 0);
}

// Chrome/Chromium crash in this box (x86 Chrome's GPU + crashpad subprocesses
// die under qemu emulation on Apple Silicon), but Firefox (Gecko) renders fine.
// Firefox is installed on demand because the container is recreated from a fresh
// image; the first browse in a new box pays a one-time install.
let firefoxReady = false;
async function ensureFirefox(): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (firefoxReady) return { ok: true, detail: "" };
  const present = await runDockerExec([LOCAL_DOCKER_BOX_CONTAINER, "bash", "-lc", "command -v firefox-esr"], 8_000);
  if (present.code === 0) { firefoxReady = true; return { ok: true, detail: "" }; }
  const install = await runDockerExec([LOCAL_DOCKER_BOX_CONTAINER, "bash", "-lc", "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq firefox-esr"], 240_000);
  if (install.code === 0) { firefoxReady = true; return { ok: true, detail: "" }; }
  return { ok: false, detail: install.stderr || "apt-get install firefox-esr failed" };
}

async function computerOpenUrl(args: Record<string, unknown>): Promise<McpToolResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return textResult("computer_open_url requires an http(s) 'url'.", true);
  const firefox = await ensureFirefox();
  if (!firefox.ok) return textResult(`Could not prepare a browser in the box: ${firefox.detail}`, true);
  // Pass the URL as $0 so it is never shell-interpolated. Default (remote) mode
  // reuses a running Firefox as a new tab, or launches one otherwise.
  await displayExec(["bash", "-lc", 'setsid firefox-esr "$0" >/dev/null 2>&1 < /dev/null & disown', url], 20_000);
  return textResult(`Opened ${url} in Firefox on the box. Wait a couple of seconds, then use computer_screenshot to see the page.`);
}

async function computerScreenshot(): Promise<McpToolResult> {
  const result = await displayExec(["bash", "-lc", 'SZ=$(xdotool getdisplaygeometry 2>/dev/null | tr " " x); exec ffmpeg -y -loglevel quiet -f x11grab -video_size "${SZ:-1280x800}" -i :1 -frames:v 1 -f image2pipe -vcodec png -'], SCREENSHOT_TIMEOUT_MS);
  if (result.stdout.length === 0) return textResult(`Could not capture the box screen. ${result.stderr}`.trim(), true);
  return { content: [{ type: "image", data: result.stdout.toString("base64"), mimeType: "image/png" }] };
}

async function computerClick(args: Record<string, unknown>): Promise<McpToolResult> {
  const x = Number(args.x), y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return textResult("computer_click requires numeric 'x' and 'y'.", true);
  const button = args.button === "right" ? "3" : args.button === "middle" ? "2" : "1";
  const result = await displayExec(["xdotool", "mousemove", String(Math.round(x)), String(Math.round(y)), "click", button], 10_000);
  return result.code === 0 ? textResult(`Clicked at (${Math.round(x)}, ${Math.round(y)}).`) : textResult(`Click failed: ${result.stderr}`, true);
}

async function computerType(args: Record<string, unknown>): Promise<McpToolResult> {
  const text = typeof args.text === "string" ? args.text : "";
  if (text.length === 0) return textResult("computer_type requires 'text'.", true);
  const result = await displayExec(["xdotool", "type", "--clearmodifiers", "--", text], 15_000);
  return result.code === 0 ? textResult(`Typed ${text.length} character(s).`) : textResult(`Type failed: ${result.stderr}`, true);
}

async function computerKey(args: Record<string, unknown>): Promise<McpToolResult> {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  if (key.length === 0) return textResult("computer_key requires a 'key' (xdotool syntax, e.g. Return, ctrl+l).", true);
  const result = await displayExec(["xdotool", "key", "--clearmodifiers", "--", key], 10_000);
  return result.code === 0 ? textResult(`Pressed ${key}.`) : textResult(`Key failed: ${result.stderr}`, true);
}

const DEFINITIONS: readonly (McpToolDefinition & { readonly run: (args: Record<string, unknown>) => Promise<McpToolResult> })[] = [
  {
    name: "computer_shell",
    description: "Run a shell command on the box (the agent's Linux computer). Runs as a login shell in /home/box. Use for files, processes, installing packages, and running scripts.",
    inputSchema: { type: "object", properties: { command: { type: "string", description: "Shell command to run." }, timeout_seconds: { type: "number", description: "Max seconds to wait (default 60, max 300)." } }, required: ["command"], additionalProperties: false },
    run: computerShell,
  },
  {
    name: "computer_open_url",
    description: "Open a URL in a real browser (Firefox) on the box's desktop. Then use computer_screenshot to see the page and computer_click/type/key to interact with it.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "An http(s) URL to open." } }, required: ["url"], additionalProperties: false },
    run: computerOpenUrl,
  },
  {
    name: "computer_screenshot",
    description: "Capture a PNG screenshot of the box's desktop (display :1, 1280x800). Use it to see the current screen before clicking or typing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => computerScreenshot(),
  },
  {
    name: "computer_click",
    description: "Move the mouse to (x, y) on the box desktop and click. Coordinates are in display pixels (0,0 = top-left, up to 1280x800).",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." } }, required: ["x", "y"], additionalProperties: false },
    run: computerClick,
  },
  {
    name: "computer_type",
    description: "Type text into the focused element on the box desktop.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    run: computerType,
  },
  {
    name: "computer_key",
    description: "Press a key or chord on the box desktop using xdotool syntax (e.g. Return, Tab, ctrl+l, alt+F4).",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
    run: computerKey,
  },
];

export function createBoxComputerTools(): BoxComputerTools {
  const byName = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));
  // Pre-warm the browser install so the agent's first computer_open_url is fast
  // rather than paying the one-time apt install inside a tool call.
  void ensureFirefox().catch(() => {});
  return {
    list: () => DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call: async (name, args) => {
      const definition = byName.get(name);
      if (definition == null) return textResult(`Unknown box computer tool: ${name}`, true);
      try {
        return await definition.run(args);
      } catch (error) {
        return textResult(`Box computer tool failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  };
}
