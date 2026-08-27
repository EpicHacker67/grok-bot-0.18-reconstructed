export type SandBoxRuntime = "remote" | "local-docker";

export const DEFAULT_SAND_BOX_RUNTIME: SandBoxRuntime = "local-docker";

// Name of the local Docker container that hosts the box when the runtime is
// "local-docker". Shared so the electron-main connector that creates it and the
// coordinator tools that drive it agree on one identifier.
export const LOCAL_DOCKER_BOX_CONTAINER = "grok-bot-local-vm";

export function isSandBoxRuntime(value: unknown): value is SandBoxRuntime {
  return value === "remote" || value === "local-docker";
}
