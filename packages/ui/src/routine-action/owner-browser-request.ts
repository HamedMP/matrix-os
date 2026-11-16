import { ROUTINE_CHAT_ORIGIN_RESPONSE_MAX_BYTES } from "@matrix-os/contracts";

const ROUTINE_ORIGIN_LIST_PATH = /^\/api\/chats\/chat_[A-Za-z0-9_-]{1,128}\/routine-origin(?:\?timeline=1)?$/;
const CONFIRMATION_RESPONSE_MAX_BYTES = 128 * 1024;

export interface OwnerBrowserJsonRequest {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Authentication routes the owner. The Platform independently proves authority. */
export function createOwnerBrowserJsonRequest(
  gatewayUrl: string,
  getToken: () => Promise<string | null>,
  fetcher: typeof fetch = fetch,
  options: { cache?: RequestCache; allowRelative?: boolean; responseLimit?: (input: OwnerBrowserJsonRequest) => number } = {},
) {
  const gateway = gatewayUrl === "" && options.allowRelative ? null : new URL(gatewayUrl);
  if (gateway && (!/^https?:$/.test(gateway.protocol) || gateway.username || gateway.password || gateway.search || gateway.hash)) {
    throw new Error("Routine confirmation unavailable");
  }
  const base = gateway?.toString().replace(/\/$/, "") ?? "";

  return async (input: OwnerBrowserJsonRequest) => {
    const callerSignal = input.signal;
    if (callerSignal?.aborted || !/^\/(?![\\/])/.test(input.path)) throw new Error("Routine confirmation unavailable");

    // React Native does not implement throwIfAborted. Own one portable lifetime including token and body reads.
    const controller = new AbortController();
    const { signal } = controller;
    const cancel = () => controller.abort();
    callerSignal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, input.timeoutMs ?? 10_000);
    let rejectAbort!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error("Routine confirmation unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
    const requireLive = () => { if (signal.aborted) throw new Error("Routine confirmation unavailable"); };
    try {
      const token = await Promise.race([getToken(), cancelled]);
      requireLive();
      const response = await Promise.race([fetcher(base + input.path, {
        method: input.method,
        credentials: "same-origin",
        redirect: "error",
        signal,
        ...(options.cache ? { cache: options.cache } : {}),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      }), cancelled]);
      requireLive();
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error("Routine confirmation unavailable"), { httpStatus: response.status });
      }
      const responseLimit = options.responseLimit?.(input) ?? (
        input.method === "GET" && ROUTINE_ORIGIN_LIST_PATH.test(input.path)
          ? ROUTINE_CHAT_ORIGIN_RESPONSE_MAX_BYTES
          : CONFIRMATION_RESPONSE_MAX_BYTES
      );
      if (!response.body || Number(response.headers.get("content-length")) > responseLimit) {
        await response.body?.cancel();
        throw new Error("Routine confirmation unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const abortRead = () => {
        void reader.cancel().catch(error => console.warn("[routine-action] Read cancelled", error instanceof Error ? error.name : "UnknownError"));
      };
      signal.addEventListener("abort", abortRead, { once: true });
      try {
        for (;;) {
          requireLive();
          const chunk = await Promise.race([reader.read(), cancelled]);
          requireLive();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > responseLimit) {
            await reader.cancel();
            throw new Error("Routine confirmation unavailable");
          }
          chunks.push(chunk.value);
        }
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder().decode(data));
      } finally {
        signal.removeEventListener("abort", abortRead);
        reader.releaseLock();
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
      signal.removeEventListener("abort", onAbort);
    }
  };
}
