// Optional abort bridge for agent threads. The desktop preload does NOT yet
// expose an agent-thread abort channel (see desktop/src/shared/ipc-contract.ts:
// the runtime:* invoke surface has runtime:create-turn, approvals, and input
// answers, but no cancel). When a later wave adds
// `window.matrix.abortThread(threadId)` on the preload side, the composer Stop
// button lights up with no further renderer changes; until then it stays
// hidden (agentThreadAbortSupported() === false).

declare global {
  interface Window {
    matrix?: {
      abortThread?: (threadId: string) => void | Promise<void>;
    };
  }
}

export function agentThreadAbortSupported(): boolean {
  return typeof window !== "undefined" && typeof window.matrix?.abortThread === "function";
}

/** Best-effort abort; resolves false when unsupported or the bridge rejects. */
export async function abortAgentThread(threadId: string): Promise<boolean> {
  const abort = typeof window !== "undefined" ? window.matrix?.abortThread : undefined;
  if (typeof abort !== "function") return false;
  try {
    await abort(threadId);
    return true;
  } catch {
    // Generic on purpose: provider error text must not reach client surfaces.
    console.warn("[coding-agents] thread abort failed");
    return false;
  }
}
