import { sql, type Kysely, type RawBuilder } from "kysely";
import { AggregateInputSchema, ChatAnalyticsUnavailable } from "./contracts.js";

/** Same positive saved-history boundary, expressed as a bounded relational filter. */
export const ordinaryGenerationFilter = () => sql<boolean>`EXISTS (SELECT 1 FROM chats c
  JOIN google_model_history_births b ON b.chat_id=c.id AND b.owner_id=c.owner_id AND b.owner_type=c.owner_type
  JOIN chat_runs r ON r.chat_id=c.id AND r.id=g.run_id
  WHERE c.id=g.chat_id AND c.owner_id=g.owner_id AND c.owner_type='personal' AND c.lifecycle='active'
    AND c.collaboration IS NULL AND r.status IN ('accepted','running','waiting_for_approval','waiting_for_input','completed')
    AND (r.outcome IS NULL OR r.outcome='completed')
    AND NOT EXISTS(SELECT 1 FROM google_context_markers m WHERE m.owner_id=c.owner_id AND m.chat_id=c.id))`;

const dimensions: Record<string, RawBuilder<unknown>> = {
  taskFamily: sql`g.task_family`, taskType: sql`g.task_type`, complexity: sql`g.complexity`,
  modelId: sql`g.facts->>'modelId'`, harness: sql`g.facts->>'harness'`, accessSource: sql`g.facts->>'accessSource'`,
};
function number(value: unknown): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) throw new ChatAnalyticsUnavailable();
  return parsed;
}
export async function aggregateChatAnalytics<DB>(db: Kysely<DB>, input: unknown, now: Date) {
  const query = AggregateInputSchema.parse(input);
  const selected = query.groupBy.map((name, index) => sql`${dimensions[name]} AS ${sql.id(`d${index}`)}`);
  const rows = (await sql<Record<string, unknown>>`SELECT ${sql.join(selected)}, count(*)::int AS generations,
    count(*) FILTER(WHERE g.classified_at IS NOT NULL)::int AS classified,
    count(*) FILTER(WHERE g.sampled)::int AS sampled,
    sum((g.facts->>'inputTokens')::numeric) AS input_tokens, sum((g.facts->>'outputTokens')::numeric) AS output_tokens,
    sum((g.facts->>'cachedInputTokens')::numeric) AS cached_input_tokens, sum((g.facts->>'costUsd')::numeric) AS cost_usd,
    avg((g.facts->>'latencyMs')::numeric) AS latency_ms_mean,
    count(*) FILTER(WHERE g.facts->>'inputTokens' IS NULL)::int AS unknown_input,
    count(*) FILTER(WHERE g.facts->>'outputTokens' IS NULL)::int AS unknown_output,
    count(*) FILTER(WHERE g.facts->>'cachedInputTokens' IS NULL)::int AS unknown_cached,
    count(*) FILTER(WHERE g.facts->>'costUsd' IS NULL)::int AS unknown_cost,
    count(*) FILTER(WHERE g.facts->>'latencyMs' IS NULL)::int AS unknown_latency,
    min(g.sample_rate_bp) AS sample_rate_min, max(g.sample_rate_bp) AS sample_rate_max
    FROM chat_analytics_generations g WHERE g.owner_id=${query.ownerId}
      AND g.completed_at>=${query.from}::timestamptz AND g.completed_at<${query.to}::timestamptz
      AND g.expires_at>${now} AND ${ordinaryGenerationFilter()}
      AND ${query.includeUnclassified ? sql`true` : sql`g.classified_at IS NOT NULL`}
    GROUP BY ${sql.join(query.groupBy.map(name => dimensions[name]))}
    ORDER BY generations DESC LIMIT ${query.limit}`.execute(db)).rows;
  return rows.map(row => ({
    dimensions: Object.fromEntries(query.groupBy.map((name, index) => [name, row[`d${index}`] ?? null])),
    generations: number(row.generations)!, classified: number(row.classified)!, sampled: number(row.sampled)!,
    inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens), cachedInputTokens: number(row.cached_input_tokens),
    costUsd: number(row.cost_usd), latencyMsMean: number(row.latency_ms_mean),
    unknownInputTokenGenerations: number(row.unknown_input)!, unknownOutputTokenGenerations: number(row.unknown_output)!,
    unknownCachedInputTokenGenerations: number(row.unknown_cached)!, unknownCostGenerations: number(row.unknown_cost)!,
    unknownLatencyGenerations: number(row.unknown_latency)!, samplingRateBpsMin: number(row.sample_rate_min)!, samplingRateBpsMax: number(row.sample_rate_max)!,
  }));
}
