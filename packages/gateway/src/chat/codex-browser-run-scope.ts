import { openNativeSharedBrowserRun, type NativeBrowserRunInput } from "./native-shared-browser-run.js";
import { withNativeBrowserExecution } from "./native-browser-execution-context.js";
import type { SharedBrowserBroker } from "../shared-browser/broker.js";

/** Bounded active canonical admissions; close drains before allowing a successor. */
export function createCodexBrowserRunScope(options: { broker: SharedBrowserBroker; gatewayPort: number } | undefined, maxRuns = 64) {
  const active = new Map<string, { ownerId: string; chatId: string; cancel(): Promise<void> }>();
  return {
    open(input: NativeBrowserRunInput) {
      if (active.has(input.runId) || active.size >= maxRuns) throw new Error("Browser run unavailable");
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const browser = options ? openNativeSharedBrowserRun({ ...options, harness: "codex" }, { ...input, signal }) : undefined;
      let closing: Promise<void> | undefined;
      let cleanupUnconfirmed = false;
      function markCleanupUnconfirmed(): void {
        if (cleanupUnconfirmed) return;
        cleanupUnconfirmed = true;
        input.onCleanupUnconfirmed?.();
      }
      const row = { ownerId: input.owner.ownerId, chatId: input.chatId, cancel: async () => { controller.abort(); await close(); } };
      function close(): Promise<void> {
        return closing ??= (async () => {
          try { await browser?.close(); }
          catch (error: unknown) { markCleanupUnconfirmed(); throw error; }
          // Durable failure projection cannot prove the native process stopped.
          // Revoke the broker lease, but retain admission and throw to Chat.
          if (cleanupUnconfirmed) throw new Error("Browser cleanup unconfirmed");
          if (active.get(input.runId) === row) active.delete(input.runId);
        })();
      }
      active.set(input.runId, row);
      return { withContext: <T>(operation: () => T) => withNativeBrowserExecution(input.owner.ownerId, browser, operation, markCleanupUnconfirmed), close };
    },
    async cancel(input: { ownerId: string; chatId: string; runId: string }) {
      const row = active.get(input.runId);
      if (row?.ownerId === input.ownerId && row.chatId === input.chatId) await row.cancel();
    },
  };
}
