import { spawn } from "node:child_process";
import { LOCAL_DOCKER_BOX_CONTAINER } from "../shared/box-runtime.js";
import { resolveDockerBinary } from "../shared/node/remote-docker.js";
import { createBoxBrowserTools } from "./box-browser-tools.js";

const DOCKER_BINARY = resolveDockerBinary();

// Computer tools that let a routed agent (Claude Code / Codex) drive the local
// Docker box the same way the native agent drives its cloud computer. They shell
// into the running container with `docker exec`, so they are only meaningful
// while the box runtime is "local-docker". The container exposes an X display on
// :2 with Chrome and xdotool, and ffmpeg captures that display.
// :2 is the display the desktop app streams as the box "computer" (its host
// runs on :1 internally), so the agent must act on :2 for what it does to be
// what the user sees.

const BOX_DISPLAY = process.env.SAND_DOCKER_DISPLAY ?? ":2";
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

export interface ExecResult { readonly code: number | null; readonly stdout: Buffer; readonly stderr: string; readonly timedOut: boolean }

export type DockerExec = (dockerArgs: readonly string[], timeoutMs: number) => Promise<ExecResult>;

function runDockerExec(dockerArgs: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(DOCKER_BINARY, ["exec", ...dockerArgs], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    let capturedBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = 16_000_000 - capturedBytes;
      if (remaining > 0) { const kept = chunk.subarray(0, remaining); stdout.push(kept); capturedBytes += kept.length; }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 64_000) stderr = stderr.slice(-64_000); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout: Buffer.concat(stdout), stderr: `${stderr}\n${error.message}`.trim(), timedOut }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout), stderr: stderr.trim(), timedOut }); });
  });
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text: text.length === 0 ? "(no output)" : text }], isError };
}

function displayExec(command: readonly string[], timeoutMs: number, exec: DockerExec = runDockerExec): Promise<ExecResult> {
  return exec(["-e", `DISPLAY=${BOX_DISPLAY}`, LOCAL_DOCKER_BOX_CONTAINER, ...command], timeoutMs);
}

async function computerShell(args: Record<string, unknown>, exec: DockerExec = runDockerExec): Promise<McpToolResult> {
  const command = typeof args.command === "string" ? args.command : "";
  if (command.trim().length === 0) return textResult("computer_shell requires a non-empty 'command'.", true);
  const requested = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds) ? args.timeout_seconds * 1_000 : DEFAULT_SHELL_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(requested, 1_000), MAX_SHELL_TIMEOUT_MS);
  const result = await exec(["-e", `DISPLAY=${BOX_DISPLAY}`, "-w", "/home/box", LOCAL_DOCKER_BOX_CONTAINER, "timeout", "--signal=TERM", "--kill-after=2s", `${Math.ceil(timeoutMs / 1000)}s`, "bash", "-lc", command], timeoutMs + 3_000);
  const output = result.stdout.toString();
  const bounded = output.length > 32_000 ? output.slice(0, 32_000) + "\n[Output truncated. Narrow the command to read the relevant section.]" : output;
  const body = `${bounded}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ""}`.trim();
  if (result.timedOut || result.code === 124 || result.code === 137) return textResult(`Command timed out after ${Math.round(timeoutMs / 1_000)}s. Inspect its effects before retrying.\n${body}`, true);
  const header = result.code === 0 ? "" : `[exit ${result.code}]\n`;
  return textResult(`${header}${body}`, result.code !== 0);
}

