import { createHash } from "node:crypto";
import type { AgentThreadEvent } from "@matrix-os/contracts";
import type { AiTokenUsage } from "../ai-analytics.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { CodingAgentProviderEventBatch } from "./provider-adapter.js";
import { parseCodexExecJsonLine } from "./codex-events.js";
import { completionEvents } from "./codex-terminal-events.js";

const MAX_BATCH_EVENTS = 100;

export function codexEventId(sessionId: string, byteOffset: number, index: number, generation?: string): string {
  const digest = createHash("sha256").update(`${sessionId}:${byteOffset}:${index}${generation ? `:${generation}` : ""}`)
    .digest("hex").slice(0, 32);
  return `evt_codex_${digest}`;
}

export type CodexEventCursor = { sessionId: string; offset: number; generation?: string; checkpoint?: false; recordEndOffset?: number };
type BatchStore = {
  ingestProviderEvents(principal: RequestPrincipal, threadId: string, batch: CodingAgentProviderEventBatch,
    cursor: CodexEventCursor): Promise<unknown>;
};

/** Batch complete native records. A checkpoint never points inside a native line.
 * If a large line needs several writes, earlier chunks remain replayable until
 * its last chunk commits the final byte offset. Deterministic IDs deduplicate
 * those chunks after either a failed write or a lost acknowledgement.
 */
export async function ingestCodexTranscript(input: {
  store: BatchStore;
  principal: RequestPrincipal;
  threadId: string;
  sessionId: string;
  offset: number;
  generation?: string;
  checkpoint?: boolean;
  occurredAt: string;
  bytes: Buffer;
  consumedBytes: number;
}): Promise<{ terminal: boolean; ready: boolean }> {
  let events: AgentThreadEvent[] = [];
  let providerThreadId: string | undefined;
  let observedThreadId: string | undefined;
  let tokenUsage: AiTokenUsage | undefined;
  let terminal = false;
  let ready = false;
  let absoluteOffset = input.offset;
  let batchOffset = input.offset;
  let hasRecords = false;

  async function write(batch: CodingAgentProviderEventBatch, offset: number, checkpoint: boolean, recordEndOffset?: number): Promise<void> {
    await input.store.ingestProviderEvents(input.principal, input.threadId, batch, {
      sessionId: input.sessionId, offset, generation: input.generation,
      ...(checkpoint ? {} : { checkpoint: false }),
      ...(recordEndOffset !== undefined ? { recordEndOffset } : {}),
    });
  }

  async function flush(): Promise<void> {
    if (!hasRecords || (!input.checkpoint && events.length === 0 && !providerThreadId)) return;
    await write({ events, ...(providerThreadId ? { providerThreadId } : {}), ...(tokenUsage ? { tokenUsage } : {}) },
      input.checkpoint ? batchOffset : input.offset, !!input.checkpoint);
    events = [];
    providerThreadId = undefined;
    tokenUsage = undefined;
    hasRecords = false;
  }

  let lineStart = 0;
  while (lineStart < input.consumedBytes) {
    const newline = input.bytes.indexOf(0x0a, lineStart);
    if (newline < 0 || newline >= input.consumedBytes) break;
    const line = input.bytes.subarray(lineStart, newline).toString("utf8").replace(/\r$/, "");
    let index = 0;
    const parsed = parseCodexExecJsonLine(line, {
      threadId: input.threadId,
      now: () => new Date(input.occurredAt),
      nextEventId: () => codexEventId(input.sessionId, absoluteOffset, index++, input.generation),
    });
    const lineEvents = [...parsed.events];
    if (parsed.outcome) {
      terminal = true;
      lineEvents.push(...completionEvents({ threadId: input.threadId, outcome: parsed.outcome,
        failureReason: parsed.failureReason, occurredAt: input.occurredAt,
        nextEventId: () => codexEventId(input.sessionId, absoluteOffset, index++, input.generation) }));
    }
    ready ||= lineEvents.length > 0 || !!parsed.providerThreadId || !!parsed.outcome;
    if (parsed.providerThreadId) {
      if (observedThreadId && observedThreadId !== parsed.providerThreadId) throw new Error("Codex provider conversation changed");
      observedThreadId = parsed.providerThreadId;
    }
    if (events.length + lineEvents.length > MAX_BATCH_EVENTS) await flush();
    const nextOffset = absoluteOffset + newline - lineStart + 1;
    if (lineEvents.length > MAX_BATCH_EVENTS) {
      for (let start = 0; start < lineEvents.length; start += MAX_BATCH_EVENTS) {
        const last = start + MAX_BATCH_EVENTS >= lineEvents.length;
        await write({ events: lineEvents.slice(start, start + MAX_BATCH_EVENTS),
          ...(start === 0 && parsed.providerThreadId ? { providerThreadId: parsed.providerThreadId } : {}),
          ...(last && parsed.outcome && parsed.tokenUsage ? { tokenUsage: parsed.tokenUsage } : {}),
        }, input.checkpoint && last ? nextOffset : input.offset, !!input.checkpoint && last,
        input.checkpoint && !last ? nextOffset : undefined);
      }
    } else {
      events.push(...lineEvents);
      providerThreadId ??= parsed.providerThreadId;
      if (parsed.outcome) tokenUsage = parsed.tokenUsage;
      batchOffset = nextOffset;
      hasRecords = true;
      // Preserve each turn's usage association even if several completed turns
      // are waiting in the same transcript read after a gateway restart.
      if (parsed.outcome) await flush();
    }
    absoluteOffset = nextOffset;
    lineStart = newline + 1;
  }
  await flush();
  return { terminal, ready };
}
