import type { CodexControlClient } from "./codex-control-client.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import type { NativeSharedBrowserRun } from "../chat/native-shared-browser-run.js";
import { beginNativeBrowserBootstrap, markNativeBrowserCleanupUnconfirmed } from "../chat/native-browser-execution-context.js";
import { boundedOperation } from "../bounded-operation.js";

/** Never replay bootstrap bytes after an uncertain acknowledgement. */
export async function prepareCodexBrowser(input: {
  ownerId: string; sessionId: string; browser: NativeSharedBrowserRun;
  control: CodexControlClient; runtime: Pick<WorkspaceSessionOrchestrator, "stopSession">;
  signal: AbortSignal;
}) {
  const bootstrap = beginNativeBrowserBootstrap(input.ownerId);
  const signal = bootstrap ? AbortSignal.any([input.signal, bootstrap.signal]) : input.signal;
  try {
    signal.throwIfAborted();
    if (!input.browser.isLive() || !input.control.prepareBrowser) throw new Error("Browser startup unavailable");
    await input.control.prepareBrowser({ sessionId: input.sessionId, signal,
      browser: { attemptId: input.browser.attemptId, token: input.browser.token,
        gatewayPort: Number(input.browser.mcpServer.env.MATRIX_SHARED_BROWSER_GATEWAY_PORT) },
    });
    signal.throwIfAborted();
    if (!input.browser.isLive()) throw new Error("Browser startup unavailable");
  } catch (error: unknown) {
    try {
      const stopped = await boundedOperation(() => input.runtime.stopSession(input.sessionId), 5_000);
      if (!stopped.ok) throw new Error("Native cleanup unavailable");
    } catch (cleanupError: unknown) {
      console.warn("[shared-browser-codex] Cleanup unconfirmed", cleanupError instanceof Error ? cleanupError.name : "UnknownError");
      markNativeBrowserCleanupUnconfirmed(input.ownerId);
    }
    throw error;
  } finally { bootstrap?.finish(); }
}
