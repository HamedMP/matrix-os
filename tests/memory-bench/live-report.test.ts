import { describe, expect, it } from "vitest";
import { buildLiveReport } from "../../scripts/memory-bench/live.js";
import { scoreLiveComparison } from "../../scripts/memory-bench/live-comparison.js";

describe("restricted live benchmark score audit", () => {
  it("retains ranked observed IDs, status and timing so every score can be recomputed", () => {
    const labels = [{ query: "Synthetic query", relevantSourceIds: ["relevant"] }];
    const observations = [{ query: "Synthetic query", results: [{ engine: "hindsight", status: "ready", latencyMs: 2, hits: [{ sourceId: "wrong", text: "private body omitted" }, { sourceId: "relevant", text: "another private body omitted" }], providerDebug: "private provider error omitted" }, { engine: "openviking", status: "unavailable", latencyMs: 4, hits: [] }] }];
    const report = buildLiveReport(labels, observations);
    expect(report.observations[0].results[0].hits).toEqual([{ sourceId: "wrong" }, { sourceId: "relevant" }]);
    expect(scoreLiveComparison(report.labels, report.observations)).toEqual(report.metrics);
    expect(JSON.stringify(report)).not.toContain("private body");
    expect(JSON.stringify(report)).not.toContain("provider error");
    expect(report.metrics.hindsight.mrr).toBe(0.5);
  });
  it("rejects unbounded observations instead of silently removing scored hits", () => {
    const labels = [{ query: "Synthetic query", relevantSourceIds: ["relevant"] }];
    expect(() => buildLiveReport(labels, [{ query: labels[0].query, results: [{ engine: "hindsight", status: "ready", latencyMs: 1, hits: Array.from({ length: 21 }, () => ({ sourceId: "relevant" })) }] }])).toThrowError(expect.objectContaining({ name: "ZodError" }));
  });
});
