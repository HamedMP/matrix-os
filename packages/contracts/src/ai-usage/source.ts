import { z } from "zod/v4";
import { readLocalChatJsonl } from "../local-chat-import/jsonl.js";
import { parseUsageRecords } from "./parser.js";
import { MAX_USAGE_EVENTS, MAX_USAGE_FILE_BYTES } from "./types.js";
const count = z.number().int().min(0).max(1e12);
const eventSchema = z.object({
  id: z.string().min(1).max(1024),
  session: z.string().min(1).max(256),
  agent: z.enum(["claude", "codex"]),
  model: z.string().min(1).max(256),
  timestamp: z.iso.datetime({ offset: true }),
  input: count,
  cachedInput: count,
  cacheWrite: count,
  output: count,
  cacheWrite5m: count.optional(),
  cacheWrite1h: count.optional(),
});
export const UsageExportSchema = z.object({
  version: z.literal(1),
  events: z.array(eventSchema).max(MAX_USAGE_EVENTS),
  issues: z.number().int().nonnegative().max(1e9).default(0),
});
export function readUsageExport(value: unknown) {
  return UsageExportSchema.parse(value);
}
/** Original transcript text is discarded immediately; only usage-bearing metadata survives. */
export async function readUsageSource(
  source: AsyncIterable<Uint8Array>,
  sourceId: string,
  signal?: AbortSignal,
) {
  let bytes = 0,
    issues = 0,
    agent: "claude" | "codex" | undefined;
  const records: unknown[] = [];
  async function* bounded() {
    for await (const chunk of source) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > MAX_USAGE_FILE_BYTES)
        throw new RangeError("Usage file too large");
      yield chunk;
    }
  }
  for await (const row of readLocalChatJsonl(bounded(), {
    maxRecordBytes: 4 * 1024 * 1024,
  })) {
    if (row.kind === "issue") {
      if (row.code !== "empty_line") issues++;
      continue;
    }
    const r = row.value;
    if (r.type === "assistant") {
      agent ??= "claude";
      const m =
        r.message && typeof r.message === "object"
          ? (r.message as Record<string, unknown>)
          : {};
      records.push({
        type: r.type,
        timestamp: r.timestamp,
        sessionId: r.sessionId,
        requestId: r.requestId,
        message: {
          id: m.id,
          model: m.model,
          usage: m.usage,
          stop_reason: m.stop_reason,
        },
      });
    } else if (
      ["session_meta", "turn_context", "event_msg"].includes(String(r.type))
    ) {
      const p =
        r.payload && typeof r.payload === "object"
          ? (r.payload as Record<string, unknown>)
          : {};
      if (r.type === "event_msg" && p.type !== "token_count") continue;
      agent ??= "codex";
      records.push({
        type: r.type,
        timestamp: r.timestamp,
        payload: { id: p.id, model: p.model, type: p.type, info: p.info },
      });
    }
    if (records.length > MAX_USAGE_EVENTS * 2)
      throw new RangeError("Usage record limit reached");
  }
  if (!agent) return { events: [], issues: issues + 1 };
  const result = parseUsageRecords(agent, records, sourceId);
  return { events: result.events, issues: result.issues + issues };
}
