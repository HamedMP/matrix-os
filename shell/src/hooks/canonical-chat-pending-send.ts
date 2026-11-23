import { pendingCanonicalTurnMessage, withPendingCanonicalTurn, type PendingCanonicalTurn } from "@matrix-os/ui";
import type { CanonicalChatDetailResponse, CanonicalChatMessagePart, CanonicalChatResourceReference } from "@matrix-os/contracts";
import type { ChatMessage } from "@/lib/chat";
import { projectCanonicalMessages } from "@/lib/canonical-chat-client";
import { projectCanonicalTranscript } from "@/lib/canonical-chat-terminal-notices";

/**
 * The message being sent, shown from the moment it is sent: before a new Chat
 * is created, before attachments upload, and before admission confirms its
 * turn. Scoped to the authority and the Chat it was sent from (undefined: the
 * new-Chat draft, further keyed by the draft session so New Chat starts empty);
 * the token lets a send replace or clear only its own message.
 */
export type PendingCanonicalSend = {
  token: object;
  identity: string;
  sourceChatId: string | undefined;
  draftSession: number;
  turn: PendingCanonicalTurn;
};

/** Text and references show at once; attachments join once uploaded. */
export function optimisticCanonicalSendParts(text: string, promptText?: string, resources?: readonly CanonicalChatResourceReference[]): CanonicalChatMessagePart[] {
  return [
    ...(text.trim() ? [{ type: "text" as const, text: promptText?.trim() || text.trim() }] : []),
    ...(resources ?? []).map((resource) => ({ type: "resource_reference" as const, resource })),
  ];
}

/** Replaces this send's message, keeping the time it was first shown. */
export function nextPendingCanonicalSend(
  previous: PendingCanonicalSend | null,
  send: Omit<PendingCanonicalSend, "turn">,
  turn: Omit<PendingCanonicalTurn, "createdAt">,
): PendingCanonicalSend {
  const createdAt = previous?.token === send.token ? previous.turn.createdAt : new Date().toISOString();
  return { ...send, turn: { ...turn, createdAt } };
}

/**
 * The transcript with the pending message: appended to the open Chat's detail,
 * or alone for a new Chat that does not exist yet or whose detail has not
 * loaded. Display only.
 */
export function canonicalTranscriptWithPendingSend(input: {
  detail: CanonicalChatDetailResponse | null;
  pending: PendingCanonicalSend | null;
  activeChatId: string | undefined;
  draftSession: number;
  collaborationViewOpen: boolean;
}): ChatMessage[] {
  const { detail, pending, activeChatId } = input;
  if (detail) return projectCanonicalTranscript(withPendingCanonicalTurn(detail, pending?.turn));
  if (input.collaborationViewOpen || !pending || pending.sourceChatId !== undefined) return [];
  if (pending.draftSession !== input.draftSession) return [];
  if (activeChatId !== undefined && pending.turn.chatId !== activeChatId) return [];
  return projectCanonicalMessages([pendingCanonicalTurnMessage(pending.turn)]);
}
