import type { ChatOwner } from "./records.js";

export function dispatchAdmissionKey(kind: "turn" | "retry", clientRequestId: string, turnId?: string): string {
  return JSON.stringify([kind, turnId ?? null, clientRequestId]);
}

/** Stop clears the durable activeRun for UX, not this process's execution ownership. */
export function hasStoppingChatExecution(
  executions: Iterable<{ owner: ChatOwner; chatId: string; controller: AbortController; admissionKey?: string }>,
  owner: ChatOwner,
  chatId: string,
  replayKey?: string,
): boolean {
  for (const execution of executions) {
    if (execution.chatId === chatId && execution.owner.type === owner.type
      && execution.owner.ownerId === owner.ownerId && execution.controller.signal.aborted
      && (replayKey === undefined || execution.admissionKey !== replayKey)) return true;
  }
  return false;
}
