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

export interface EventProjector {
  (event: AgentEvent): Promise<void>;
  /** Sends any buffered text and waits for every queued send; rethrows a failed send. */
  drain(): Promise<void>;
  /** Stops the flush timer. */
  close(): void;
}

/**
 * Projects Pi agent events into ordered, bounded bot events. Model reasoning
 * (thinking deltas) and raw tool arguments are never forwarded. Text deltas
 * are buffered and sent within 250 ms (a timer covers pauses in the stream),
 * when the buffer fills, or at a message or tool boundary. Every send goes
 * through one serial chain, so events leave in `seq` order. After
 * MAX_EVENTS_PER_TURN events the projector sends one activity notice and
 * stops forwarding for the rest of the turn.
 */
export function createEventProjector(options: {
  send(event: BotEvent): Promise<void>;
  capabilityForTool(toolName: string): BotToolCapability | undefined;
  now?(): number;
}): EventProjector {
  const now = options.now ?? Date.now;
  let seq = 0;
  let buffered = "";
  let bufferedBytes = 0;
  let lastFlushAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let failure: unknown;

  const emit = async (event: BotEvent["event"]) => {
    if (seq >= MAX_EVENTS_PER_TURN) return;
    if (seq === MAX_EVENTS_PER_TURN - 1) {
      await options.send({ seq: seq++, event: { type: "activity", label: PAUSED_LABEL, state: "started" } });
      return;
    }
    await options.send({ seq: seq++, event });
  };
  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    lastFlushAt = now();
    if (buffered.length === 0) return;
    const text = buffered;
    buffered = "";
    bufferedBytes = 0;
    for (const chunk of splitUtf8(text)) await emit({ type: "assistant_delta", text: chunk });
  };
  /** Runs sends one at a time; the first failure is kept and rethrown to the next caller. */
  const serial = (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(() => {
      if (failure !== undefined) throw failure;
      return task();
    });
    chain = next.catch((error: unknown) => {
      failure ??= error;
    });
    return next;
  };
  const schedule = () => {
    if (timer || buffered.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      // The failure is also kept by `serial` and surfaces on the next event or on drain.
      void serial(flush).catch((error: unknown) => {
        console.warn("[bot-runtime] timed event flush failed:", error instanceof Error ? error.name : "UnknownError");
      });
    }, Math.max(0, DELTA_FLUSH_INTERVAL_MS - (now() - lastFlushAt)));
    timer.unref?.();
  };

  const project = async (event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      buffered += event.assistantMessageEvent.delta;
      bufferedBytes += encoder.encode(event.assistantMessageEvent.delta).byteLength;
      if (bufferedBytes >= MAX_DELTA_BYTES || now() - lastFlushAt >= DELTA_FLUSH_INTERVAL_MS) {
        await serial(flush);
      } else {
        schedule();
      }
      return;
    }
    if (event.type === "message_end" || event.type === "agent_end") {
      await serial(flush);
      return;
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const capability = options.capabilityForTool(event.toolName);
      const validCallId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(event.toolCallId);
      await serial(async () => {
        await flush();
        if (!capability || !validCallId) return;
        await emit({
          type: "tool_progress",
          toolCallId: event.toolCallId,
          capability,
          phase: event.type === "tool_execution_start" ? "started" : event.isError ? "failed" : "completed",
        });
      });
    }
  };
  return Object.assign(project, {
    drain: () => serial(flush),
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  });
}
