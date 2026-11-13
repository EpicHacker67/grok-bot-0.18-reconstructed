import { Agent, fetch as undiciFetch } from "undici";

/** Keep provider sockets separate from Electron's 250 ms address-attempt default. */
// Use the fetch implementation paired with this dispatcher. Newer Node builds
// can embed an incompatible undici dispatcher API in globalThis.fetch.
export function createProviderFetch(fetchImpl: typeof fetch = undiciFetch as unknown as typeof fetch) {
  const dispatcher = new Agent({
    autoSelectFamily: true,
    // A reachable address can take seconds on Wi-Fi/VPN connections. Node's
    // default otherwise discards every candidate before TCP can connect.
    autoSelectFamilyAttemptTimeout: 10_000,
    connectTimeout: 25_000,
  });
  return {
    fetch: ((input, init) => fetchImpl(input, { ...init, dispatcher } as RequestInit)) as typeof fetch,
    close: () => dispatcher.close(),
  };
}

export const providerFetch = createProviderFetch().fetch;
