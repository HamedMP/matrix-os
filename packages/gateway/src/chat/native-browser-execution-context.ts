import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeSharedBrowserRun } from "./native-shared-browser-run.js";

// Internal gateway-only scope: neither public request fields nor persisted state.
// Async callbacks created during admission retain their own execution scope.
const executions = new AsyncLocalStorage<{ ownerId: string; browser: NativeSharedBrowserRun }>();
export function withNativeBrowserExecution<T>(ownerId: string, browser: NativeSharedBrowserRun | undefined, operation: () => T): T {
  return browser ? executions.run({ ownerId, browser }, operation) : executions.exit(operation);
}
export function nativeBrowserExecution(ownerId: string): NativeSharedBrowserRun | undefined {
  const execution = executions.getStore();
  if (!execution) return undefined;
  if (execution.ownerId !== ownerId || !execution.browser.isLive()) throw new Error("Browser run unavailable");
  return execution.browser;
}
