import type {
  CanonicalChatMessage,
  CanonicalChatRun,
  CanonicalChatRunActivity,
  CanonicalChatTurn,
} from "@matrix-os/contracts";
import type {
  ConversationMessagePresentation,
  ConversationTurnPresentation,
} from "../../components/conversation/presentation";

function messageText(message: CanonicalChatMessage): string {
  return message.parts.flatMap((part) => {
    if (part.type === "text" || part.type === "summary") return [part.text];
    if (part.type === "status") return [part.detail ? `${part.label}\n\n${part.detail}` : part.label];
    if (part.type === "tool_result" && part.text) return [part.text];
    return [];
  }).join("\n\n");
}

function messagePresentation(
  message: CanonicalChatMessage,
  phase: "commentary" | "final",
): ConversationMessagePresentation {
  const markdown = messageText(message);
  const attachments = message.parts.flatMap((part) => part.type === "attachment_reference"
    ? [{ id: part.attachmentId, kind: "file" as const, label: part.label }]
    : []);
  return {
    kind: "message",
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    phase,
    markdown,
    copyText: markdown,
    timestamp: Date.parse(message.createdAt),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function isActiveRun(run: CanonicalChatRun | undefined): boolean {
  return run !== undefined && [
    "accepted",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
  ].includes(run.status);
}

export function canonicalChatPresentation(input: {
  messages: CanonicalChatMessage[];
  turns: CanonicalChatTurn[];
  runs: CanonicalChatRun[];
  activities: CanonicalChatRunActivity[];
}): ConversationTurnPresentation[] {
  return input.turns.map((turn) => {
    const userMessage = input.messages.find((message) => message.id === turn.inputMessageId);
    const runs = input.runs.filter((run) => run.turnId === turn.id)
      .sort((left, right) => left.attempt - right.attempt);
    const run = runs.at(-1);
    const assistantMessages = input.messages.filter((message) => (
      message.turnId === turn.id && message.role === "assistant"
    ));
    const finalMessage = assistantMessages.at(-1);
    const work = assistantMessages.slice(0, -1).map((message) => messagePresentation(message, "commentary"));
    const startedAt = Date.parse(run?.startedAt ?? run?.createdAt ?? turn.createdAt);
    const endedAt = Date.parse(run?.completedAt ?? run?.updatedAt ?? turn.updatedAt);
    return {
      id: turn.id,
      startedAt,
      endedAt,
      active: isActiveRun(run),
      ...(userMessage ? { user: messagePresentation(userMessage, "commentary") } : {}),
      work,
      ...(finalMessage ? { final: messagePresentation(finalMessage, "final") } : {}),
    };
  });
}
