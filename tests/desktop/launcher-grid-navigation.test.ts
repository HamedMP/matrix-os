import { describe, expect, it } from "vitest";
import {
  countGridColumns,
  launcherGridKeyNavigates,
  nextLauncherGridIndex,
  type LauncherGridKey,
} from "../../desktop/src/renderer/src/features/embeds/launcher-grid-navigation";

// Fault detected: the launchpad grid moves the highlight to the wrong tile (or off the grid)
// when the user navigates with arrow keys, Home or End.
function move(index: number, count: number, columns: number, key: LauncherGridKey) {
  return nextLauncherGridIndex({ index, count, columns, key });
}

describe("nextLauncherGridIndex", () => {
  describe("full 4x3 grid (12 tiles, 4 columns)", () => {
    it.each([
      [0, "ArrowRight", 1], [3, "ArrowRight", 4], [11, "ArrowRight", 11],
      [1, "ArrowLeft", 0], [4, "ArrowLeft", 3], [0, "ArrowLeft", 0],
      [1, "ArrowDown", 5], [6, "ArrowDown", 10], [9, "ArrowDown", 9], [11, "ArrowDown", 11],
      [5, "ArrowUp", 1], [10, "ArrowUp", 6], [2, "ArrowUp", 2], [0, "ArrowUp", 0],
      [7, "Home", 0], [0, "Home", 0], [3, "End", 11], [11, "End", 11],
    ] as const)("from %i, %s lands on %i", (from, key, to) => {
      expect(move(from, 12, 4, key)).toBe(to);
    });
  });

  describe("short last row (10 tiles, 4 columns: last row has 2)", () => {
    it.each([
      [5, "ArrowDown", 9], [6, "ArrowDown", 9], [7, "ArrowDown", 9], [4, "ArrowDown", 8],
      [8, "ArrowDown", 8], [9, "ArrowDown", 9],
      [8, "ArrowUp", 4], [9, "ArrowUp", 5],
      [9, "ArrowRight", 9], [8, "ArrowLeft", 7],
      [2, "End", 9],
    ] as const)("from %i, %s lands on %i", (from, key, to) => {
      expect(move(from, 10, 4, key)).toBe(to);
    });
  });

  it("keeps vertical moves in place on a single row", () => {
    expect(move(2, 5, 8, "ArrowDown")).toBe(2);
    expect(move(2, 5, 8, "ArrowUp")).toBe(2);
    expect(move(2, 5, 8, "ArrowRight")).toBe(3);
    expect(move(2, 5, 8, "ArrowLeft")).toBe(1);
  });

  it("moves one tile per row in a single column", () => {
    expect(move(0, 4, 1, "ArrowDown")).toBe(1);
    expect(move(3, 4, 1, "ArrowDown")).toBe(3);
    expect(move(2, 4, 1, "ArrowUp")).toBe(1);
    expect(move(0, 4, 1, "ArrowUp")).toBe(0);
    expect(move(1, 4, 1, "ArrowRight")).toBe(2);
    expect(move(1, 4, 1, "ArrowLeft")).toBe(0);
  });

  it.each(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as const)(
    "keeps a single tile active for %s",
    (key) => {
      expect(move(0, 1, 6, key)).toBe(0);
    },
  );

  it.each(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as const)(
    "returns 0 for an empty grid on %s",
    (key) => {
      expect(move(0, 0, 4, key)).toBe(0);
    },
  );

  it("clamps an out-of-range index and an invalid column count", () => {
    expect(move(20, 5, 2, "ArrowLeft")).toBe(3);
    expect(move(1, 5, 0, "ArrowDown")).toBe(2);
  });
});

describe("countGridColumns", () => {
  it("counts the tiles that share the first tile's row", () => {
    expect(countGridColumns([0, 0, 0, 120, 120, 240])).toBe(3);
  });

  it("treats a single row as one row of all tiles", () => {
    expect(countGridColumns([10, 10, 10, 10])).toBe(4);
  });

  it("returns at least one column", () => {
    expect(countGridColumns([])).toBe(1);
    expect(countGridColumns([0, 50, 100])).toBe(1);
  });
});

describe("launcherGridKeyNavigates", () => {
  const input = (value: string, start: number, end = start) => ({ value, selectionStart: start, selectionEnd: end });

  it("navigates vertically regardless of the caret", () => {
    expect(launcherGridKeyNavigates("ArrowDown", input("ab", 1))).toBe(true);
    expect(launcherGridKeyNavigates("ArrowUp", input("ab", 1))).toBe(true);
  });

  it("navigates horizontally when the search is empty", () => {
    expect(launcherGridKeyNavigates("ArrowLeft", input("", 0))).toBe(true);
    expect(launcherGridKeyNavigates("ArrowRight", input("", 0))).toBe(true);
    expect(launcherGridKeyNavigates("Home", input("", 0))).toBe(true);
    expect(launcherGridKeyNavigates("End", input("", 0))).toBe(true);
  });

  it("leaves Left and Home to the caret unless it is at the start", () => {
    expect(launcherGridKeyNavigates("ArrowLeft", input("ab", 1))).toBe(false);
    expect(launcherGridKeyNavigates("ArrowLeft", input("ab", 2))).toBe(false);
    expect(launcherGridKeyNavigates("Home", input("ab", 2))).toBe(false);
    expect(launcherGridKeyNavigates("ArrowLeft", input("ab", 0))).toBe(true);
    expect(launcherGridKeyNavigates("Home", input("ab", 0))).toBe(true);
  });

  it("leaves Right and End to the caret unless it is at the end", () => {
    expect(launcherGridKeyNavigates("ArrowRight", input("ab", 1))).toBe(false);
    expect(launcherGridKeyNavigates("ArrowRight", input("ab", 0))).toBe(false);
    expect(launcherGridKeyNavigates("End", input("ab", 0))).toBe(false);
    expect(launcherGridKeyNavigates("ArrowRight", input("ab", 2))).toBe(true);
    expect(launcherGridKeyNavigates("End", input("ab", 2))).toBe(true);
  });

  it("leaves horizontal keys to the input while text is selected", () => {
    expect(launcherGridKeyNavigates("ArrowLeft", input("ab", 0, 2))).toBe(false);
    expect(launcherGridKeyNavigates("ArrowRight", input("ab", 0, 2))).toBe(false);
  });
});
