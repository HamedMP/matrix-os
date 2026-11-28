import { describe, expect, it } from "vitest";
import type { CellRange } from "../../../../home/apps/sheets/src/session/engine";
import { coveredIn } from "../../../../home/apps/sheets/src/grid/merge-guard";

const range = (top: number, left: number, bottom: number, right: number): CellRange => ({
  start: { row: top, col: left },
  end: { row: bottom, col: right },
});

// Outcome: data tools can tell which cells a merge hides, on any sheet size.
// Fault: the check marks the wrong cells, or its setup grows with the rows a merge spans and freezes Sheets.
describe("coveredIn", () => {
  it("hides every cell of a merge except its top-left one", () => {
    const covered = coveredIn([range(1, 1, 3, 2), range(5, 0, 5, 4)], range(0, 0, 10, 10));
    expect(covered(1, 1)).toBe(false);
    expect(covered(1, 2)).toBe(true);
    expect(covered(3, 1)).toBe(true);
    expect(covered(3, 2)).toBe(true);
    expect(covered(4, 1)).toBe(false);
    expect(covered(0, 1)).toBe(false);
    expect(covered(2, 3)).toBe(false);
    expect(covered(5, 0)).toBe(false);
    expect(covered(5, 4)).toBe(true);
    expect(covered(5, 5)).toBe(false);
  });

  it("ignores merges outside the area", () => {
    const covered = coveredIn([range(20, 0, 30, 1)], range(0, 0, 10, 10));
    expect(covered(25, 1)).toBe(false);
  });

  it("handles merges that start on different rows and overlap in rows", () => {
    // Side-by-side merges whose row spans overlap without sharing a cell.
    const merges = [range(0, 0, 9, 0), range(5, 1, 14, 1), range(2, 2, 3, 3), range(10, 0, 12, 0)];
    const covered = coveredIn(merges, range(0, 0, 20, 5));
    expect(covered(0, 0)).toBe(false);
    expect(covered(9, 0)).toBe(true);
    expect(covered(10, 0)).toBe(false);
    expect(covered(11, 0)).toBe(true);
    expect(covered(13, 0)).toBe(false);
    expect(covered(4, 1)).toBe(false);
    expect(covered(5, 1)).toBe(false);
    expect(covered(14, 1)).toBe(true);
    expect(covered(15, 1)).toBe(false);
    expect(covered(2, 2)).toBe(false);
    expect(covered(3, 3)).toBe(true);
    expect(covered(4, 3)).toBe(false);
  });

  it("does not spend time on every row a tall merge spans", () => {
    // 1,000 merges, each two columns wide and 100,000 rows tall: expanding them by row would make 100 million entries.
    const merges = Array.from({ length: 1000 }, (_, index) => range(0, index * 2, 99_999, index * 2 + 1));
    const area = range(0, 0, 99_999, 16_383);
    const started = performance.now();
    const covered = coveredIn(merges, area);
    let hidden = 0;
    for (let row = 0; row < 2000; row++) if (covered(row * 50, 1)) hidden++;
    const elapsed = performance.now() - started;
    expect(hidden).toBe(2000);
    expect(covered(0, 0)).toBe(false);
    expect(covered(50_000, 1998)).toBe(true);
    expect(covered(50_000, 2000)).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });
});
