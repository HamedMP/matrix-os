import { readLocalChatJsonl } from "../local-chat-import/jsonl.js";
import { createUsageRecordParser, type UsageParserState } from "./parser.js";
import type { UsageAgent, UsageEvent } from "./types.js";
export interface UsageBatch {
  events: UsageEvent[];
  issues: number;
  offset: number;
  state: UsageParserState;
}
/** Bounded batches, unlimited aggregate history. Checkpoints stop before a live incomplete line. */
export async function* streamUsageSource(
  source: AsyncIterable<Uint8Array>,
  sourceId: string,
  options: {
    agent: UsageAgent;
    state?: UsageParserState;
    offset?: number;
    batchRecords?: number;
    signal?: AbortSignal;
  },
): AsyncGenerator<UsageBatch> {
  const limit = options.batchRecords ?? 256;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new RangeError("Invalid batch size");
  const parser = createUsageRecordParser(
    options.agent,
    sourceId,
    options.state,
  );
  const start = options.offset ?? 0;
  let offset = start,
    events: UsageEvent[] = [],
    issues = 0,
    records = 0;
  for await (const row of readLocalChatJsonl(source, {
    maxRecordBytes: 16 * 1024 * 1024,
  })) {
    options.signal?.throwIfAborted();
    if (row.kind === "issue") {
      if (row.code !== "empty_line") issues++;
    } else {
      const parsed = parser.push(row.value);
      events.push(...parsed.events);
      issues += parsed.issues;
    }
    if (row.kind !== "issue" || row.code !== "incomplete_final_line")
      offset = start + row.end;
    if (++records >= limit) {
      yield { events, issues, offset, state: parser.state() };
      events = [];
      issues = 0;
      records = 0;
    }
  }
  if (records) yield { events, issues, offset, state: parser.state() };
}
