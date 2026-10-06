import { describe, expect, it } from "vitest";
import { createSuite } from "../../packages/kernel/src/memory-evaluation/fixtures.js";
import { suiteSchema } from "../../packages/kernel/src/memory-evaluation/contracts.js";
import { scoreQuery, summarize } from "../../packages/kernel/src/memory-evaluation/metrics.js";

describe("memory benchmark contract and scoring", () => {
  it("reproduces a seeded corpus and changes distractors with a different seed", () => {
    expect(createSuite({ seed: 4, distractors: 10 })).toEqual(createSuite({ seed: 4, distractors: 10 }));
    expect(createSuite({ seed: 4, distractors: 10 })).not.toEqual(createSuite({ seed: 5, distractors: 10 }));
  });
  it("rejects unbounded corpora and invalid source paths", () => {
    expect(() => createSuite({ distractors: 100001 })).toThrow();
    const suite = createSuite();
    const event = suite.cases[0].steps[0];
    if (event.type !== "ingest") throw new Error("fixture");
    expect(() => suiteSchema.parse({ ...suite, cases: [{ ...suite.cases[0], steps: [{ ...event, source: { ...event.source, path: "../secrets" } }] }] })).toThrow();
  });
  it("rejects backwards replay, missing deletion targets and invalid evidence labels", () => {
    const input = createSuite({ distractors: 0 });
    const c = structuredClone(input.cases[0]);
    const query = c.steps[1];
    if (query.type !== "query") throw new Error("fixture");
    query.query.at = "2026-01-01T00:00:00Z";
    expect(() => suiteSchema.parse({ ...input, cases: [c] })).toThrow();
    expect(() => suiteSchema.parse({ ...input, cases: [{ ...c, steps: [{ type: "forget", sourceId: "missing" }] }] })).toThrow();
    query.query.at = "2026-06-15T09:00:00Z";
    query.expected.relevant.push("preference");
    expect(() => suiteSchema.parse({ ...input, cases: [c] })).toThrow();
    query.expected.relevant = ["preference"];
    query.expected.requiredText = { preference: "this evidence does not exist" };
    expect(() => suiteSchema.parse({ ...input, cases: [c] })).toThrow();
    query.expected.requiredText = { invalid: "missing" };
    expect(() => suiteSchema.parse({ ...input, cases: [c] })).toThrow();
  });
  it("scores missing evidence and unknown status separately", () => {
    const result = scoreQuery({ relevant: ["a", "b"], forbidden: [], status: "evidence" }, ["b"], "evidence", 2);
    expect(result.recall).toBe(0.5);
    expect(result.precision).toBe(1);
    expect(result.mrr).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.ndcg).toBeCloseTo(1 / (1 + 1 / Math.log2(3)));
    expect(scoreQuery({ relevant: [], forbidden: [], status: "unknown" }, [], "unknown").recall).toBeNull();
  });
  it("uses nearest-rank percentiles and leaves unavailable costs unmeasured", () => {
    const summary = summarize([], [{ latencyMs: 1, costUsd: null }, { latencyMs: 20, costUsd: null }], []);
    expect(summary.p95Ms).toBe(20);
    expect(summary.costUsd).toBeNull();
    expect(summary.recall).toBeNull();
  });
});
