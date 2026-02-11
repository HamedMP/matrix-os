import type { ServerMessage } from "@/hooks/useSocket";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tool?: string;
  timestamp: number;
}

export function reduceChat(
  messages: ChatMessage[],
  event: ServerMessage,
): ChatMessage[] {
  const next = [...messages];

  switch (event.type) {
    case "kernel:text": {
      const last = next[next.length - 1];
      if (last?.role === "assistant" && !last.tool) {
        next[next.length - 1] = { ...last, content: last.content + event.text };
      } else {
        next.push({
          id: `msg-${Date.now()}`,
          role: "assistant",
          content: event.text,
          timestamp: Date.now(),
        });
      }
      break;
    }
    case "kernel:tool_start": {
      next.push({
        id: `msg-${Date.now()}`,
        role: "system",
        content: `Using ${event.tool}...`,
        tool: event.tool,
        timestamp: Date.now(),
      });
      break;
    }
    case "kernel:tool_end": {
      const last = next[next.length - 1];
      if (last?.tool) {
        next[next.length - 1] = { ...last, content: `Used ${last.tool}` };
      }
      break;
    }
    case "kernel:error": {
      next.push({
        id: `msg-${Date.now()}`,
        role: "system",
        content: event.message,
        timestamp: Date.now(),
      });
      break;
    }
  }

  return next;
}
