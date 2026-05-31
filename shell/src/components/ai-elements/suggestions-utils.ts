import { type ChatMessage } from "@/lib/chat";

export const DEFAULT_SUGGESTIONS = [
  "What can you do?",
  "Build me an app",
  "Show my files",
];

export function parseSuggestions(content: string): string[] {
  const match = content.match(
    /<!-- suggestions: (.*?) -->/,
  );
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === "string");
      }
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        console.warn("[ai-elements] Failed to parse suggestions:", error);
      }
    }
  }
  return [];
}

export function getMessageSuggestions(messages: ChatMessage[]): string[] {
  if (messages.length === 0) return DEFAULT_SUGGESTIONS;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || message.tool) continue;
    const parsed = parseSuggestions(message.content);
    if (parsed.length > 0) return parsed;
    break;
  }

  return messages.length < 3 ? DEFAULT_SUGGESTIONS : [];
}
