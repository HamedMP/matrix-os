import { z } from "zod/v4";
import type { UsageHistory } from "./history-report.js";
import { readLocalChatJsonl } from "../local-chat-import/jsonl.js";
import { parseUsageRecords } from "./parser.js";
import { MAX_USAGE_EVENTS, MAX_USAGE_FILE_BYTES } from "./types.js";
const count = z.number().int().min(0).max(1e12);
export const usageEventSchema = z.object({
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
  sourceKind: z.enum(["response", "cumulative"]).optional(),
  cumulative: z
    .object({ input: count, cached: count, output: count })
    .optional(),
});
const sum = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const totalsSchema = z.object({
  tokens: sum,
  input: sum,
  cachedInput: sum,
  cacheWrite: sum,
  output: sum,
  requests: sum,
  estimatedUsd: sum.nullable(),
  unpriced: sum,
});
export const historySchema = z.object({
  timeZone: z.string().max(80).optional(),
  reports: z
    .array(
      z.object({
        id: z.string().max(40),
        label: z.string().max(80),
        agent: z.enum(["", "claude", "codex"]),
        endDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        days: z.number().int().min(1).max(20000),
        summary: totalsSchema.extend({
          sessions: sum,
          activeDays: sum,
          daily: z
            .array(
              totalsSchema.extend({
                day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              }),
            )
            .max(20000),
          models: z
            .array(
              totalsSchema.extend({
                agent: z.enum(["claude", "codex"]),
                model: z.string().max(256),
              }),
            )
            .max(10000),
        }),
      }),
    )
    .max(1000),
  coverage: z.object({
    machines: z.array(z.string().max(80)).max(128),
    files: sum,
    bytes: sum,
    indexedBytes: sum,
    oldest: z.string().nullable(),
    newest: z.string().nullable(),
    issues: sum,
    failedRoots: sum,
    indexedAt: z.iso.datetime({ offset: true }),
    indexing: z.boolean().optional(),
    oldestActivity: z.string().nullable().optional(),
    activityOnlySessions: sum.optional(),
    backup: z
      .object({
        verifiedFiles: sum,
        verifiedBytes: sum,
        verifiedAt: z.iso.datetime({ offset: true }),
      })
      .optional(),
    preservedAgents: z.array(z.string().max(80)).max(100).optional(),
    webHistory: z
      .object({
        provider: z.string().max(80),
        conversations: sum,
        messages: sum,
        first: z.string().nullable(),
        last: z.string().nullable(),
        years: z
          .array(
            z.object({
              year: z.string().regex(/^\d{4}$/),
              conversations: sum,
              messages: sum,
            }),
          )
          .max(200),
        tokenCountersAvailable: z.literal(false),
      })
      .optional(),
    legacyActivity: z
      .object({
        firstDay: z.string().max(10),
        lastDay: z.string().max(10),
        days: sum,
        sessions: sum,
        label: z.string().max(200),
      })
      .optional(),
  }),
}) satisfies z.ZodType<UsageHistory>;
export const UsageExportSchema = z.object({
  version: z.literal(1),
  events: z.array(usageEventSchema).max(MAX_USAGE_EVENTS),
  issues: z.number().int().nonnegative().max(1e9).default(0),
  history: historySchema.optional(),
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
      [
        "session_meta",
        "turn_context",
        "event_msg",
        "token_usage_record",
      ].includes(String(r.type))
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
        payload: {
          id: p.id,
          model: p.model,
          type: p.type,
          info: p.info,
          thread_id: p.thread_id,
          session_id: p.session_id,
          response_id: p.response_id,
          usage: p.usage,
          thread_token_usage: p.thread_token_usage,
        },
      });
    }
    if (records.length > MAX_USAGE_EVENTS * 2)
      throw new RangeError("Usage record limit reached");
  }
  if (!agent) return { events: [], issues: issues + 1 };
  const result = parseUsageRecords(agent, records, sourceId);
  return { events: result.events, issues: result.issues + issues };
}
