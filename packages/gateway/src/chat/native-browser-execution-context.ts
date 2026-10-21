import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeSharedBrowserRun } from "./native-shared-browser-run.js";

// Internal gateway-only scope: neither public request fields nor persisted state.
// Async callbacks created during admission retain their own execution scope.
interface NativeBrowserBootstrapTracker { signal: AbortSignal; begin(): () => void }
const executions = new AsyncLocalStorage<{ ownerId: string; browser: NativeSharedBrowserRun;
  onCleanupUnconfirmed?: () => void; bootstrap?: NativeBrowserBootstrapTracker }>();
export function withNativeBrowserExecution<T>(ownerId: string, browser: NativeSharedBrowserRun | undefined, operation: () => T, onCleanupUnconfirmed?: () => void, bootstrap?: NativeBrowserBootstrapTracker): T {
  return browser ? executions.run({ ownerId, browser, onCleanupUnconfirmed, bootstrap }, operation) : executions.exit(operation);
}
export function nativeBrowserExecution(ownerId: string): NativeSharedBrowserRun | undefined {
  const execution = executions.getStore();
  if (!execution) return undefined;
  if (execution.ownerId !== ownerId || !execution.browser.isLive()) throw new Error("Browser run unavailable");
  return execution.browser;
}

export function markNativeBrowserCleanupUnconfirmed(ownerId: string): void {
  const execution = executions.getStore();
  if (execution?.ownerId === ownerId) execution.onCleanupUnconfirmed?.();
}

/** Track bootstrap settlement separately from durable terminal projection. */
export function beginNativeBrowserBootstrap(ownerId: string): { signal: AbortSignal; finish(): void } | undefined {
  const execution = executions.getStore();
  if (!execution) return undefined;
  if (execution.ownerId !== ownerId) throw new Error("Browser run unavailable");
  if (!execution.bootstrap) return undefined;
  return { signal: execution.bootstrap.signal, finish: execution.bootstrap.begin() };
}
