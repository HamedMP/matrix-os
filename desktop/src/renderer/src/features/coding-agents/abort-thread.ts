// Abort bridge for agent threads. Rides the trusted-core IPC channel
// "runtime:abort-thread" (desktop/src/shared/ipc-contract.ts), which posts to
// the gateway's POST /api/coding-agents/threads/:threadId/abort. The composer
// Stop button renders only while a turn is busy and the preload bridge is
// present (agentThreadAbortSupported()).
//
// The route returns the authoritative aborted snapshot. Applying it matters
// when `runtime:subscribe-thread-events` has failed or disconnected: without
// it the conversation keeps deriving `threadBusy` from the stale running
// snapshot, leaving the composer blocked and Stop visible until some later
// refresh.
import { invoke } from "../../lib/operator";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";

export function agentThreadAbortSupported(): boolean {
  return (
    typeof window !== "undefined" && typeof window.operator?.invoke === "function"
  );
}

/**
 * Best-effort abort. Failure is surfaced through the shared turnError channel:
 * the caller is fire-and-forget, and without this the user clicks Stop, sees
 * the identical busy UI, and has no way to tell the request failed while the
 * agent keeps running.
 */
export async function abortAgentThread(threadId: string): Promise<boolean> {
  if (!agentThreadAbortSupported()) return false;
  const runtimeGeneration = captureRuntimeGeneration();
  try {
    const snapshot = await invoke("runtime:abort-thread", { threadId });
    // Identity: the abort belongs to the computer it was issued from.
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return false;
    // Selection: only settle the conversation still on screen. Deselecting and
    // reselecting the same thread mid-abort would otherwise let this stale
    // snapshot replace the freshly loaded one.
    const state = useCodingAgentWorkspace.getState();
    if (snapshot && state.activeThreadId === threadId) {
      useCodingAgentWorkspace.setState({
        threadSnapshot: snapshot,
        threadSnapshotStatus: "ready",
        threadSnapshotError: null,
        // Clear a message left by an earlier failed attempt on this thread;
        // otherwise a successful retry still shows "could not stop".
        ...(state.turnThreadId === threadId ? { turnError: null } : {}),
      });
    }
    return true;
  } catch (err: unknown) {
    // Log the real shape for support; show the user generic copy only.
    console.warn(
      "[coding-agents] thread abort failed:",
      err instanceof Error ? err.message : String(err),
    );
    if (!isCurrentRuntimeGeneration(runtimeGeneration)) return false;
    const state = useCodingAgentWorkspace.getState();
    if (state.activeThreadId === threadId) {
      useCodingAgentWorkspace.setState({
        turnThreadId: threadId,
        turnError: "Could not stop this conversation. It may still be running — try again.",
      });
    }
    return false;
  }
}
