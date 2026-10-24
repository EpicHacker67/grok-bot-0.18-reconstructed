/** Bound silent stalls without cutting off a turn that is still producing work. */
export class TurnTimeoutError extends Error {
  constructor(readonly kind: "idle" | "total") {
    super(kind === "idle"
      ? "I paused because the model or tool stopped responding for 10 minutes. Any completed actions may still have taken effect; check the current state before continuing."
      : "I paused after four hours of continuous work. Ask me to continue from the current state.");
    this.name = "TurnTimeoutError";
  }
}
export function createTurnWatchdog(controller: AbortController) {
  let idle: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const total = setTimeout(() => controller.abort(new TurnTimeoutError("total")), 4 * 60 * 60 * 1000);
  total.unref();
  const progress = () => {
    if (closed || controller.signal.aborted) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new TurnTimeoutError("idle")), 10 * 60 * 1000);
    idle.unref();
  };
  progress();
  return { progress, close() { closed = true; clearTimeout(total); if (idle) clearTimeout(idle); } };
}
