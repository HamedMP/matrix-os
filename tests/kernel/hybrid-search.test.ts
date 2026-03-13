import { describe, it, expect } from "vitest";
import {
  reciprocalRankFusion,
  type RankedResult,
} from "../../packages/kernel/src/hybrid-search.js";

describe("hybrid search", () => {
  describe("reciprocalRankFusion", () => {
    it("merges two ranked lists", () => {
      const listA: RankedResult[] = [
        { id: "a", content: "first in A", score: 1.0 },
        { id: "b", content: "second in A", score: 0.8 },
      ];
      const listB: RankedResult[] = [
        { id: "b", content: "first in B", score: 1.0 },
        { id: "c", content: "second in B", score: 0.7 },
      ];

      const merged = reciprocalRankFusion([listA, listB]);
      expect(merged[0].id).toBe("b");
      expect(merged.length).toBe(3);
    });

    it("boosts items appearing in multiple lists", () => {
      const listA: RankedResult[] = [
        { id: "x", content: "content x", score: 1.0 },
        { id: "shared", content: "shared content", score: 0.5 },
      ];
      const listB: RankedResult[] = [
        { id: "shared", content: "shared content", score: 1.0 },
        { id: "y", content: "content y", score: 0.5 },
      ];

      const merged = reciprocalRankFusion([listA, listB]);
      expect(merged[0].id).toBe("shared");
      expect(merged[0].score).toBeGreaterThan(merged[1].score);
    });

    it("handles empty lists", () => {
      const merged = reciprocalRankFusion([[], []]);
      expect(merged.length).toBe(0);
    });

    it("handles single list", () => {
      const list: RankedResult[] = [
        { id: "a", content: "only item", score: 1.0 },
      ];
      const merged = reciprocalRankFusion([list]);
      expect(merged.length).toBe(1);
      expect(merged[0].id).toBe("a");
    });

    it("respects limit parameter", () => {
      const list: RankedResult[] = Array.from({ length: 20 }, (_, i) => ({
        id: `item-${i}`,
        content: `Content ${i}`,
        score: 1 - i * 0.05,
      }));

      const merged = reciprocalRankFusion([list], { limit: 5 });
      expect(merged.length).toBe(5);
    });

    it("uses default k=60 for RRF calculation", () => {
      const listA: RankedResult[] = [
        { id: "first", content: "content", score: 1.0 },
      ];

      const merged = reciprocalRankFusion([listA]);
      // With k=60, rank 0: score = 1/(60+0+1) = 1/61
      expect(merged[0].score).toBeCloseTo(1 / 61, 5);
    });

    it("uses custom k parameter", () => {
      const listA: RankedResult[] = [
        { id: "first", content: "content", score: 1.0 },
      ];

      const merged = reciprocalRankFusion([listA], { k: 10 });
      // With k=10, rank 0: score = 1/(10+0+1) = 1/11
      expect(merged[0].score).toBeCloseTo(1 / 11, 5);
    });

    it("preserves sourceType and sourceId from original results", () => {
      const list: RankedResult[] = [
        { id: "a", content: "content", score: 1.0, sourceType: "memory", sourceId: "src-1" },
      ];

      const merged = reciprocalRankFusion([list]);
      expect(merged[0].sourceType).toBe("memory");
      expect(merged[0].sourceId).toBe("src-1");
    });

    it("handles three ranked lists", () => {
      const listA: RankedResult[] = [
        { id: "a", content: "a", score: 1.0 },
        { id: "b", content: "b", score: 0.5 },
      ];
      const listB: RankedResult[] = [
        { id: "b", content: "b", score: 1.0 },
        { id: "c", content: "c", score: 0.5 },
      ];
      const listC: RankedResult[] = [
        { id: "b", content: "b", score: 1.0 },
        { id: "a", content: "a", score: 0.5 },
      ];

      const merged = reciprocalRankFusion([listA, listB, listC]);
      // "b" appears in all three lists, "a" in two
      expect(merged[0].id).toBe("b");
      expect(merged[1].id).toBe("a");
    });

    it("defaults limit to 20", () => {
      const list: RankedResult[] = Array.from({ length: 30 }, (_, i) => ({
        id: `item-${i}`,
        content: `Content ${i}`,
        score: 1 - i * 0.03,
      }));

      const merged = reciprocalRankFusion([list]);
      expect(merged.length).toBe(20);
    });

    it("handles no lists", () => {
      const merged = reciprocalRankFusion([]);
      expect(merged.length).toBe(0);
    });
  });
});
