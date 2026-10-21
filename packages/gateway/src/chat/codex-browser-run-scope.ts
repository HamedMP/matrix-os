import { openNativeSharedBrowserRun, type NativeBrowserRunInput } from "./native-shared-browser-run.js";
import { withNativeBrowserExecution } from "./native-browser-execution-context.js";
import type { SharedBrowserBroker } from "../shared-browser/broker.js";
import { boundedOperation } from "../bounded-operation.js";

/** Bounded active canonical admissions; close drains before allowing a successor. */
export function createCodexBrowserRunScope(options: { broker: SharedBrowserBroker; gatewayPort: number } | undefined, maxRuns = 64) {
  const active = new Map<string, { ownerId: string; chatId: string; cancel(): Promise<void> }>();
  return {
    open(input: NativeBrowserRunInput) {
      if (active.has(input.runId) || active.size >= maxRuns) throw new Error("Browser run unavailable");
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const browser = options ? openNativeSharedBrowserRun({ ...options, harness: "codex" }, { ...input, signal }) : undefined;
      const pendingBootstraps = new Set<Promise<void>>();
      let draining: Promise<void> | undefined;
      let cleanupUnconfirmed = false;
      let released = false;
      function markCleanupUnconfirmed(): void {
        if (cleanupUnconfirmed) return;
        cleanupUnconfirmed = true;
        input.onCleanupUnconfirmed?.();
      }
      function beginBootstrap(): () => void {
        if (released || pendingBootstraps.size >= 4) {
          markCleanupUnconfirmed();
          throw new Error("Browser cleanup unconfirmed");
        }
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        pendingBootstraps.add(pending);
        return () => { pendingBootstraps.delete(pending); finish(); };
      }
      function drainAuthority(): Promise<void> {
        return draining ??= (async () => {
          try { await browser?.close(); }
          catch (error: unknown) { markCleanupUnconfirmed(); throw error; }
        })();
      }
      async function settleCleanup(): Promise<void> {
        await drainAuthority();
        try {
          // Native bind is bounded at 30s and failed-bootstrap stop at 5s.
          // Timeout quarantines admission; it is never evidence of process exit.
          await boundedOperation(async () => {
            while (pendingBootstraps.size) await Promise.all([...pendingBootstraps]);
          }, 40_000);
        } catch (error: unknown) {
          markCleanupUnconfirmed();
          throw new Error("Browser cleanup unconfirmed", { cause: error });
        }
        if (cleanupUnconfirmed) throw new Error("Browser cleanup unconfirmed");
      }
      // Cancel revokes authority immediately, but cannot release native admission.
      const row = { ownerId: input.owner.ownerId, chatId: input.chatId,
        cancel: async () => { controller.abort(); await settleCleanup(); },
      };
      async function close(): Promise<void> {
        // Never cache this final check: an earlier cancel drain can complete
        // before an in-flight bootstrap reports uncertain physical cleanup.
        await settleCleanup();
        if (active.get(input.runId) === row) active.delete(input.runId);
        released = true;
      }
      active.set(input.runId, row);
      return {
        withContext: <T>(operation: () => T) => withNativeBrowserExecution(input.owner.ownerId, browser,
          operation, markCleanupUnconfirmed, { signal, begin: beginBootstrap }),
        close,
      };
    },
    async cancel(input: { ownerId: string; chatId: string; runId: string }) {
      const row = active.get(input.runId);
      if (row?.ownerId === input.ownerId && row.chatId === input.chatId) await row.cancel();
    },
  };
}
