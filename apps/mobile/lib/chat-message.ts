export interface ToolCall {
  id: string;
  tool: string;
  content: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool?: string;
  timestamp: number;
  /** Tool calls the assistant made while producing this message, live turns only. */
  toolCalls?: ToolCall[];
  /** Wall-clock seconds the turn took, set once the turn finishes (live turns only). */
  elapsedSeconds?: number;
}

let messageCounter = 0;

export function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}
