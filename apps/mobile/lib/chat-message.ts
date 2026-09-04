export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool?: string;
  timestamp: number;
}

let messageCounter = 0;

export function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}
