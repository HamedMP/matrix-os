// Ported from shell/src/lib/chat.ts (spec 094 R4); keep semantics in sync.
// Reducer rule (CLAUDE.md): never mutate -- always new objects; in-place
// mutation causes streaming text duplication.

export type ChatEvent =
  | { type: "kernel:init"; sessionId: string; requestId?: string }
  | { type: "kernel:text"; text: string; requestId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string }
  | { type: "kernel:result"; data?: unknown; requestId?: string }
  | { type: "kernel:error"; message: string; requestId?: string }
  | { type: "kernel:aborted"; requestId?: string };

let msgSeq = 0;
function newMsgId(): string {
  msgSeq = (msgSeq + 1) & 0xffff;
  return `msg-${Date.now()}-${msgSeq}`;
}

const SAFE_KERNEL_ERROR_MESSAGE = "Something went wrong. Please try again.";
const MAX_KERNEL_ERROR_CHARS = 180;
const UNSAFE_KERNEL_ERROR_PATTERN =
  /(?:\/home\/|\/tmp\/|node_modules|packages\/|desktop\/src|Error:|Exception|stack trace|postgres|database|anthropic|openai|claude|ENOENT|EACCES)/i;

function safeKernelErrorMessage(message: string): string {
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_KERNEL_ERROR_CHARS ||
    UNSAFE_KERNEL_ERROR_PATTERN.test(trimmed)
  ) {
    return SAFE_KERNEL_ERROR_MESSAGE;
  }
  return trimmed;
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

export function reduceChat(messages: ChatMessage[], event: ChatEvent): ChatMessage[] {
  const next = [...messages];
  const reqId = event.requestId;

  switch (event.type) {
    case "kernel:text": {
      let targetIdx = -1;

      if (reqId) {
        // With requestId: scan back to find matching assistant message,
        // but stop if we hit a tool message from the same request --
        // post-tool text should get its own bubble
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i]!;
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
        const target = next[targetIdx]!;
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
        const m = next[i]!;
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
        content: safeKernelErrorMessage(event.message),
        requestId: reqId,
        timestamp: Date.now(),
      });
      break;
    }
    case "kernel:aborted": {
      // Mark any in-flight tool message as stopped so its spinner switches
      // to the check icon -- the server never emits kernel:tool_end after
      // an abort.
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i]!;
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
