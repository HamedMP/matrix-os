export interface IdleWorkspaceIdentity {
  ownerId: string;
  threadId: string;
  sessionId: string;
  providerThreadId: string;
}

type StoredThread = {
  id: string; ownerId: string; providerId: string; status: string; attention: string;
  updatedAt: string; activeTurnId?: string;
  providerResumeState?: { conversationId: string; providerThreadId?: string };
};

/** Run inside the thread-store admission queue, not from an unlocked process inventory. */
export async function withIdleWorkspaceState(
  state: { threads: StoredThread[]; turns: Array<{ threadId: string; status: string }> },
  sessionId: string,
  cutoff: number,
  action: (identity: IdleWorkspaceIdentity) => Promise<boolean>,
): Promise<boolean> {
  const thread = state.threads.find((candidate) => `sess_${candidate.id.slice("thread_".length)}` === sessionId);
  if (!thread || thread.providerId !== "codex" || thread.activeTurnId
    || !["completed", "failed", "aborted"].includes(thread.status)
    || !["none", "failed"].includes(thread.attention)
    || !Number.isFinite(cutoff) || !(Date.parse(thread.updatedAt) <= cutoff)
    || thread.providerResumeState?.conversationId !== sessionId || !thread.providerResumeState.providerThreadId
    || state.turns.some((turn) => turn.threadId === thread.id && ["accepted", "running"].includes(turn.status))) return false;
  return action({ ownerId: thread.ownerId, threadId: thread.id, sessionId,
    providerThreadId: thread.providerResumeState.providerThreadId });
}
