import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { BotEvent, BotToolCapability } from "@matrix-os/contracts";

/** Leaves room for the event envelope inside the 16 KiB assistant delta bound. */
const MAX_DELTA_BYTES = 12 * 1024;
/** Small deltas are combined, so a chatty stream costs a few broker requests per second. */
const DELTA_FLUSH_INTERVAL_MS = 250;
/** Per-turn cap on forwarded events; the saved transcript still holds the full reply. */
export const MAX_EVENTS_PER_TURN = 2_000;
const PAUSED_LABEL = "Live updates paused. The full reply appears when this step finishes.";
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
 * (thinking deltas) and raw tool arguments are never forwarded. Text deltas
 * are buffered and sent at most every 250 ms, when the buffer fills, or at a
 * message or tool boundary. After MAX_EVENTS_PER_TURN events the projector
 * sends one activity notice and stops forwarding for the rest of the turn.
 */
export function createEventProjector(options: {
  send(event: BotEvent): Promise<void>;
  capabilityForTool(toolName: string): BotToolCapability | undefined;
  now?(): number;
}): (event: AgentEvent) => Promise<void> {
  const now = options.now ?? Date.now;
  let seq = 0;
  let buffered = "";
  let bufferedBytes = 0;
  let lastFlushAt = now();
  const emit = async (event: BotEvent["event"]) => {
    if (seq >= MAX_EVENTS_PER_TURN) return;
    if (seq === MAX_EVENTS_PER_TURN - 1) {
      await options.send({ seq: seq++, event: { type: "activity", label: PAUSED_LABEL, state: "started" } });
      return;
    }
    await options.send({ seq: seq++, event });
  };
  const flush = async () => {
    lastFlushAt = now();
    if (buffered.length === 0) return;
    const text = buffered;
    buffered = "";
    bufferedBytes = 0;
    for (const chunk of splitUtf8(text)) await emit({ type: "assistant_delta", text: chunk });
  };
  return async (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      buffered += event.assistantMessageEvent.delta;
      bufferedBytes += encoder.encode(event.assistantMessageEvent.delta).byteLength;
      if (bufferedBytes >= MAX_DELTA_BYTES || now() - lastFlushAt >= DELTA_FLUSH_INTERVAL_MS) await flush();
      return;
    }
    if (event.type === "message_end" || event.type === "agent_end") {
      await flush();
      return;
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      await flush();
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
