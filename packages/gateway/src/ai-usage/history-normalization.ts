import { sql, type OperationNodeSource } from "kysely";
/** Subtract the union of native counter intervals from each dated legacy interval.
 * PostgreSQL ranges bound transport memory and prevent overlapping mirrors from moving usage to a newer day.
 * Resets, missing endpoints and inconsistent categories stay incomplete; native actuals always survive. */
export function canonicalHistoryQuery(canonical: OperationNodeSource) {
  const remaining = (field: "input" | "cached" | "output") => {
    const end = sql.ref(`l.${field}`),
      start = sql.ref(`l.previous_${field}`),
      covered = sql.ref(`n.${field}`);
    return sql`(SELECT coalesce(sum(upper(r)-lower(r)),0) FROM unnest(
      (CASE WHEN ${end} >= ${start} THEN int8multirange(int8range(${start},${end},'[)')) ELSE '{}'::int8multirange END)
      - coalesce(${covered},'{}'::int8multirange)) AS r)`;
  };
  return sql`
    WITH canonical AS MATERIALIZED (${canonical}),
    native_values AS (
      SELECT event->>'session' AS session, event_id, event->>'timestamp' AS timestamp,
        (event->'cumulative'->>'input')::bigint AS input,
        (event->'cumulative'->>'cached')::bigint AS cached,
        (event->'cumulative'->>'output')::bigint AS output,
        (event->>'input')::bigint + (event->>'cachedInput')::bigint + (event->>'cacheWrite')::bigint AS actual_input,
        (event->>'cachedInput')::bigint AS actual_cached,
        (event->>'output')::bigint AS actual_output
      FROM canonical WHERE event->>'sourceKind'='response' AND event->>'agent'='codex'
    ),
    native_ordered AS (
      SELECT *, lag(input) OVER w AS prior_input, lag(cached) OVER w AS prior_cached, lag(output) OVER w AS prior_output
      FROM native_values WINDOW w AS (PARTITION BY session ORDER BY timestamp::timestamptz,event_id)
    ),
    native_ranges AS (
      SELECT session,
        range_agg(int8range(input-actual_input,input,'[)')) FILTER (WHERE input IS NOT NULL) AS input,
        range_agg(int8range(cached-actual_cached,cached,'[)')) FILTER (WHERE cached IS NOT NULL) AS cached,
        range_agg(int8range(output-actual_output,output,'[)')) FILTER (WHERE output IS NOT NULL) AS output,
        bool_or(input IS NULL OR input<actual_input OR cached<actual_cached OR output<actual_output
          OR coalesce(input-actual_input<prior_input OR cached-actual_cached<prior_cached OR output-actual_output<prior_output,false)) AS uncertain
      FROM native_ordered GROUP BY session
    ),
    legacy_values AS (
      SELECT event_id, event->>'session' AS session,
        (event->'cumulative'->>'input')::bigint AS input,
        (event->'cumulative'->>'cached')::bigint AS cached,
        (event->'cumulative'->>'output')::bigint AS output
      FROM canonical WHERE event->>'agent'='codex' AND event->>'sourceKind'='cumulative'
    ),
    legacy_intervals AS (
      SELECT *, coalesce(lag(input) OVER w,0) AS previous_input,
        coalesce(lag(cached) OVER w,0) AS previous_cached,
        coalesce(lag(output) OVER w,0) AS previous_output
      FROM legacy_values WINDOW w AS (PARTITION BY session ORDER BY input+output,input,cached,event_id)
    )
    SELECT c.event, n.session IS NOT NULL AS mixed,
      coalesce(n.uncertain,false) OR coalesce(l.input<l.previous_input OR l.cached<l.previous_cached OR l.output<l.previous_output,false) AS uncertain,
      ${remaining("input")} AS remaining_input,
      ${remaining("cached")} AS remaining_cached,
      ${remaining("output")} AS remaining_output
    FROM canonical c
    LEFT JOIN legacy_intervals l ON c.event_id=l.event_id
    LEFT JOIN native_ranges n ON l.session=n.session
    ORDER BY c.event->>'agent',c.event->>'session',c.event->>'timestamp',c.event_id
  `;
}
