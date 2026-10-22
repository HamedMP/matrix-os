import type { SharedBrowserBroker } from "../shared-browser/broker.js";
import type { OpenClawRpcClient } from "../agent-config/openclaw-rpc.js";
import { randomBytes } from "node:crypto";
/** The native idempotencyKey is its runtime runId in pinned OpenClaw 2026.7.1. */
export async function openOpenClawSharedBrowserRun(options: { broker: SharedBrowserBroker; rpc: OpenClawRpcClient; ownerId: string;
  chatId: string; runId: string; sessionKey: string; signal: AbortSignal }): Promise<{ close(): Promise<void>; markDispatched(): void }> {
  const lease = options.broker.openRun({ ownerId: options.ownerId, chatId: options.chatId, runId: options.runId, harness: "openclaw" }, options.signal);
  let closing: Promise<void> | undefined;
  const bindingId = randomBytes(16).toString("hex");
  let dispatched = false;
  function close(): Promise<void> { return closing ??= (async () => {
    const nativeNotStarted = !dispatched;
    // Gateway revokes bearer authority immediately, then drains without closing Chrome.
    try { await options.broker.closeRun(options.runId); }
    catch (error: unknown) { console.warn("[shared-browser-openclaw] Browser cleanup unavailable", error instanceof Error ? error.name : "UnknownError"); }
    try { await options.rpc.call("matrix.browser.revoke", { runId: options.runId, bindingId, ...(nativeNotStarted ? { nativeNotStarted: true } : {}) }, AbortSignal.timeout(10_000), { timeoutMs: 10_000 }); }
    catch (error: unknown) { console.warn("[shared-browser-openclaw] Native lease cleanup unavailable", error instanceof Error ? error.name : "UnknownError"); }
  })(); }
  try {
    const result: unknown = await options.rpc.call("matrix.browser.bind", { runId: options.runId, sessionKey: options.sessionKey, token: lease.token, expiresAt: lease.expiresAt, bindingId },
      AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]), { timeoutMs: 10_000 });
    if (!result || typeof result !== "object" || !("bound" in result) || result.bound !== true) throw new Error("Native browser tool unavailable");
    options.signal.throwIfAborted(); return { close, markDispatched() { dispatched = true; } };
  } catch (error: unknown) { await close(); throw error; }
}