async function computerScreenshot(exec: DockerExec = runDockerExec): Promise<McpToolResult> {
  const result = await displayExec(["bash", "-lc", 'SZ=$(xdotool getdisplaygeometry 2>/dev/null | tr " " x); exec ffmpeg -y -loglevel quiet -f x11grab -video_size "${SZ:-1280x800}" -i "$DISPLAY" -frames:v 1 -f image2pipe -vcodec png -'], SCREENSHOT_TIMEOUT_MS, exec);
  if (result.stdout.length === 0) return textResult(`Could not capture the box screen. ${result.stderr}`.trim(), true);
  const png = result.stdout;
  if (result.code !== 0 || result.timedOut || png.length < 24 || png.toString("hex", 0, 8) !== "89504e470d0a1a0a") return textResult("Screen capture failed; take a new screenshot before acting.", true);
  return { content: [{ type: "text", text: `Desktop screenshot: ${png.readUInt32BE(16)}×${png.readUInt32BE(20)} pixels. Coordinates use this image's original dimensions.` }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
}

async function computerClick(args: Record<string, unknown>, exec: DockerExec = runDockerExec): Promise<McpToolResult> {
  const {x, y} = args;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return textResult("computer_click requires nonnegative numeric 'x' and 'y' from the latest screenshot.", true);
  if (args.click_count !== undefined && args.click_count !== 1 && args.click_count !== 2) return textResult("click_count must be 1 or 2.", true);
  const button = args.button === "right" ? "3" : args.button === "middle" ? "2" : "1";
  const result = await displayExec(["xdotool", "mousemove", String(Math.round(x)), String(Math.round(y)), "click", "--repeat", String(args.click_count ?? 1), "--delay", "80", button], 10_000, exec);
  return result.code === 0 ? textResult(`Clicked at (${Math.round(x)}, ${Math.round(y)}).`) : textResult(`Click failed: ${result.stderr}`, true);
}

async function computerType(args: Record<string, unknown>, exec: DockerExec = runDockerExec): Promise<McpToolResult> {
  const text = typeof args.text === "string" ? args.text : "";
  if (text.length === 0) return textResult("computer_type requires 'text'.", true);
  const result = await displayExec(["xdotool", "type", "--clearmodifiers", "--delay", "0", "--", text], 15_000, exec);
  return result.code === 0 ? textResult(`Typed ${text.length} character(s).`) : textResult(`Type failed: ${result.stderr}`, true);
}

async function computerKey(args: Record<string, unknown>, exec: DockerExec = runDockerExec): Promise<McpToolResult> {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  if (key.length === 0) return textResult("computer_key requires a 'key' (xdotool syntax, e.g. Return, ctrl+l).", true);
  const result = await displayExec(["xdotool", "key", "--clearmodifiers", "--", key], 10_000, exec);
  return result.code === 0 ? textResult(`Pressed ${key}.`) : textResult(`Key failed: ${result.stderr}`, true);
}

async function computerScroll(args: Record<string, unknown>, exec: DockerExec): Promise<McpToolResult> {
  const buttons: Record<string, string> = { up: "4", down: "5", left: "6", right: "7" };
  const button = buttons[String(args.direction)];
  const steps = args.steps ?? 3;
  if (!button || typeof steps !== "number" || !Number.isInteger(steps) || steps < 1 || steps > 20) return textResult("Scroll requires a direction and 1–20 steps.", true);
  const result = await displayExec(["xdotool", "click", "--repeat", String(steps), "--delay", "25", button], 10_000, exec);
  return result.code === 0 ? textResult(`Scrolled ${args.direction}.`) : textResult(`Scroll failed: ${result.stderr}`, true);
}

const DESKTOP_DRAG_SCRIPT = `import json, subprocess, sys, time
args=json.loads(sys.argv[1])
start=args['start']; end=args['end']
def move(x,y):
    subprocess.run(['xdotool','mousemove','--sync',str(round(x)),str(round(y))],check=True,timeout=2)
move(*start)
try:
    subprocess.run(['xdotool','mousedown','1'],check=True,timeout=2)
    for step in range(1,13):
        move(start[0]+(end[0]-start[0])*step/12,start[1]+(end[1]-start[1])*step/12)
        time.sleep(0.015)
finally:
    subprocess.run(['xdotool','mouseup','1'],timeout=2)
`;
async function computerDrag(args: Record<string, unknown>, exec: DockerExec): Promise<McpToolResult> {
  const {start_x, start_y, end_x, end_y} = args;
  const coords = [start_x, start_y, end_x, end_y];
  if (coords.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)) return textResult("Drag requires nonnegative start_x, start_y, end_x, end_y from the latest screenshot.", true);
  const result = await displayExec(["python3", "-c", DESKTOP_DRAG_SCRIPT, JSON.stringify({start:[start_x,start_y],end:[end_x,end_y]})], 30_000, exec);
  return result.code === 0 ? textResult("Drag completed.") : textResult(`Drag did not complete: ${result.stderr}. Inspect the screen before retrying.`, true);
}
async function computerHover(args: Record<string, unknown>, exec: DockerExec): Promise<McpToolResult> {
  const {x,y} = args;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return textResult("Hover requires nonnegative x and y from the latest screenshot.", true);
  const result = await displayExec(["xdotool", "mousemove", "--sync", String(Math.round(x)), String(Math.round(y))], 10_000, exec);
  return result.code === 0 ? textResult("Pointer moved.") : textResult(`Hover failed: ${result.stderr}`, true);
}

const observe = { type: "boolean", description: "Return a fresh screenshot after the action (default true). Set false only for a deterministic intermediate step." };
const DEFINITIONS: readonly (McpToolDefinition & { readonly run: (args: Record<string, unknown>, exec: DockerExec) => Promise<McpToolResult> })[] = [
  {
    name: "computer_shell",
    description: "Run a shell command on the box (the agent's Linux computer). Runs as a login shell in /home/box. Use for files, processes, and computation. Prefer browser tools for web tasks and computer tools for desktop interaction; do not improvise another browser profile or control script.",
    inputSchema: { type: "object", properties: { command: { type: "string", description: "Shell command to run." }, timeout_seconds: { type: "number", description: "Max seconds to wait (default 60, max 300)." } }, required: ["command"], additionalProperties: false },
    run: computerShell,
  },
  {
    name: "computer_open_url",
    description: "Open an http(s) URL in a new tab of the existing signed-in remote browser. Returns page text and interactive refs; use browser tools for follow-up actions.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "An http(s) URL to open." } }, required: ["url"], additionalProperties: false },
    run: async () => textResult("Browser navigation is handled by the shared browser session.", true),
  },
  {
    name: "computer_screenshot",
    description: "Capture a PNG screenshot of the box's desktop (the display the user sees). Use it to see the current screen before clicking or typing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (_args, exec) => computerScreenshot(exec),
  },
  {
    name: "computer_scroll",
    description: "Scroll the focused desktop area and return a screenshot. Prefer browser_scroll on web pages.",
    inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, steps: { type: "integer", minimum: 1, maximum: 20 }, screenshot: observe }, required: ["direction"], additionalProperties: false },
    run: computerScroll,
  },
  {
    name: "computer_click",
    description: "Move the mouse to (x, y) on the box desktop and click. Coordinates are original screenshot pixels (0,0 = top-left); read dimensions from the latest screenshot. Prefer browser_click for web controls.",
    inputSchema: { type: "object", properties: { screenshot: observe, click_count: { type: "integer", enum: [1, 2], description: "1 for a click, 2 for a double-click." }, x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." } }, required: ["x", "y"], additionalProperties: false },
    run: computerClick,
  },
  {
    name: "computer_hover",
    description: "Move the pointer to observed screenshot coordinates to reveal a menu or tooltip. Returns a screenshot.",
    inputSchema: { type: "object", properties: { x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 }, screenshot: observe }, required: ["x", "y"], additionalProperties: false },
    run: computerHover,
  },
  {
    name: "computer_drag",
    description: "Drag between observed desktop coordinates with the left button, then return a screenshot. Use for native windows, sliders, or drag-and-drop; the mouse button is released even if movement fails.",
    inputSchema: { type: "object", properties: { start_x: { type: "number", minimum: 0 }, start_y: { type: "number", minimum: 0 }, end_x: { type: "number", minimum: 0 }, end_y: { type: "number", minimum: 0 }, screenshot: observe }, required: ["start_x", "start_y", "end_x", "end_y"], additionalProperties: false },
    run: computerDrag,
  },
  {
    name: "computer_type",
    description: "Type text into the focused element on the box desktop.",
    inputSchema: { type: "object", properties: { screenshot: observe, text: { type: "string" } }, required: ["text"], additionalProperties: false },
    run: computerType,
  },
  {
    name: "computer_key",
    description: "Press a key or chord on the box desktop using xdotool syntax (e.g. Return, Tab, ctrl+l, alt+F4).",
    inputSchema: { type: "object", properties: { screenshot: observe, key: { type: "string" } }, required: ["key"], additionalProperties: false },
    run: computerKey,
  },
];

