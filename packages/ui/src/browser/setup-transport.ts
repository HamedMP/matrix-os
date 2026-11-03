import { browserEndpoint } from "./transport.js";
import type { BrowserSetupTransport } from "./types.js";

/** Old Desktop binaries cannot use the new setup bridge. Never bypass it. */
export function createHostedBrowserSetupTransport(bridge: {
  browserSetup?: boolean;
  gatewayFetch?: (url: string, init: RequestInit, timeout: number) => Promise<unknown>;
}): BrowserSetupTransport {
  const requiresDesktopUpdate = bridge.browserSetup !== true;
  const request = async (signal: AbortSignal, retry: boolean) => {
    signal.throwIfAborted();
    if (requiresDesktopUpdate) throw new Error("Desktop update required");
    if (!bridge.gatewayFetch) throw new Error("Browser setup unavailable");
    const value = await bridge.gatewayFetch(`/api/browser/setup${retry ? "/retry" : ""}`, retry
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } : {}, 10_000);
    signal.throwIfAborted();
    return value;
  };
  return { requiresDesktopUpdate, status: signal => request(signal, false), retry: signal => request(signal, true) };
}
/** The same fixed setup API is used by Web views and the native hosted UI. */
export function createBrowserSetupTransport(gatewayUrl: string): BrowserSetupTransport {
  const endpoint = browserEndpoint(gatewayUrl);
  const base = `${endpoint.origin}${endpoint.gatewayPath}/api/browser/setup`;
  const request = async (signal: AbortSignal, retry: boolean): Promise<unknown> => {
    const response = await fetch(`${base}${retry ? "/retry" : ""}`, {
      method: retry ? "POST" : "GET", credentials: "include", redirect: "error", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      ...(retry ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
    });
    // Older runtimes/Preview retain their existing viewer admission policy.
    if (!retry && response.status === 404) { await response.body?.cancel(); return { status: "ready", retryAvailable: false }; }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Browser setup unavailable"); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 4096 || chunks.length >= 64) { await reader.cancel(); throw new Error("Browser setup unavailable"); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally { reader.releaseLock(); }
  };
  return { status: signal => request(signal, false), retry: signal => request(signal, true) };
}
