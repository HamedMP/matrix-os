import { isRoutineDirectChatId, type CanonicalChatMessage, type CanonicalChatRun, type CanonicalChatTurn } from "@matrix-os/contracts";

/** Display metadata only; this never grants authority or supplies task text. */
export interface ScheduledMessagePresentation { timestamp: string }

export function scheduledMessageTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

type TurnContext = { chatId?: string; turns: readonly CanonicalChatTurn[] };

/** A stored system input at the exact native occurrence boundary is service-generated. */
function nativeScheduledInputTurn(message: CanonicalChatMessage, context: TurnContext): CanonicalChatTurn | undefined {
  if (!context.chatId || message.chatId !== context.chatId || message.role !== "system" || message.purpose !== "system"
    || message.state !== "committed" || !message.turnId || !Number.isFinite(Date.parse(message.createdAt))) return undefined;
  const turns = context.turns.filter(turn => turn.id === message.turnId && turn.chatId === context.chatId && turn.inputMessageId === message.id);
  if (turns.length !== 1) return undefined;
  const turn = turns[0]!;
  return /^req_native_[a-f0-9]{64}$/.test(turn.clientRequestId) && turn.baseMessageSeq === message.seq - 1 ? turn : undefined;
}

export function isNativeScheduledInput(message: CanonicalChatMessage, context: TurnContext): boolean {
  return nativeScheduledInputTurn(message, context) !== undefined;
}

/** The optional annotation also requires the original Claude Code attempt. */
export function nativeScheduledMessage(message: CanonicalChatMessage, context: TurnContext & {
  runs: readonly CanonicalChatRun[];
}): ScheduledMessagePresentation | undefined {
  const turn = nativeScheduledInputTurn(message, context);
  if (!turn) return undefined;
  const origins = context.runs.filter(run => run.chatId === context.chatId && run.turnId === turn.id && run.attempt === 1);
  if (origins.length !== 1 || origins[0]!.driverKind !== "claude_code" || (message.runId && message.runId !== origins[0]!.id)) return undefined;
  return { timestamp: message.createdAt };
}

/** Gateway direct and queued admission reserve both of these request identities. */
export function isPrivateAutomationRequest(chatId: string, requestId: string): boolean {
  return /^req_slack_summary_[a-f0-9]{40}$/.test(requestId)
    || (isRoutineDirectChatId(chatId) && /^req_routine_fire_[a-f0-9]{24}(?:_a[23])?$/.test(requestId));
}

export function isPrivateAutomationInput(message: CanonicalChatMessage, context: TurnContext): boolean {
  if (!context.chatId || message.chatId !== context.chatId || message.role !== "user"
    || message.purpose !== "ai_request" || message.state !== "committed" || !message.turnId) return false;
  return context.turns.some(turn => turn.chatId === context.chatId && turn.id === message.turnId
    && turn.inputMessageId === message.id && isPrivateAutomationRequest(turn.chatId, turn.clientRequestId));
}
