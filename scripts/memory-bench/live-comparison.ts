import { z } from "zod/v4";
import { MEMORY_ENGINES } from "../../packages/contracts/src/memory-workspace.js";
export const LiveBenchmarkCasesSchema = z
  .array(
    z
      .object({
        query: z.string().trim().min(1).max(2000),
        relevantSourceIds: z.array(z.string().min(1).max(128)).max(30),
      })
      .strict(),
  )
  .min(1)
  .max(200);
export type LiveCase = z.infer<typeof LiveBenchmarkCasesSchema>[number];
export interface LiveResult {
  query: string;
  results: Array<{
    engine: string;
    status: string;
    latencyMs: number;
    hits: Array<{ sourceId: string }>;
  }>;
}
/** Scores retrieval against owner-reviewed labels. Availability is measured separately from quality. */
export function scoreLiveComparison(
  cases: LiveCase[],
  observations: LiveResult[],
) {
  return Object.fromEntries(
    MEMORY_ENGINES.map((engine) => {
      let ready = 0,
        recall = 0,
        precision = 0,
        mrr = 0,
        evidenceQueries = 0,
        falsePositiveQueries = 0;
      const latencies: number[] = [];
      cases.forEach((test, index) => {
        const result =
          observations[index]?.query === test.query
            ? observations[index].results.find((r) => r.engine === engine)
            : undefined;
        if (result?.status !== "ready") return;
        ready++;
        latencies.push(result.latencyMs);
        const ids = [...new Set(result.hits.map((hit) => hit.sourceId))];
        const expected = new Set(test.relevantSourceIds);
        if (!expected.size) {
          if (ids.length) falsePositiveQueries++;
          return;
        }
        evidenceQueries++;
        const relevant = ids.filter((id) => expected.has(id)).length;
        recall += relevant / expected.size;
        precision += ids.length ? relevant / ids.length : 0;
        const rank = ids.findIndex((id) => expected.has(id));
        mrr += rank < 0 ? 0 : 1 / (rank + 1);
      });
      latencies.sort((a, b) => a - b);
      return [
        engine,
        {
          availability: ready / cases.length,
          recall: evidenceQueries ? recall / evidenceQueries : null,
          precision: evidenceQueries ? precision / evidenceQueries : null,
          mrr: evidenceQueries ? mrr / evidenceQueries : null,
          falsePositiveQueries,
          p50Ms: latencies.length
            ? latencies[Math.floor((latencies.length - 1) * 0.5)]
            : null,
          p95Ms: latencies.length
            ? latencies[Math.ceil((latencies.length - 1) * 0.95)]
            : null,
          queries: cases.length,
          readyQueries: ready,
        },
      ];
    }),
  );
}
