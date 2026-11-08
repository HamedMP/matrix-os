export interface OwnerBrowserJsonRequest { path: string; method: "GET" | "POST"; body?: unknown; signal?: AbortSignal }
/** Existing bounded owner-browser transport; no request here supplies origin authority. */
export function createOwnerBrowserJsonRequest(gatewayUrl: string, getToken: () => Promise<string | null>, fetcher: typeof fetch = fetch, options: { cache?: RequestCache; allowRelative?: boolean; responseLimit?: (input: OwnerBrowserJsonRequest) => number } = {}) {
  const gateway = gatewayUrl === "" && options.allowRelative ? null : new URL(gatewayUrl);
  if (gateway && (!/^https?:$/.test(gateway.protocol) || gateway.username || gateway.password || gateway.search || gateway.hash)) throw new Error("Routine confirmation unavailable");
  const base = gateway?.toString().replace(/\/$/, "") ?? "";
  return async (input: OwnerBrowserJsonRequest) => {
    // RN's AbortSignal does not implement throwIfAborted. Own one portable scope,
    // including the token wait, and drain its timer/listeners on every exit.
    const responseLimit = options.responseLimit?.(input) ?? 128 * 1024;
    const callerSignal = input.signal ?? new AbortController().signal;
    if (callerSignal.aborted) throw new Error("Routine confirmation unavailable");
    const controller = new AbortController(), signal = controller.signal;
    const cancel = () => controller.abort();
    callerSignal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 10_000);
    let rejectAbort!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error("Routine confirmation unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
    const requireLive = () => { if (signal.aborted) throw new Error("Routine confirmation unavailable"); };
    try {
      const token = await Promise.race([getToken(), cancelled]); requireLive();
      const response = await Promise.race([fetcher(base + input.path, { method: input.method, credentials: "same-origin", redirect: "error", signal, ...(options.cache ? { cache: options.cache } : {}),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(input.body ? { "content-type": "application/json" } : {}) },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}) }), cancelled]);
      requireLive();
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > responseLimit) {
        await response.body?.cancel(); throw new Error("Routine confirmation unavailable");
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      const abortRead = () => { void reader.cancel().catch(error => console.warn("[routine-action] Read cancelled", error instanceof Error ? error.name : "UnknownError")); };
      signal.addEventListener("abort", abortRead, { once: true });
      try {
        for (;;) { requireLive(); const chunk = await Promise.race([reader.read(), cancelled]); requireLive(); if (chunk.done) break;
          bytes += chunk.value.byteLength; if (bytes > responseLimit) { await reader.cancel(); throw new Error("Routine confirmation unavailable"); } chunks.push(chunk.value); }
        const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder().decode(data));
      } finally { signal.removeEventListener("abort", abortRead); reader.releaseLock(); }
    } finally {
      clearTimeout(timer); callerSignal.removeEventListener("abort", cancel); signal.removeEventListener("abort", onAbort);
    }
  };
}
