import { timingSafeEqual } from "node:crypto";
import type { CodexControlClient } from "./codex-control-client.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import { nativeCodexMcpExecution, type CodexTerminalMcpLease } from "../chat/codex-mcp-run-scope.js";
import { boundedOperation } from "../bounded-operation.js";
import {
  beginNativeBrowserBootstrap,
  markNativeBrowserCleanupUnconfirmed,
} from "../chat/native-browser-execution-context.js";

/** Private startup handoff; uncertain acknowledgement is stopped, never replayed. */
export async function prepareCodexTerminalMcp(input: {
  ownerId: string;
  sessionId: string;
  lease: CodexTerminalMcpLease;
  control: CodexControlClient;
  runtime: Pick<WorkspaceSessionOrchestrator, "stopSession">;
  signal: AbortSignal;
}) {
  const bootstrap = beginNativeBrowserBootstrap(input.ownerId);
  const signal = bootstrap ? AbortSignal.any([input.signal, bootstrap.signal]) : input.signal;
  const assertCurrent = () => {
    signal.throwIfAborted();
    const current = nativeCodexMcpExecution(input.ownerId);
    if (
      !current ||
      current.attemptId !== input.lease.attemptId ||
      !timingSafeEqual(Buffer.from(current.token), Buffer.from(input.lease.token))
    ) {
      throw new Error("Matrix MCP startup unavailable");
    }
  };
  try {
    assertCurrent();
    if (!input.control.prepareMatrixMcp) throw new Error("Matrix MCP startup unavailable");
    await input.control.prepareMatrixMcp({ sessionId: input.sessionId, matrixMcp: input.lease, signal });
    assertCurrent();
  } catch (error: unknown) {
    try {
      const stopped = await boundedOperation(() => input.runtime.stopSession(input.sessionId), 5_000);
      if (!stopped.ok) throw new Error("Native cleanup unavailable");
    } catch (cleanupError: unknown) {
      console.warn(
        "[matrix-mcp-codex] Cleanup unconfirmed",
        cleanupError instanceof Error ? cleanupError.name : "UnknownError",
      );
      markNativeBrowserCleanupUnconfirmed(input.ownerId);
    }
    throw error;
  } finally {
    bootstrap?.finish();
  }
}
