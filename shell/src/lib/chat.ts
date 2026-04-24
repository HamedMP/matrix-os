import type { ServerMessage } from "@/hooks/useSocket";

let msgSeq = 0;
function newMsgId(): string {
  msgSeq = (msgSeq + 1) & 0xffff;
  return `msg-${Date.now()}-${msgSeq}`;
}

interface PersistedMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  tool?: string;
  toolInput?: Record<string, unknown>;
}

export function hydrateMessages(messages: PersistedMessage[]): ChatMessage[] {
  return messages.map((m, i) => ({
    id: `persisted-${i}`,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    tool: m.tool,
    toolInput: m.toolInput,
  }));
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  requestId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export type MessageGroup =
  | { type: "message"; message: ChatMessage }
  | { type: "tool_group"; messages: ChatMessage[] };

export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let toolBuf: ChatMessage[] = [];

  function flushTools() {
    if (toolBuf.length > 0) {
      groups.push({ type: "tool_group", messages: [...toolBuf] });
      toolBuf = [];
    }
  }

  for (const msg of messages) {
    if (msg.tool) {
      toolBuf.push(msg);
    } else {
      flushTools();
      groups.push({ type: "message", message: msg });
    }
  }
  flushTools();

  return groups;
}

export function reduceChat(
  messages: ChatMessage[],
  event: ServerMessage,
): ChatMessage[] {
  const next = [...messages];
  const reqId = "requestId" in event ? event.requestId : undefined;

  switch (event.type) {
    case "kernel:text": {
      let targetIdx = -1;

      if (reqId) {
        // With requestId: scan back to find matching assistant message,
        // but stop if we hit a tool message from the same request --
        // post-tool text should get its own bubble
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i];
          if (m.role === "assistant" && !m.tool && m.requestId === reqId) {
            targetIdx = i;
            break;
          }
          if (m.tool && m.requestId === reqId) {
            break;
          }
        }
      } else {
        // Without requestId: original behavior - only check last message
        const last = next[next.length - 1];
        if (last?.role === "assistant" && !last.tool) {
          targetIdx = next.length - 1;
        }
      }

      if (targetIdx >= 0) {
        const target = next[targetIdx];
        next[targetIdx] = { ...target, content: target.content + event.text };
      } else {
        next.push({
          id: newMsgId(),
          role: "assistant",
          content: event.text,
          requestId: reqId,
          timestamp: Date.now(),
        });
      }
      break;
    }
    case "kernel:tool_start": {
      next.push({
        id: newMsgId(),
        role: "system",
        content: `Using ${event.tool}...`,
        tool: event.tool,
        requestId: reqId,
        timestamp: Date.now(),
      });
      break;
    }
    case "kernel:tool_end": {
      // Find last tool message matching requestId
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i];
        if (m.tool && m.content.startsWith("Using ")) {
          if (!reqId || m.requestId === reqId) {
            next[i] = { ...m, content: `Used ${m.tool}`, toolInput: event.input };
            break;
          }
        }
      }
      break;
    }
    case "kernel:error": {
      next.push({
        id: newMsgId(),
        role: "system",
        content: event.message,
        requestId: reqId,
        timestamp: Date.now(),
      });
      break;
    }
    case "kernel:aborted": {
      // Mark any in-flight tool message as stopped so its spinner switches
      // to the check icon. Without this, "Using X..." stays forever (the
      // spinner is gated on that exact prefix in ChatPopover) because the
      // server never emits a kernel:tool_end after an abort.
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i];
        if (m.tool && m.content.startsWith("Using ")) {
          if (!reqId || m.requestId === reqId) {
            next[i] = { ...m, content: `Stopped ${m.tool}` };
          }
        }
      }
      next.push({
        id: newMsgId(),
        role: "system",
        content: "Stopped.",
        requestId: reqId,
        timestamp: Date.now(),
      });
      break;
    }
  }

  return next;
}
