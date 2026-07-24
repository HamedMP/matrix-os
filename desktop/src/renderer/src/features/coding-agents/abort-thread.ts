// Abort bridge for agent threads. Rides the trusted-core IPC channel
// "runtime:abort-thread" (desktop/src/shared/ipc-contract.ts), which posts to
// the gateway's POST /api/coding-agents/threads/:threadId/abort. The composer
// Stop button renders only while a turn is busy and the preload bridge is
// present (agentThreadAbortSupported()).

import { invoke } from "../../lib/operator";

export function agentThreadAbortSupported(): boolean {
  return (
    typeof window !== "undefined" && typeof window.operator?.invoke === "function"
  );
}

/** Best-effort abort; resolves false when unsupported or the bridge rejects. */
export async function abortAgentThread(threadId: string): Promise<boolean> {
  if (!agentThreadAbortSupported()) return false;
  try {
    await invoke("runtime:abort-thread", { threadId });
    return true;
  } catch {
    // Generic on purpose: provider error text must not reach client surfaces.
    console.warn("[coding-agents] thread abort failed");
    return false;
  }
}
