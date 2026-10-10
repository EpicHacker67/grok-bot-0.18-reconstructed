import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";

import { isSandInferenceModel } from "../inference-router.js";
import { resolveClaudeCodeCliPath } from "./inference-router-local.js";

export interface ClaudeModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
}

let cached: ClaudeModelInfo[] = [];
let refreshedAt = 0;
let pending: Promise<ClaudeModelInfo[]> | undefined;

export function parseClaudeModelCatalog(value: unknown): ClaudeModelInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    if (row == null || typeof row !== "object" || !isSandInferenceModel(row.value) || typeof row.displayName !== "string" || typeof row.description !== "string") return [];
    return [{ value: row.value, displayName: row.displayName, description: row.description,
      ...(isSandInferenceModel(row.resolvedModel) ? { resolvedModel: row.resolvedModel } : {}) }];
  });
}

// The SDK initialization handshake returns the installed CLI's model catalog.
// No user prompt is submitted and no inference request is made.
export async function loadClaudeModelCatalog(): Promise<ClaudeModelInfo[]> {
  if (Date.now() - refreshedAt < 300_000) return cached;
  if (pending != null) return pending;
  pending = (async () => {
    const executable = resolveClaudeCodeCliPath();
    if (executable == null) return [];
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 8_000);
    async function* prompts(): AsyncGenerator<never> {
      await new Promise<void>(resolve => {
        if (abortController.signal.aborted) resolve();
        else abortController.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    const session = query({ prompt: prompts(), options: {
      pathToClaudeCodeExecutable: executable, cwd: tmpdir(), abortController,
      tools: [], mcpServers: {}, strictMcpConfig: true, persistSession: false, settingSources: [],
    } });
    try { cached = parseClaudeModelCatalog(await session.supportedModels()); }
    catch { /* Keep the last known catalog; aliases stay explicitly automatic. */ }
    finally { clearTimeout(timer); abortController.abort(); await session.return(undefined).catch(() => undefined); }
    return cached;
  })().catch(() => cached).finally(() => { refreshedAt = Date.now(); pending = undefined; });
  return pending;
}
