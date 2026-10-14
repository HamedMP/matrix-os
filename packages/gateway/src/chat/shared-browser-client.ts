import { SHARED_BROWSER_ACTION_DEADLINE_MS, SHARED_BROWSER_ACTION_MAX_BYTES, SharedBrowserActionSchema, SharedBrowserActionResultSchema, type SharedBrowserAction, type SharedBrowserActionResult } from "@matrix-os/contracts";
const MAX_BYTES = 192 * 1024;
export function sharedBrowserEndpoint(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Browser connection unavailable");
  return `http://127.0.0.1:${port}/apps/browser-lab/api/agent-action`;
}
/** Native harness code has a fixed endpoint, not a URL supplied in tool arguments. */
export async function callSharedBrowser(options: { gatewayPort: number; token: string; action: SharedBrowserAction; signal?: AbortSignal; fetcher?: typeof fetch }): Promise<SharedBrowserActionResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error("Browser connection unavailable");
  const body = JSON.stringify(SharedBrowserActionSchema.parse(options.action));
  if (Buffer.byteLength(body, "utf8") > SHARED_BROWSER_ACTION_MAX_BYTES) throw new Error("Browser action unavailable");
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(SHARED_BROWSER_ACTION_DEADLINE_MS)]);
  const response = await (options.fetcher ?? fetch)(sharedBrowserEndpoint(options.gatewayPort), { method: "POST", redirect: "error", signal,
    headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" }, body });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES) { await response.body?.cancel(); throw new Error("Browser action unavailable"); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch((error: unknown) => console.warn("[shared-browser-native] Body cancellation failed", error instanceof Error ? error.name : "UnknownError")); };
  signal.addEventListener("abort", abort, { once: true });
  try { for (;;) { signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
    size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Browser action unavailable"); } chunks.push(value); }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  const result: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  return SharedBrowserActionResultSchema.parse(result);
}
