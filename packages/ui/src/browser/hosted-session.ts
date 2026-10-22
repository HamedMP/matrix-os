import type { BrowserSessionOptions } from "./types.js";

/** The native launch already installs a ten-minute signed, app-scoped cookie. */
export function createHostedBrowserSession(renew: (signal: AbortSignal) => Promise<void>, now = () => Date.now()) {
  let refreshedAt = now();
  let pending: Promise<void> | null = null;
  return async (signal: AbortSignal, options?: BrowserSessionOptions): Promise<void> => {
    signal.throwIfAborted();
    if (!pending && !options?.force && now() - refreshedAt < 480_000) return;
    if (!pending) {
      pending = (async () => { await renew(AbortSignal.timeout(10_000)); refreshedAt = now(); })()
        .finally(() => { pending = null; });
    }
    await pending;
    signal.throwIfAborted();
  };
}
