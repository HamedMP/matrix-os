import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { BotEvent, BotToolCapability } from "@matrix-os/contracts";

/** Leaves room for the event envelope inside the 16 KiB assistant delta bound. */
const MAX_DELTA_BYTES = 12 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Splits on UTF-8 boundaries so no chunk exceeds the byte bound or breaks a character. */
export function splitUtf8(text: string, maxBytes = MAX_DELTA_BYTES): string[] {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    // Continuation bytes are 0b10xxxxxx; back up so the chunk ends on a code point.
    while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    chunks.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks;
}

/**
 * Projects Pi agent events into ordered, bounded bot events. Model reasoning
 * (thinking deltas) and raw tool arguments are never forwarded.
 */
export function createEventProjector(options: {
  send(event: BotEvent): Promise<void>;
  capabilityForTool(toolName: string): BotToolCapability | undefined;
}): (event: AgentEvent) => Promise<void> {
  let seq = 0;
  const emit = (event: BotEvent["event"]) => options.send({ seq: seq++, event });
  return async (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      for (const chunk of splitUtf8(event.assistantMessageEvent.delta)) await emit({ type: "assistant_delta", text: chunk });
      return;
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const capability = options.capabilityForTool(event.toolName);
      if (!capability || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(event.toolCallId)) return;
      await emit({
        type: "tool_progress",
        toolCallId: event.toolCallId,
        capability,
        phase: event.type === "tool_execution_start" ? "started" : event.isError ? "failed" : "completed",
      });
    }
  };
}
