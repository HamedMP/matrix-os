/** Only the current private Chat's committed canonical uploads can be remounted. */
import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
import type { ChatRepository } from "../chat/repository.js";
import type { ChatRecord } from "../chat/records.js";
import { BotBrokerActionError } from "./broker-actions.js";
export type HistoricalInput = { part: Extract<CanonicalChatMessagePart, { type: "attachment_reference" }>; seq: number };
export const BOT_HISTORY_REFERENCE_LIMIT = 40;
export type BotInputHistoryReader = (input: { ownerId: string; chatId: string; runId: string; signal: AbortSignal }) => Promise<{
  references: HistoricalInput[]; assertCurrent(): Promise<void>;
}>;
const stale = () => new BotBrokerActionError("stale_generation");
export function createBotInputHistoryReader(repository: Pick<ChatRepository, "get" | "getTurnRunContext" | "getDetailPage">): BotInputHistoryReader {
  return async input => {
    const owner = { type: "personal" as const, ownerId: input.ownerId };
    const owned = (record: ChatRecord | null) => {
      if (input.signal.aborted || !record || record.chat.id !== input.chatId || record.chat.ownerScope.type !== "personal"
        || record.chat.ownerScope.ownerId !== input.ownerId || record.chat.lifecycle !== "active" || record.chat.collaboration
        || record.activeRun?.runId !== input.runId) throw stale();
      return record;
    };
    const initial = owned(await repository.get(owner, input.chatId));
    const turnId = initial.activeRun!.turnId;
    const context = await repository.getTurnRunContext(owner, input.chatId, turnId);
    const boundary = context?.latestRun.historyBoundarySeq;
    const assertContext = (current: typeof context) => {
      if (!current || current.turn.id !== turnId || current.turn.chatId !== input.chatId
        || current.latestRun.id !== input.runId || current.latestRun.turnId !== turnId || current.latestRun.chatId !== input.chatId
        || current.latestRun.historyBoundarySeq !== boundary || boundary !== current.turn.baseMessageSeq
        || !["accepted", "running", "waiting_for_approval", "waiting_for_input"].includes(current.latestRun.status)) throw stale();
      const record = owned(current.chat);
      if (record.activeRun!.turnId !== turnId) throw stale();
    };
    assertContext(context);
    const assertCurrent = async () => { assertContext(await repository.getTurnRunContext(owner, input.chatId, turnId)); };
    const detail = boundary ? await repository.getDetailPage(owner, input.chatId, { beforeSeq: boundary + 1, limit: 40 }) : undefined;
    if (boundary && !detail) throw stale();
    if (detail) owned(detail.record);
    await assertCurrent();
    const admittedTurns = new Set(detail?.runs.filter(run => run.chatId === input.chatId).map(run => run.turnId));
    const references = (detail?.messages ?? []).slice(-40).filter(message => message.chatId === input.chatId
      && message.seq <= boundary! && message.role === "user" && message.state === "committed" && message.purpose === "ai_request"
      && message.actorId === input.ownerId && message.turnId !== undefined && admittedTurns.has(message.turnId))
      .sort((a, b) => b.seq - a.seq).flatMap(message => message.parts.filter((part): part is HistoricalInput["part"] =>
        part.type === "attachment_reference" && /^temporary\/desktop-chat\/[^/\\\u0000-\u001f\u007f]{1,255}$/.test(part.ownerReference ?? ""))
        .map(part => ({ part, seq: message.seq })));
    return { references: references.slice(0, BOT_HISTORY_REFERENCE_LIMIT), assertCurrent };
  };
}
