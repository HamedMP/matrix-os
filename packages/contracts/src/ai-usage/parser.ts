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
function count(v: unknown): number {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 1e12)
    throw new RangeError("Invalid usage counter");
  return v;
}
export function parseUsageRecords(
  agent: UsageAgent,
  records: unknown[],
  source: string,
): UsageParseResult {
  const events = new Map<string, UsageEvent>(); // Per-file capacity; discarded after parsing.
  let issues = 0,
    session = source,
    model = "unknown";
  let previous = { input: 0, cached: 0, output: 0 };
  for (const raw of records) {
    const r = obj(raw),
      p = obj(r.payload),
      m = obj(r.message);
    if (r.type === "session_meta") session = text(p.id, source);
    if (r.type === "turn_context") model = text(p.model, "unknown");
    if (agent === "claude" && r.type !== "assistant") continue;
    if (
      agent === "codex" &&
      (r.type !== "event_msg" || p.type !== "token_count")
    )
      continue;
    try {
      const timestamp = text(r.timestamp);
      if (!timestamp || !Number.isFinite(Date.parse(timestamp)))
        throw new RangeError("Missing usage time");
      let event: UsageEvent;
      if (agent === "claude") {
        if (!m.usage) {
          issues++;
          continue;
        }
        const u = obj(m.usage),
          sid = text(r.sessionId, session),
          mid = text(m.id),
          rid = text(r.requestId);
        if (!mid && !rid) {
          issues++;
          continue;
        }
        if (
          typeof u.input_tokens !== "number" ||
          typeof u.output_tokens !== "number"
        ) {
          issues++;
          continue;
        }
        if (m.stop_reason === null && count(u.output_tokens) === 0) {
          issues++;
          continue;
        }
        event = {
          id: `claude:${sid}:${rid}:${mid}`,
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
        const old = events.get(event.id);
        if (old) {
          // Streaming mirrors carry cumulative response counters.
          if (
            event.input < old.input ||
            event.output < old.output ||
            event.cachedInput < old.cachedInput ||
            event.cacheWrite < old.cacheWrite
          ) {
            issues++;
            continue;
          }
        }
      } else {
        const info = obj(p.info);
        if (!info.total_token_usage) {
          issues++;
          continue;
        }
        const u = obj(info.total_token_usage),
          next = {
            input: count(u.input_tokens),
            cached: count(u.cached_input_tokens),
            output: count(u.output_tokens),
          };
        if (
          next.cached > next.input ||
          next.input < previous.input ||
          next.cached < previous.cached ||
          next.output < previous.output
        ) {
          issues++;
          continue;
        }
        const input = next.input - previous.input,
          cached = next.cached - previous.cached,
          output = next.output - previous.output;
        if (input === 0 && cached === 0 && output === 0) continue;
        if (cached > input) {
          issues++;
          continue;
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
      }
      if (
        event.input + event.cachedInput + event.cacheWrite + event.output ===
        0
      )
        continue;
      if (events.size >= MAX_USAGE_EVENTS && !events.has(event.id)) {
        issues++;
        break;
      }
      events.set(event.id, event);
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
      issues++;
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
