import { ChatRunContextSchema, type CanonicalChatMessage, type ChatRunContext } from "@matrix-os/contracts";
import { ChatAgentContextError, transcript } from "./agent-context.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import { MATRIX_BOT_INSTANCE_ID } from "../bots/selection.js";

export const SESSION_HISTORY_MESSAGE_LIMIT = 40;
const SESSION_HISTORY_BYTE_LIMIT = 12_000;

/** History is reference text only: old tools, attachments and grants are never remounted. */
export function withChatSessionHistory(input: {
  chatId: string; title: string; throughSeq: number; requestHash: string;
  messages: CanonicalChatMessage[]; truncated: boolean; context?: ChatRunContext;
}): ChatRunContext {
  const history = transcript(input.messages.filter(message => message.seq <= input.throughSeq), SESSION_HISTORY_BYTE_LIMIT);
  return ChatRunContextSchema.parse({
    version: 1, requestHash: input.requestHash, chats: [], ...input.context,
    history: { chatId: input.chatId, title: input.title, throughSeq: input.throughSeq,
      ...history, truncated: input.truncated || history.truncated },
  });
}

/** A native continuation already has its canonical prefix; replay only on fresh starts. */
export function contextForChatSession(context: ChatRunContext | undefined, resumeState: unknown, preserveHistory = false): ChatRunContext | undefined {
  if (preserveHistory || resumeState === undefined || !context?.history || context.agent) return context;
  const rest = { ...context };
  delete rest.history;
  return rest;
}

/** Read the owner-scoped, immutable prefix before the admitted Turn, including on Retry. */
export async function prepareChatSessionContext(input: {
  repository: Pick<ChatRepository, "getDetailPage">; owner: ChatOwner; chatId: string;
  throughSeq: number; requestHash: string; instanceId: string;
  resumeState: unknown; context?: ChatRunContext; preserveHistory?: boolean;
}): Promise<ChatRunContext | undefined> {
  const context = contextForChatSession(input.context, input.resumeState, input.preserveHistory);
  if (input.resumeState !== undefined || input.instanceId === MATRIX_BOT_INSTANCE_ID || input.throughSeq === 0) return context;
  // Retry preserves the original admitted history, not replies from its failed attempt.
  if (context?.history && context.history.throughSeq === input.throughSeq) return context;
  const detail = await input.repository.getDetailPage(input.owner, input.chatId, {
    beforeSeq: input.throughSeq + 1, limit: SESSION_HISTORY_MESSAGE_LIMIT,
  });
  if (!detail || detail.record.chat.lifecycle !== "active" || detail.record.chat.collaboration) {
    throw new ChatAgentContextError("context_unavailable");
  }
  return withChatSessionHistory({
    chatId: input.chatId, title: detail.record.chat.title, throughSeq: input.throughSeq,
    requestHash: input.requestHash, messages: detail.messages,
    truncated: detail.nextBeforeSeq !== undefined, ...(context ? { context } : {}),
  });
}
