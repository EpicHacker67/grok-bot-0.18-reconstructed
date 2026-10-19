export const SAND_INFERENCE_PROVIDERS = ["cursor", "claude-code", "codex", "openrouter"] as const;
export type SandInferenceProvider = (typeof SAND_INFERENCE_PROVIDERS)[number];

// Computer and plugin tasks commonly need more than eight model/tool rounds.
// Keep a finite per-request ceiling, shared by all routed providers.
export const ROUTED_PROVIDER_MAX_STEPS = 128;

export interface SandInferenceRouterUsageProvider {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly lastUsedAt: string | null;
}

export interface SandInferenceRouterUsage {
  readonly schemaVersion: 1;
  readonly providers: Record<SandInferenceProvider, SandInferenceRouterUsageProvider>;
}

export function isSandInferenceProvider(value: unknown): value is SandInferenceProvider {
  return typeof value === "string" && (SAND_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

export function emptySandInferenceRouterUsage(): SandInferenceRouterUsage {
  const empty = (): SandInferenceRouterUsageProvider => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  return { schemaVersion: 1, providers: { cursor: empty(), "claude-code": empty(), codex: empty(), openrouter: empty() } };
}

export type SandInferenceModels = Partial<Record<SandInferenceProvider, string>>;
export function isSandInferenceModel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*(?:\[\d+[km]\])?$/.test(value);
}
export function parseSandInferenceModels(value: unknown): SandInferenceModels {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([provider, model]) => isSandInferenceProvider(provider) && provider !== "cursor" && isSandInferenceModel(model)));
}

export const SAND_INFERENCE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type SandInferenceEffort = (typeof SAND_INFERENCE_EFFORTS)[number];
export type SandInferenceEfforts = Partial<Record<SandInferenceProvider, SandInferenceEffort>>;
export function isSandInferenceEffort(value: unknown): value is SandInferenceEffort {
  return typeof value === "string" && (SAND_INFERENCE_EFFORTS as readonly string[]).includes(value);
}
export function parseSandInferenceEfforts(value: unknown): SandInferenceEfforts {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([provider, effort]) => isSandInferenceProvider(provider) && provider !== "cursor" && isSandInferenceEffort(effort)));
}
