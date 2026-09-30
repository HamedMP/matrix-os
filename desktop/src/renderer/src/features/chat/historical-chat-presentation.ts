import type { CanonicalChatMessage } from "@matrix-os/contracts";
import type { ConversationTurnPresentation, ConversationWorkPresentation } from "../../components/conversation/presentation";
import { messagePresentation, messageWork, hasDisplayableMessageContent, type HistoricalToolContext } from "./canonical-chat-message-presentation";
const MAX_TOOL_LINKS = 500;
const MAX_FRAGMENT_PARTS = 64;
function provenance(message: CanonicalChatMessage) {
  return message.parts.find(part => part.type === "import_provenance");
}
/** Merge only adjacent prose fragments from one response; a tool/status is an ordering boundary. */
function responseFragments(input: CanonicalChatMessage[]): CanonicalChatMessage[] {
  const messages: CanonicalChatMessage[] = [];
  for (const message of input) {
    const prior = messages.at(-1); const left = prior && provenance(prior); const right = provenance(message);
    const prose = (value: CanonicalChatMessage) => value.parts.every(part => ["text", "import_reference", "import_provenance"].includes(part.type));
    if (prior && left?.type === "import_provenance" && right?.type === "import_provenance"
      && prior.role === message.role && left.sourceKey === right.sourceKey && left.phase === right.phase
      && prose(prior) && prose(message) && prior.parts.length + message.parts.length < MAX_FRAGMENT_PARTS) {
      messages[messages.length - 1] = { ...prior, parts: [...prior.parts, { type: "text", text: "\n\n" }, ...message.parts] };
    } else messages.push(message);
  }
  return messages;
}
function toolLinks(messages: CanonicalChatMessage[]): ReadonlyMap<string, HistoricalToolContext> {
  // Per-snapshot FIFO eviction; never retain an unbounded transcript-wide registry.
  const links = new Map<string, HistoricalToolContext>();
  for (const message of messages) for (const part of message.parts) {
    if (part.type !== "tool_request" && part.type !== "tool_result") continue;
    if (!links.has(part.toolCallId) && links.size >= MAX_TOOL_LINKS) links.delete(links.keys().next().value!);
    const prior = links.get(part.toolCallId) ?? {};
    links.set(part.toolCallId, part.type === "tool_request" ? { ...prior, request: part }
      : { ...prior, outcome: prior.outcome === "failed" || part.outcome === "failed" ? "failed"
        : prior.outcome === "cancelled" || part.outcome === "cancelled" ? "cancelled" : part.outcome });
  }
  return links;
}
/** Imported history is ordered by saved source sequence; it has no executable Run or invented input. */
export function historicalChatPresentation(input: CanonicalChatMessage[], id: string, inputMessageId?: string): ConversationTurnPresentation {
  const ordered = input.slice().sort((a, b) => a.seq - b.seq);
  const context = toolLinks(ordered); const messages = responseFragments(ordered);
  const user = messages.find(message => message.id === inputMessageId && message.role === "user");
  const final = messages.filter(message => message.role === "assistant" && message.parts.some(part => part.type === "import_provenance" && part.phase === "final") && hasDisplayableMessageContent(message)).at(-1);
  const work: ConversationWorkPresentation[] = messages.flatMap(message => {
    if (message.id === user?.id || message.id === final?.id) return [];
    return [ ...messageWork(message, context), ...(hasDisplayableMessageContent(message) ? [messagePresentation(message, "commentary")] : []) ];
  });
  if (final) work.push(...messageWork(final, context));
  return { id, active: false, expandedByDefault: true,
    startedAt: Date.parse(messages[0]!.createdAt), endedAt: Date.parse(messages.at(-1)!.createdAt),
    ...(user ? { user: messagePresentation(user, "commentary") } : {}), work,
    ...(final ? { final: messagePresentation(final, "final") } : {}),
  };
}
