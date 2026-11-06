import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";

/** Display metadata only; this never grants authority or supplies task text. */
export interface ScheduledMessagePresentation { timestamp: string }

export function scheduledMessageTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

/** Native admission persists a system input and an exact occurrence request.
 * Public/manual admission cannot produce this role/purpose combination. */
export function nativeScheduledMessage(message: CanonicalChatMessage, context: {
  chatId?: string; turns: readonly CanonicalChatTurn[]; runs: readonly CanonicalChatRun[];
}): ScheduledMessagePresentation | undefined {
  if (!context.chatId || message.chatId !== context.chatId || message.role !== "system" || message.purpose !== "system"
    || message.state !== "committed" || !message.turnId || !Number.isFinite(Date.parse(message.createdAt))) return undefined;
  const turns = context.turns.filter(turn => turn.id === message.turnId && turn.chatId === context.chatId && turn.inputMessageId === message.id);
  if (turns.length !== 1) return undefined;
  const turn = turns[0]!;
  if (!/^req_native_[a-f0-9]{64}$/.test(turn.clientRequestId) || turn.baseMessageSeq !== message.seq - 1) return undefined;
  const origins = context.runs.filter(run => run.chatId === context.chatId && run.turnId === turn.id && run.attempt === 1);
  if (origins.length !== 1 || origins[0]!.driverKind !== "claude_code" || (message.runId && message.runId !== origins[0]!.id)) return undefined;
  return { timestamp: message.createdAt };
}
