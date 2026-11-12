import {
  MAX_USAGE_EVENTS,
  type UsageAgent,
  type UsageEvent,
  type UsageParseResult,
} from "./types.js";
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (v: unknown, fallback = "") =>
  typeof v === "string" && v.length <= 256 ? v : fallback;
/** Offset-qualified ISO 8601 only: exports validate it and PostgreSQL must be able to order it. */
const isoTime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export const usageTime = (v: unknown) => {
  const value = text(v);
  return isoTime.test(value) && Number.isFinite(Date.parse(value)) ? value : "";
};
function count(v: unknown): number {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 1e12)
    throw new RangeError("Invalid usage counter");
  return v;
}
export interface UsageParserState {
  session: string;
  model: string;
  firstSeen?: string;
  lastSeen?: string;
  usageRecords?: number;
  nativeTotals?: { input: number; cached: number; output: number };
  previous: { input: number; cached: number; output: number };
}
export function createUsageRecordParser(
  agent: UsageAgent,
  source: string,
  initial?: UsageParserState,
) {
  let session = initial?.session ?? source,
    model = initial?.model ?? "unknown";
  let nativeTotals = initial?.nativeTotals;
  let previous = initial?.previous ?? { input: 0, cached: 0, output: 0 };
  let firstSeen = initial?.firstSeen,
    lastSeen = initial?.lastSeen,
    usageRecords = initial?.usageRecords ?? 0;
  return {
    state(): UsageParserState {
      return {
        session,
        model,
        previous: { ...previous },
        firstSeen,
        lastSeen,
        usageRecords,
        nativeTotals,
      };
    },
    push(raw: unknown): UsageParseResult {
      const events: UsageEvent[] = [];
      let issues = 0;
      let r = obj(raw),
        p = obj(r.payload);
      const time = usageTime(r.timestamp);
      if (time) {
        if (!firstSeen || time < firstSeen) firstSeen = time;
        if (!lastSeen || time > lastSeen) lastSeen = time;
      }
      const m = obj(r.message);
      if (r.type === "session_meta") session = text(p.id, source);
      if (r.type === "turn_context") model = text(p.model, "unknown");
      if (agent === "claude" && r.type !== "assistant")
        return { events, issues };
      if (
        agent === "codex" &&
        r.type !== "token_usage_record" &&
        (r.type !== "event_msg" || p.type !== "token_count")
      )
        return { events, issues };
      try {
        const timestamp = time;
        if (!timestamp) throw new RangeError("Missing usage time");
        let event: UsageEvent;
        if (agent === "codex" && r.type === "token_usage_record") {
          const id = text(p.response_id),
            actualSession = text(p.thread_id, text(p.session_id, session)),
            u = obj(p.usage);
          if (
            !id ||
            typeof u.input_tokens !== "number" ||
            typeof u.output_tokens !== "number"
          )
            throw new RangeError("Missing native usage");
          const cachedInput = count(u.cached_input_tokens),
            cacheWrite = count(u.cache_write_input_tokens),
            input = count(u.input_tokens) - cachedInput - cacheWrite;
          if (input < 0) throw new RangeError("Invalid native cache counters");
          if (actualSession !== session) {
            session = actualSession;
            previous = { input: 0, cached: 0, output: 0 };
          }
          const native: UsageEvent = {
            id: `codex-response:${id}`,
            session: actualSession,
            agent,
            model,
            timestamp,
            input,
            cachedInput,
            cacheWrite,
            output: count(u.output_tokens),
            sourceKind: "response",
          };
          if (p.thread_token_usage) {
            const total = obj(p.thread_token_usage);
            nativeTotals = {
              input: count(total.input_tokens),
              cached: count(total.cached_input_tokens),
              output: count(total.output_tokens),
            };
            native.cumulative = { ...nativeTotals };
          } else nativeTotals = undefined;
          if (
            native.input +
              native.cachedInput +
              native.cacheWrite +
              native.output ===
            0
          )
            return { events, issues };
          usageRecords++;
          return { events: [native], issues };
        }

        if (agent === "claude") {
          if (!m.usage) {
            issues++;
            return { events, issues };
          }
          const u = obj(m.usage),
            sid = text(r.sessionId, session),
            mid = text(m.id),
            rid = text(r.requestId);
          if (!mid && !rid) {
            issues++;
            return { events, issues };
          }
          if (
            typeof u.input_tokens !== "number" ||
            typeof u.output_tokens !== "number"
          ) {
            issues++;
            return { events, issues };
          }
          if (m.stop_reason === null && count(u.output_tokens) === 0) {
            issues++;
            return { events, issues };
          }
          event = {
            id: mid ? `claude:${mid}` : `claude:${sid}:${rid}`,
            session: sid,
            agent,
            model: text(m.model, "unknown"),
            timestamp,
            input: count(u.input_tokens),
            cachedInput: count(u.cache_read_input_tokens),
            cacheWrite: count(u.cache_creation_input_tokens),
            output: count(u.output_tokens),
          };
          const cache = obj(u.cache_creation);
          if (u.cache_creation) {
            event.cacheWrite5m = count(cache.ephemeral_5m_input_tokens);
            event.cacheWrite1h = count(cache.ephemeral_1h_input_tokens);
          }
        } else {
          if (p.info === null) return { events, issues }; // Quota/status-only update has no request counters.
          const info = obj(p.info);
          if (!info.total_token_usage) {
            issues++;
            return { events, issues };
          }
          const u = obj(info.total_token_usage),
            next = {
              input: count(u.input_tokens),
              cached: count(u.cached_input_tokens),
              output: count(u.output_tokens),
            };
          if (
            nativeTotals &&
            next.input === nativeTotals.input &&
            next.cached === nativeTotals.cached &&
            next.output === nativeTotals.output
          ) {
            previous = next;
            return { events, issues };
          }

          if (
            next.cached > next.input ||
            next.input < previous.input ||
            next.cached < previous.cached ||
            next.output < previous.output
          ) {
            issues++;
            return { events, issues };
          }
          const input = next.input - previous.input,
            cached = next.cached - previous.cached,
            output = next.output - previous.output;
          if (input === 0 && cached === 0 && output === 0)
            return { events, issues };
          if (cached > input) {
            issues++;
            return { events, issues };
          }
          event = {
            id: `codex:${session}:${next.input}:${next.cached}:${next.output}`,
            session,
            agent,
            model,
            timestamp,
            input: input - cached,
            cachedInput: cached,
            cacheWrite: 0,
            output,
          };
          previous = next;
          event.cumulative = { ...next };
          event.sourceKind = "cumulative";
        }
        if (
          event.input + event.cachedInput + event.cacheWrite + event.output ===
          0
        )
          return { events, issues };
        usageRecords++;
        events.push(event);
      } catch (error: unknown) {
        if (!(error instanceof RangeError)) throw error;
        issues++;
      }
      return { events, issues };
    },
  };
}
export function parseUsageRecords(
  agent: UsageAgent,
  records: unknown[],
  source: string,
): UsageParseResult {
  const parser = createUsageRecordParser(agent, source);
  const events = new Map<string, UsageEvent>(); // Per-operation cap; released after parsing.
  let issues = 0;
  for (const raw of records) {
    const result = parser.push(raw);
    issues += result.issues;
    for (const event of result.events) {
      const old = events.get(event.id);
      if (
        old &&
        (event.input < old.input ||
          event.output < old.output ||
          event.cachedInput < old.cachedInput ||
          event.cacheWrite < old.cacheWrite)
      ) {
        issues++;
        continue;
      }
      if (events.size >= MAX_USAGE_EVENTS && !old) {
        issues++;
        break;
      }
      events.set(event.id, event);
    }
  }
  return { events: [...events.values()], issues };
}
export function mergeUsageEvents(input: UsageEvent[]) {
  const events = new Map<string, UsageEvent>(); // Bounded per operation, no retained registry.
  let conflicts = 0;
  for (const e of input) {
    const old = events.get(e.id);
    if (old) {
      if (JSON.stringify(old) !== JSON.stringify(e)) conflicts++;
      continue;
    }
    if (events.size >= MAX_USAGE_EVENTS)
      throw new RangeError("Usage event limit reached");
    events.set(e.id, e);
  }
  return { events: [...events.values()], conflicts };
}
