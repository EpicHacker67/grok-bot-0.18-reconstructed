import { setTimeout as delay } from "node:timers/promises";

export type ProviderConnectionDiagnostic = { phase: "start" | "headers" | "failure"; attempt: number; elapsedMs: number; requestBytes: number; status?: number; code?: string; timedOut?: boolean };

const transientCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);

function networkCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current != null && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string") return value.code;
    current = value.cause;
  }
  return undefined;
}

/** Retries only connection establishment, never a response body or a tool execution. */
export async function fetchProviderConnection(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  options: { label: string; retries?: number; timeoutMs?: number; retryDelayMs?: number; onDiagnostic?: (event: ProviderConnectionDiagnostic) => void },
): Promise<Response> {
  const attempts = 1 + (options.retries ?? 2);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    const requestBytes = typeof init.body === "string" ? Buffer.byteLength(init.body) : 0;
    const report = (event: Omit<ProviderConnectionDiagnostic, "attempt" | "elapsedMs" | "requestBytes">) => {
      try { options.onDiagnostic?.({ ...event, attempt, elapsedMs: Date.now() - started, requestBytes }); } catch {}
    };
    const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    callerSignal?.throwIfAborted();
    const controller = new AbortController();
    const signal = callerSignal == null ? controller.signal : AbortSignal.any([callerSignal, controller.signal]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Connection timed out", "TimeoutError"));
    }, options.timeoutMs ?? 30_000);
    try {
      report({ phase: "start" });
      // Keep the timer scoped to headers: reasoning and streaming may take longer.
      const response = await fetchImpl(input, { ...init, signal });
      report({ phase: "headers", status: response.status });
      return response;
    } catch (error) {
      callerSignal?.throwIfAborted();
      const code = networkCode(error);
      report({ phase: "failure", timedOut, ...(code != null && /^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? { code } : {}) });
      const transient = timedOut || (code != null ? transientCodes.has(code) : error instanceof TypeError && error.message === "fetch failed");
      if (transient && attempt < attempts) {
        clearTimeout(timer);
        await delay((options.retryDelayMs ?? 500) * attempt, undefined, { signal: callerSignal ?? undefined });
        continue;
      }
      const detail = timedOut || code?.includes("TIMEOUT") || code === "ETIMEDOUT" ? "the connection timed out"
        : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "the server address could not be resolved"
        : code?.includes("CERT") || code?.includes("SELF_SIGNED") ? "the secure connection could not be verified"
        : transient ? "the network connection was interrupted" : "the connection failed";
      // Do not expose raw errors, URLs, headers, or tokens in the conversation.
      throw new Error(`Could not connect to ${options.label}: ${detail}${attempt > 1 ? ` after ${attempt} attempts` : ""}. Check your connection and try again.`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Could not connect to ${options.label}.`);
}
