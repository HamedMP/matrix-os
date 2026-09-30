import { LocalChatTransferError, type LocalChatImportRequest } from "#local-chat-import/client";
async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new LocalChatTransferError("invalid_response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > 256 * 1024 || chunks.length >= 4096) throw new LocalChatTransferError("invalid_response"); chunks.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch (error: unknown) { if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error; throw new LocalChatTransferError("invalid_response"); }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
/** Matrix authentication stays on its origin. Storage PUTs carry only server-issued scoped access. */
export function createLocalChatHttpTransport(options: { baseUrl: string; headers(): Record<string, string> | Promise<Record<string, string>>;
  runtimeSlot?: string; credentials?: RequestCredentials; fetchImpl?: typeof fetch; assertCurrent?(): void; validateUploadUrl?(url: string): Promise<void> }) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request: LocalChatImportRequest = async (path, input) => {
    options.assertCurrent?.(); input.signal.throwIfAborted();
    if (!/^\/api\/chats\/(?:imports\/local(?:\/[A-Za-z0-9/-]+)?|chat_[A-Za-z0-9_-]+\?limit=1)$/.test(path)) throw new LocalChatTransferError("invalid");
    const base = new URL(options.baseUrl);
    const url = new URL(base.pathname.replace(/\/$/, "") + path, base.origin); if (options.runtimeSlot && options.runtimeSlot !== "primary") url.searchParams.set("runtime", options.runtimeSlot);
    const headers = { "X-Matrix-Chat-Metadata": "1", ...await options.headers(), ...(input.body === undefined ? {} : { "content-type": "application/json" }) };
    options.assertCurrent?.(); input.signal.throwIfAborted();
    const response = await fetchImpl(url, { method: input.method, headers, ...(options.credentials ? { credentials: options.credentials } : {}), ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: "error", signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs===undefined?30_000:Math.max(1000,Math.min(input.timeoutMs,5*60_000)))]) });
    try {
      options.assertCurrent?.(); input.signal.throwIfAborted();
      if (!response.ok) throw new LocalChatTransferError(response.status === 410 ? "expired" : "unavailable");
      const value = await jsonResponse(response); options.assertCurrent?.(); input.signal.throwIfAborted(); return value;
    } finally {
      if(response.body && !response.body.locked) await response.body.cancel();
    }
  };
  return { request,
    async put(url: string, bytes: Uint8Array, signal: AbortSignal) {
      options.assertCurrent?.(); signal.throwIfAborted();
      const destination = new URL(url);
      if (destination.protocol !== "https:" || destination.username || destination.password || destination.hash || bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 ** 2) throw new LocalChatTransferError("invalid_response");
      await options.validateUploadUrl?.(url); options.assertCurrent?.(); signal.throwIfAborted();
      const response = await fetchImpl(url, { method: "PUT", body: bytes as BodyInit, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) });
      await response.body?.cancel(); options.assertCurrent?.(); signal.throwIfAborted();
      const etag = response.headers.get("etag");
      if (!response.ok || !etag || etag.length > 512 || /[\u0000-\u001f\u007f]/.test(etag)) throw new LocalChatTransferError("unavailable"); return etag;
    },
  };
}
