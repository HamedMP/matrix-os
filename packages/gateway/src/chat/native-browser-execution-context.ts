import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeSharedBrowserRun } from "./native-shared-browser-run.js";

// Internal gateway-only scope: neither public request fields nor persisted state.
// Async callbacks created during admission retain their own execution scope.
const executions = new AsyncLocalStorage<{ ownerId: string; browser: NativeSharedBrowserRun; onCleanupUnconfirmed?: () => void }>();
export function withNativeBrowserExecution<T>(ownerId: string, browser: NativeSharedBrowserRun | undefined, operation: () => T, onCleanupUnconfirmed?: () => void): T {
  return browser ? executions.run({ ownerId, browser, onCleanupUnconfirmed }, operation) : executions.exit(operation);
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