// Desktop focus and browser refs are shared state. Serialize operations across
// turns so simultaneous tool calls cannot type into another action's window.
let desktopQueue: Promise<unknown> = Promise.resolve();
export function createBoxComputerTools(options: { ensureReady?: () => Promise<unknown>; exec?: DockerExec } = {}): BoxComputerTools {
  const browser = createBoxBrowserTools(options.exec ?? runDockerExec, BOX_DISPLAY);
  const byName = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));
  let ready: Promise<unknown> | undefined;
  let checkedAt = 0;
  return {
    list: () => [...DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), ...browser.list()],
    call: (name, args) => {
      const run = async (): Promise<McpToolResult> => {
        const definition = byName.get(name);
        const browserTool = browser.list().some(tool => tool.name === name);
        if (!definition && !browserTool) return textResult(`Unknown box computer tool: ${name}`, true);
        try {
          // One readiness check per burst instead of a gateway round trip for
          // every click. Refresh on errors or after 30 seconds; never retry an
          // action automatically, since it may already have taken effect.
          if (!ready || Date.now() - checkedAt > 30_000) {
            ready = Promise.resolve().then(() => options.ensureReady?.());
            checkedAt = Date.now();
          }
          await ready;
          const result = name === "computer_open_url"
            ? await browser.call("browser_navigate", { url: args.url, newTab: true })
            : browserTool ? await browser.call(name, args) : await definition!.run(args, options.exec ?? runDockerExec);
          if (result.isError) ready = undefined;
          if (!result.isError && ["computer_click", "computer_type", "computer_key", "computer_scroll", "computer_drag", "computer_hover"].includes(name) && args.screenshot !== false) {
            const screenshot = await computerScreenshot(options.exec ?? runDockerExec);
            // Observation failure must not misreport a completed action as failed.
            return { content: [...result.content, ...screenshot.content] };
          }
          return result;
        } catch (error) {
          ready = undefined;
          return textResult(`Box computer tool failed: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      };
      const pending = desktopQueue.then(run, run);
      desktopQueue = pending.catch(() => undefined);
      return pending;
    },
  };
}
