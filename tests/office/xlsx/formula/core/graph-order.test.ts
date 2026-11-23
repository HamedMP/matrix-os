import { describe, expect, it } from "vitest";
import { calculationOrder } from "../../../../../packages/office/src/xlsx/formula/graph/order.js";
import { RangeIndex } from "../../../../../packages/office/src/xlsx/formula/graph/range-index.js";

describe("range index", () => {
  it("finds the rectangles that contain a cell at every size", () => {
    const index = new RangeIndex<string>();
    const small = index.add({ startRow: 0, startCol: 0, endRow: 9, endCol: 3 }, "small");
    index.add({ startRow: 0, startCol: 0, endRow: 9, endCol: 3 }, "small-2");
    index.add({ startRow: 0, startCol: 0, endRow: 9999, endCol: 0 }, "tall");
    index.add({ startRow: 0, startCol: 2, endRow: 1_048_575, endCol: 2 }, "column");
    index.add({ startRow: 500, startCol: 0, endRow: 500, endCol: 16_383 }, "row");
    index.add({ startRow: 70_000, startCol: 300, endRow: 70_010, endCol: 310 }, "far");
    expect(index.size).toBe(5);
    const at = (row: number, col: number) => {
      const found: string[] = [];
      index.containing(row, col, (entry) => found.push(...entry.owners));
      return found.sort();
    };
    expect(at(5, 2)).toEqual(["column", "small", "small-2"]);
    expect(at(5, 0)).toEqual(["small", "small-2", "tall"]);
    expect(at(500, 0)).toEqual(["row", "tall"]);
    expect(at(500, 2)).toEqual(["column", "row"]);
    expect(at(9999, 0)).toEqual(["tall"]);
    expect(at(10_000, 0)).toEqual([]);
    expect(at(70_005, 305)).toEqual(["far"]);
    expect(at(70_011, 305)).toEqual([]);
    index.remove(small, "small");
    expect(at(5, 1)).toEqual(["small-2"]);
    index.remove(small, "small-2");
    expect(at(5, 1)).toEqual([]);
    expect(index.size).toBe(4);
    const hit: string[] = [];
    index.intersecting({ startRow: 400, startCol: 0, endRow: 600, endCol: 1 }, (entry) => hit.push(...entry.owners));
    expect(hit.sort()).toEqual(["row", "tall"]);
    index.clear();
    expect(at(500, 2)).toEqual([]);
  });

  it("agrees with a plain scan on many rectangles", () => {
    const index = new RangeIndex<number>();
    const rects: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }> = [];
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let i = 0; i < 400; i += 1) {
      const startRow = next(3000);
      const startCol = next(60);
      const rect = { startRow, startCol, endRow: startRow + next(i % 7 === 0 ? 20_000 : 80), endCol: startCol + next(i % 5 === 0 ? 800 : 6) };
      rects.push(rect);
      index.add(rect, i);
    }
    for (let probe = 0; probe < 300; probe += 1) {
      const row = next(4000);
      const col = next(90);
      const expected = rects.flatMap((r, i) => (row >= r.startRow && row <= r.endRow && col >= r.startCol && col <= r.endCol ? [i] : []));
      const found: number[] = [];
      index.containing(row, col, (entry) => found.push(...entry.owners));
      expect(found.sort((a, b) => a - b)).toEqual(expected);
    }
  });
});

describe("calculationOrder", () => {
  const edges: Record<string, string[]> = { a: ["b", "c"], b: ["d"], c: ["d"], d: [], x: ["y"], y: ["x", "z"], z: [], s: ["s"] };
  const successors = (n: string) => edges[n] ?? [];

  it("orders precedents first and reports circles", () => {
    const result = calculationOrder(Object.keys(edges), successors);
    expect(result.order.length).toBe(8);
    const at = (n: string) => result.order.indexOf(n);
    expect(at("a")).toBeLessThan(at("b"));
    expect(at("b")).toBeLessThan(at("d"));
    expect(at("c")).toBeLessThan(at("d"));
    expect(at("x")).toBeLessThan(at("z"));
    expect(at("y")).toBeLessThan(at("z"));
    expect([...result.circular].sort()).toEqual(["s", "x", "y"]);
    expect(result.depth.get("a")).toBe(1);
    expect(result.depth.get("d")).toBe(3);
  });

  it("ignores successors outside the set", () => {
    const result = calculationOrder(["a", "b"], successors);
    expect(result.order).toEqual(["a", "b"]);
    expect(result.circular.size).toBe(0);
  });
});
