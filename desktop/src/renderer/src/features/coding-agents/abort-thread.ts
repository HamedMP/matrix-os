// Abort bridge for agent threads, wired through the typed operator IPC surface
// (`runtime:abort-thread` in desktop/src/shared/ipc-contract.ts) to the
// gateway's POST /threads/:threadId/abort route.
//
// The gateway returns the authoritative aborted snapshot. Applying it matters
// when `runtime:subscribe-thread-events` has failed or disconnected: without
// it the conversation keeps deriving `threadBusy` from the stale running
// snapshot, leaving the composer blocked and Stop visible until some later
// refresh.
import { invoke } from "../../lib/operator";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";

function abortRequestId(threadId: string): string {
  // Idempotency key for the abort mutation; the route requires one.
  return `abort_${threadId}_${Date.now().toString(36)}`;
}

export function agentThreadAbortSupported(): boolean {
  return typeof window !== "undefined" && typeof window.operator?.invoke === "function";
}

/** Best-effort abort; resolves false when unsupported or the bridge rejects. */
export async function abortAgentThread(threadId: string): Promise<boolean> {
  if (!agentThreadAbortSupported()) return false;
  try {
    const snapshot = await invoke("runtime:abort-thread", {
      threadId,
      clientRequestId: abortRequestId(threadId),
    });
    // Only apply to the conversation still on screen; a snapshot for a thread
    // the user has since navigated away from must not replace the active one.
    if (snapshot && useCodingAgentWorkspace.getState().activeThreadId === threadId) {
      useCodingAgentWorkspace.setState({
        threadSnapshot: snapshot,
        threadSnapshotStatus: "ready",
        threadSnapshotError: null,
      });
    }
    return true;
  } catch {
    // Generic on purpose: provider error text must not reach client surfaces.
    console.warn("[coding-agents] thread abort failed");
    return false;
  }
}
