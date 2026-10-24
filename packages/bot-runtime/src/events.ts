import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { BOT_OUTPUT_MAX_ENCODED_BYTES, BOT_OUTPUT_LIMIT_NOTICE, botOutputEncodedBytes, botOutputPrefix,
  botToolDisplayInput, botToolDisplayOutput, botToolDisplayMcpResult, type BotToolDisplay, type BotEvent, type BotToolCapability } from "@matrix-os/contracts";
import { bridgeToolCallId } from "./tool-call-id.js";

/** Leaves room for the event envelope inside the 16 KiB assistant delta bound. */
const MAX_DELTA_BYTES = 12 * 1024;
/** Small deltas are combined, so a chatty stream costs a few broker requests per second. */
const DELTA_FLUSH_INTERVAL_MS = 250;
const MAX_TOOLS = 60;
export const LIVE_TEXT_EVENTS = 1_600;
const BATCHED_FLUSH_INTERVAL_MS = 1_000;
const BATCHED_LABEL = "Live text updates refresh once per second. Tool progress continues.";
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
 * (thinking deltas) and raw tool argument/result objects are never forwarded. Selected display
 * snapshots cross only the private broker; the gateway seals them before Chat. Text deltas
 * are buffered and sent within 250 ms (a timer covers pauses in the stream),
 * when the buffer fills, or at a message or tool boundary. Every send goes
 * through one serial chain, so events leave in `seq` order. Chatty text
 * switches to a one-second refresh. Total encoded text is bounded independently
 * of the number of updates; a long turn cannot spend future tool progress slots.
 * Canonical Chat retains the same bounded output using continuation messages.
 */
export function createEventProjector(options: {
  send(event: BotEvent): Promise<void>;
  capabilityForTool(toolName: string): BotToolCapability | undefined;
  now?(): number;
  signal?: AbortSignal;
}): EventProjector {
  const now = options.now ?? Date.now;
  let seq = 0;
  let buffered = "";
  let bufferedBytes = 0;
  let lastFlushAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let failure: unknown;
  let textEvents = 0;
  let outputBytes = 0;
  let previewPaused = false;
  // At most the run action budget; terminal events evict immediately.
  const tools = new Map<string, { display: BotToolDisplay; privateContext: boolean; updates: number; lastUpdate: number }>();
  let toolStarts = 0;

  const emit = async (event: BotEvent["event"]) => {
    await options.send({ seq: seq++, event });
  };
  const emitText = async (text: string) => {
    textEvents += 1;
    await emit({ type: "assistant_delta", text });
    if (textEvents === LIVE_TEXT_EVENTS) {
      await emit({ type: "activity", label: BATCHED_LABEL, state: "completed" });
    }
  };
  const flushInterval = () => textEvents < LIVE_TEXT_EVENTS ? DELTA_FLUSH_INTERVAL_MS : BATCHED_FLUSH_INTERVAL_MS;
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
    for (const chunk of splitUtf8(text)) await emitText(chunk);
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
    }, Math.max(0, flushInterval() - (now() - lastFlushAt)));
    timer.unref?.();
  };

  const project = async (event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (previewPaused) return;
      const delta = event.assistantMessageEvent.delta;
      const retained = botOutputPrefix(delta, BOT_OUTPUT_MAX_ENCODED_BYTES - outputBytes);
      outputBytes += botOutputEncodedBytes(retained);
      // Even control characters fit the encoded event envelope. The SDK awaits
      // this listener, and every full buffer waits for its broker send.
      for (const chunk of splitUtf8(retained, 2 * 1024)) {
        const bytes = botOutputEncodedBytes(chunk);
        if (bufferedBytes + bytes > MAX_DELTA_BYTES) await serial(flush);
        buffered += chunk;
        bufferedBytes += bytes;
      }
      if (bufferedBytes >= MAX_DELTA_BYTES || now() - lastFlushAt >= flushInterval()) {
        await serial(flush);
      } else {
        schedule();
      }
      if (retained.length < delta.length) {
        await serial(async () => {
          await flush();
          previewPaused = true;
          await emit({ type: "activity", label: BOT_OUTPUT_LIMIT_NOTICE.trim(), state: "completed" });
        });
      }
      return;
    }
    if (event.type === "message_end" || event.type === "agent_end") {
      await serial(flush);
      return;
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const capability = options.capabilityForTool(event.toolName);
      await serial(async () => {
        await flush();
        if (!capability) return;
        const id = bridgeToolCallId(event.toolCallId);
        if (event.type === "tool_execution_start") {
          if (tools.has(id) || toolStarts >= MAX_TOOLS) return;
          toolStarts += 1;
          tools.set(id, { ...botToolDisplayInput(event.toolName, event.args), updates: 0, lastUpdate: -Infinity });
        }
        const tool = tools.get(id);
        if (!tool) return;
        if (event.type === "tool_execution_update") {
          if (tool.updates >= 3 || now() - tool.lastUpdate < DELTA_FLUSH_INTERVAL_MS) return;
          tool.updates += 1;
          tool.lastUpdate = now();
        }
        const rawResult = event.type === "tool_execution_end" ? event.result : event.type === "tool_execution_update" ? event.partialResult : undefined;
        const result = capability === "mcp.call" ? botToolDisplayMcpResult(rawResult) : { value: rawResult, isError: false };
        const output = event.type === "tool_execution_start" ? {} : botToolDisplayOutput(result.value, tool.privateContext);
        if (event.type === "tool_execution_update" && tool.updates === 3) {
          output.output = `${output.output?.slice(0, 2900)}\n\nLive updates paused until this tool finishes.`;
          output.truncated = true;
        }
        const display = { ...tool.display, ...output };
        if (event.type === "tool_execution_end") tools.delete(id);
        await emit({ type: "tool_progress", toolCallId: id, capability,
          phase: event.type === "tool_execution_start" ? "started" : event.type === "tool_execution_update" ? "updated"
            : options.signal?.aborted ? "cancelled" : event.isError || result.isError ? "failed" : "completed", display });
      });
    }
  };
  return Object.assign(project, {
    drain: () => serial(flush),
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      tools.clear();
    },
  });
}
