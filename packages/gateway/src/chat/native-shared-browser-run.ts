import type { SharedBrowserSupervisedPolicy } from "../shared-browser/approval-policy.js";
import { randomUUID } from "node:crypto";
import { SharedBrowserError, type SharedBrowserBroker } from "../shared-browser/broker.js";
import { sharedBrowserEndpoint } from "./shared-browser-client.js";

export const NATIVE_SHARED_BROWSER_SERVER = "matrix_shared_browser";
export const NATIVE_SHARED_BROWSER_TOOL = "mcp__matrix_shared_browser__shared_browser";
export interface NativeBrowserRunInput {
  owner: { type: string; ownerId: string }; chatId: string; runId: string;
  permissionMode: string; interactionMode: string; sharedScopeId?: string; signal: AbortSignal; onCleanupUnconfirmed?: () => void;
}
/** An execution-only lease. Never put this value in a persisted Chat or session. */
export function openNativeSharedBrowserRun(options: {
  broker: SharedBrowserBroker; gatewayPort: number; harness: "codex" | "claude_code";
  authorizeAction?: SharedBrowserSupervisedPolicy["authorizeAction"];
}, input: NativeBrowserRunInput) {
  sharedBrowserEndpoint(options.gatewayPort);
  if (input.owner.type !== "personal" || input.sharedScopeId || !["full_access", "supervised"].includes(input.permissionMode) || input.interactionMode !== "default") return undefined;
  input.signal.throwIfAborted();
  let lease: ReturnType<SharedBrowserBroker["openRun"]>;
  try { lease = options.broker.openRun({ ownerId: input.owner.ownerId, chatId: input.chatId, runId: input.runId, harness: options.harness }, input.signal,
      input.permissionMode === "supervised" ? { mode: "supervised", authorizeAction: options.authorizeAction ?? options.broker.authorizeAction
        ?? (async () => { throw new SharedBrowserError("browser_changed"); }) } : undefined); }
  catch (error: unknown) {
    console.warn("[shared-browser-native] Run admission unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new Error("Browser run unavailable");
  }
  let closing: Promise<void> | undefined;
  return {
    isLive: () => options.broker.resolveCapability(lease.token) !== null,
    attemptId: randomUUID(), token: lease.token, expiresAt: lease.expiresAt,
    mcpServer: {
      command: "/opt/matrix/runtime/node/bin/node",
      args: ["/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js"],
      env: { MATRIX_SHARED_BROWSER_TOKEN: lease.token, MATRIX_SHARED_BROWSER_GATEWAY_PORT: String(options.gatewayPort) },
    },
    close(): Promise<void> {
      // Exact-row cleanup also awaits an abort-started drain. It cannot revoke
      // a successor that reused the canonical run ID.
      return closing ??= lease.close();
    },
  };
}
export type NativeSharedBrowserRun = NonNullable<ReturnType<typeof openNativeSharedBrowserRun>>;
