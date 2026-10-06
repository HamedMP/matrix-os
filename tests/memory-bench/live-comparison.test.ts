import { expect, it } from "vitest";
import { scoreLiveComparison } from "../../scripts/memory-bench/live-comparison.js";
it("compares independently attributed source evidence without rewarding unavailable engines", () => {
  const result = scoreLiveComparison(
    [{ query: "When?", relevantSourceIds: ["a", "b"] }],
    [
      {
        query: "When?",
        results: [
          {
            engine: "hindsight",
            status: "ready",
            latencyMs: 12,
            hits: [{ sourceId: "a" }, { sourceId: "wrong" }],
          },
          {
            engine: "openviking",
            status: "unavailable",
            latencyMs: 30,
            hits: [],
          },
        ],
      },
    ],
  );
  expect(result.hindsight).toMatchObject({
    recall: 0.5,
    precision: 0.5,
    mrr: 1,
    availability: 1,
  });
  expect(result.openviking).toMatchObject({ recall: null, availability: 0 });
});
it("counts unsupported citations and abstention questions explicitly", () => {
  const r = scoreLiveComparison(
    [{ query: "Unknown", relevantSourceIds: [] }],
    [
      {
        query: "Unknown",
        results: [
          {
            engine: "hindsight",
            status: "ready",
            latencyMs: 1,
            hits: [{ sourceId: "wrong" }],
          },
        ],
      },
    ],
  );
  expect(r.hindsight.falsePositiveQueries).toBe(1);
});
