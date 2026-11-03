import { describe, expect, it } from "vitest";
import { pairedRecall } from "../../packages/kernel/src/memory-evaluation/statistics.js";
import { createSuite } from "../../packages/kernel/src/memory-evaluation/fixtures.js";
import { runBenchmark } from "../../packages/kernel/src/memory-evaluation/runner.js";
import { createBaseline } from "../../scripts/memory-bench/baselines.js";

it("computes reproducible paired case-level intervals and rejects mismatched datasets", async () => {
  const suite = createSuite({ distractors: 0 });
  const a = await runBenchmark(suite, () => createBaseline("none"));
  const b = await runBenchmark(suite, () => createBaseline("raw-lexical"));
  const comparison = pairedRecall(a, b, 4);
  expect(comparison).toEqual(pairedRecall(a, b, 4));
  expect(comparison.delta).toBe(1);
  expect(comparison.low).toBe(1);
  expect(comparison.high).toBe(1);
  expect(comparison.unit).toBe("case");
  b.suite.sha256 = "other";
  expect(() => pairedRecall(a, b)).toThrow();
});

it("reports unmeasured intervals when paired evidence is unavailable", async () => {
  const suite = createSuite({ distractors: 0 });
  const a = await runBenchmark({ ...suite, cases: [suite.cases.find(c => c.id === "boilerplate")!] }, () => createBaseline("none"));
  expect(pairedRecall(a, a).delta).toBeNull();
  expect(pairedRecall(a, a).low).toBeNull();
  a.cases[0].operations[0].error = "unavailable";
  expect(pairedRecall(a, a).cases).toBe(0);
});
