import type { ExpectedQuery, telemetrySchema } from "./contracts.js";
import type { z } from "zod/v4";

export function scoreQuery(expected: ExpectedQuery, ids: string[], status: string, requestedK = expected.relevant.length) {
  const relevant = expected.relevant;
  const matched = ids.filter((id) => relevant.includes(id));
  const first = ids.findIndex((id) => relevant.includes(id));
  const dcg = ids.slice(0, requestedK).reduce((sum, id, i) => sum + (relevant.includes(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = relevant.slice(0, requestedK).reduce((sum, _, i) => sum + 1 / Math.log2(i + 2), 0);
  return {
    recall: relevant.length ? matched.length / relevant.length : null,
    precision: ids.length ? matched.length / ids.length : relevant.length ? 0 : null,
    mrr: relevant.length ? first < 0 ? 0 : 1 / (first + 1) : null,
    ndcg: relevant.length ? ideal ? dcg / ideal : 0 : null,
    complete: matched.length === relevant.length && status === expected.status,
    statusCorrect: status === expected.status,
  };
}
export type QueryScore = ReturnType<typeof scoreQuery> & { violations: string[]; group: string };
export interface Operation { latencyMs: number; costUsd: number | null; error?: string; kind?: string; calls?: number; telemetry?: z.infer<typeof telemetrySchema> }
export interface AdmissionScore { expectedRetain: boolean; retained: boolean; placementCorrect: boolean; group: string; sourceId?: string; path?: string; expectedPlacements?: string[]; placements?: string[]; violations?: string[] }
const mean = (xs: Array<number | null>) => { const measured = xs.filter((x): x is number => x !== null); return measured.length ? measured.reduce((s, x) => s + x, 0) / measured.length : null; };
const ratio = (n: number, d: number) => d ? n / d : null;
export function percentile(xs: number[], p: number) { const sorted = [...xs].sort((a, b) => a - b); return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null; }
export function summarize(queries: QueryScore[], operations: Operation[], admissions: AdmissionScore[]) {
  const retained = admissions.filter((a) => a.retained);
  const expected = admissions.filter((a) => a.expectedRetain);
  const truePositive = retained.filter((a) => a.expectedRetain).length;
  const costs = operations.map((o) => o.costUsd);
  const retrievals = operations.filter((o) => o.kind === "query");
  return {
    queryCount: queries.length, admissionCount: admissions.length,
    recall: mean(queries.map((q) => q.recall)), precision: mean(queries.map((q) => q.precision)),
    mrr: mean(queries.map((q) => q.mrr)), ndcg: mean(queries.map((q) => q.ndcg)),
    completeRate: ratio(queries.filter((q) => q.complete).length, queries.length),
    statusAccuracy: ratio(queries.filter((q) => q.statusCorrect).length, queries.length),
    admissionPrecision: ratio(truePositive, retained.length), admissionRecall: ratio(truePositive, expected.length),
    placementAccuracy: ratio(expected.filter((a) => a.retained && a.placementCorrect).length, expected.length),
    hardFailures: queries.reduce((s, q) => s + q.violations.length, 0) + admissions.reduce((s, a) => s + (a.violations?.length ?? 0), 0),
    operationErrors: operations.filter((o) => o.error).length,
    p50Ms: percentile(operations.map((o) => o.latencyMs), 0.5), p95Ms: percentile(operations.map((o) => o.latencyMs), 0.95),
    retrievalP50Ms: percentile(retrievals.map((o) => o.latencyMs), 0.5), retrievalP95Ms: percentile(retrievals.map((o) => o.latencyMs), 0.95),
    costUsd: costs.length && costs.every((x) => x !== null) ? costs.reduce<number>((s, x) => s + x!, 0) : null,
    reportedCalls: operations.reduce((s, o) => s + (o.calls ?? 0), 0),
  };
}
