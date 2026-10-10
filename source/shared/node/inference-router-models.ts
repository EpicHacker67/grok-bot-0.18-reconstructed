import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeModelInfo } from "./claude-model-catalog.js";

import { isSandInferenceModel, isSandInferenceEffort, type SandInferenceEffort, type SandInferenceProvider, type SandInferenceModels } from "../inference-router.js";

export function defaultInferenceModel(provider: SandInferenceProvider): string | null {
  if (provider === "cursor") return null;
  const override = process.env[provider === "codex" ? "SAND_CODEX_MODEL" : provider === "claude-code" ? "SAND_CLAUDE_MODEL" : "SAND_OPENROUTER_MODEL"]?.trim();
  if (override) return override;
  if (provider === "claude-code") return null;
  if (provider === "openrouter") return "openai/gpt-5.2";
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim() || "gpt-5.4";
  } catch { return "gpt-5.4"; }
}


export interface InferenceModelChoice {
  value: string;
  label: string;
  detail?: string;
  badge?: string;
  group?: "models" | "automatic";
}

// Published model IDs supplement older installed CLI catalogs.
// Verified 2026-09-25: https://support.claude.com/en/articles/11940350-claude-code-model-configuration
// Context: https://platform.claude.com/docs/en/models/opus-5-5/overview
const PUBLISHED_CLAUDE_MODELS: readonly InferenceModelChoice[] = [
  { value: "claude-opus-5-5", label: "Opus 5.5", detail: "1M context", badge: "New", group: "models" },
  { value: "claude-fable-5-1", label: "Fable 5.1", detail: "1M context", group: "models" },
];

function claudeModelLabel(id: string, fallback: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[\d+[km]\])?$/.exec(id);
  if (match == null) return fallback.replace(/^Claude /, "");
  const family = match[1]!;
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${match[2]}${match[3] == null ? "" : `.${match[3]}`}`;
}

export function claudeModelChoices(catalog: readonly ClaudeModelInfo[]) {
  const choices: InferenceModelChoice[] = PUBLISHED_CLAUDE_MODELS.map(model => ({ ...model }));
  for (const model of catalog) {
    const id = model.resolvedModel ?? (model.value.startsWith("claude-") ? model.value : undefined);
    if (id == null || !isSandInferenceModel(id) || choices.some(choice => choice.value === id)) continue;
    const label = claudeModelLabel(id, model.displayName);
    const context = /\[(\d+[km])\]$/.exec(id)?.[1];
    const detail = context == null ? undefined : `${context.toUpperCase()} context`;
    choices.push({ value: id, label, ...(detail == null ? {} : { detail }), group: "models" });
  }
  for (const family of ["opus", "sonnet", "haiku"]) {
    const model = catalog.find(item => item.value === family) ?? catalog.find(item => item.value.startsWith(`${family}[`));
    const title = claudeModelLabel(model?.resolvedModel ?? "", `${family[0]!.toUpperCase()}${family.slice(1)}`);
    choices.push({ value: family, label: title, detail: "Follows your Claude Code version", badge: "Auto", group: "automatic" });
  }
  return choices;
}

export function inferenceModelCatalog(selected: SandInferenceModels = {}, claudeModels: readonly ClaudeModelInfo[] = []) {
  const choices: Record<SandInferenceProvider, InferenceModelChoice[]> = {
    cursor: [], codex: [], "claude-code": claudeModelChoices(claudeModels), openrouter: [],
  };
  const effortOptions: Record<SandInferenceProvider, SandInferenceEffort[]> = {
    cursor: [], codex: ["minimal", "low", "medium", "high", "xhigh"],
    "claude-code": ["low", "medium", "high", "xhigh", "max"], openrouter: ["low", "medium", "high"],
  };
  try {
    const cache = JSON.parse(readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "models_cache.json"), "utf8"));
    for (const model of Array.isArray(cache.models) ? cache.models : []) {
      if (model?.visibility !== "list" || !isSandInferenceModel(model.slug)) continue;
      if (model.slug === (selected.codex ?? defaultInferenceModel("codex"))) {
        const levels = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []).map((level: { effort?: unknown }) => level?.effort).filter(isSandInferenceEffort);
        if (levels.length > 0) effortOptions.codex = levels;
      }
      choices.codex.push({ value: model.slug, label: typeof model.display_name === "string" ? model.display_name : model.slug });
    }
  } catch { /* Custom model entry remains available without a cached catalog. */ }
  const defaults = Object.fromEntries(Object.keys(choices).map(provider => [provider, defaultInferenceModel(provider as SandInferenceProvider)]));
  const claudeDefault = claudeModels.find(model => model.value === "default")?.resolvedModel;
  if (defaults["claude-code"] == null && claudeDefault != null) defaults["claude-code"] = claudeDefault;
  for (const provider of Object.keys(choices) as SandInferenceProvider[]) {
    for (const value of [defaults[provider], selected[provider]]) {
      if (isSandInferenceModel(value) && !choices[provider].some(option => option.value === value)) choices[provider].push({ value, label: value });
    }
  }
  return { modelOptions: choices, modelDefaults: defaults, effortOptions };
}
