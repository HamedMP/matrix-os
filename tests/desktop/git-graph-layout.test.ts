import { describe, expect, it } from "vitest";
import { computeGraphLayout, laneColor, laneColorVar, LANE_COLOR_VARS } from "../../desktop/src/renderer/src/features/git/graph-layout";

function commit(sha: string, parents: string[] = []) {
  return { sha, parents };
}

describe("computeGraphLayout", () => {
  it("lays out an empty history", () => {
    expect(computeGraphLayout([])).toEqual({ rows: [], edges: [], columnCount: 0 });
  });

  it("keeps a linear history in a single lane", () => {
    const layout = computeGraphLayout([commit("a", ["b"]), commit("b", ["c"]), commit("c")]);

    expect(layout.rows.map((row) => row.col)).toEqual([0, 0, 0]);
    expect(layout.columnCount).toBe(1);
    expect(layout.edges).toEqual([
      { fromRow: 0, fromCol: 0, toRow: 1, toCol: 0, colorIndex: 0 },
      { fromRow: 1, fromCol: 0, toRow: 2, toCol: 0, colorIndex: 0 },
    ]);
  });

  it("branches a fork into its own lane and curves the merge edges", () => {
    // newest-first: merge M (main), feature commit F, main commit A, fork point B
    const layout = computeGraphLayout([
      commit("m", ["a", "f"]),
      commit("f", ["b"]),
      commit("a", ["b"]),
      commit("b"),
    ]);

    expect(layout.rows.map((row) => row.col)).toEqual([0, 1, 0, 0]);
    expect(layout.columnCount).toBe(2);
    expect(layout.edges).toContainEqual({ fromRow: 0, fromCol: 0, toRow: 2, toCol: 0, colorIndex: 0 });
    expect(layout.edges).toContainEqual({ fromRow: 0, fromCol: 0, toRow: 1, toCol: 1, colorIndex: 1 });
    expect(layout.edges).toContainEqual({ fromRow: 1, fromCol: 1, toRow: 3, toCol: 0, colorIndex: 0 });
    expect(layout.edges).toContainEqual({ fromRow: 2, fromCol: 0, toRow: 3, toCol: 0, colorIndex: 0 });
  });

  it("points edges below the loaded window at the reserved lane with toRow -1", () => {
    const layout = computeGraphLayout([commit("a", ["x"])]);

    expect(layout.edges).toEqual([{ fromRow: 0, fromCol: 0, toRow: -1, toCol: 0, colorIndex: 0 }]);
  });

  it("reserves extra lanes for octopus merges beyond the window", () => {
    const layout = computeGraphLayout([commit("m", ["a", "x", "y"])]);

    expect(layout.columnCount).toBe(3);
    expect(layout.edges).toContainEqual({ fromRow: 0, fromCol: 0, toRow: -1, toCol: 0, colorIndex: 0 });
    expect(layout.edges).toContainEqual({ fromRow: 0, fromCol: 0, toRow: -1, toCol: 1, colorIndex: 1 });
    expect(layout.edges).toContainEqual({ fromRow: 0, fromCol: 0, toRow: -1, toCol: 2, colorIndex: 2 });
  });

  it("clears duplicate reservations once a commit is placed", () => {
    // B is reserved twice: as first parent of A (lane 0) and as parent of F (lane 1).
    // Placing B must not allocate a third lane and both edges land on lane 0.
    const layout = computeGraphLayout([commit("m", ["a", "f"]), commit("f", ["b"]), commit("a", ["b"]), commit("b")]);
    expect(layout.columnCount).toBe(2);

    const reloaded = computeGraphLayout([commit("f", ["b"]), commit("a", ["b"]), commit("b")]);
    // f takes lane 0 and reserves b there; unreserved a opens lane 1;
    // b lands on the lowest reserved lane and clears the lane-1 duplicate.
    expect(reloaded.rows.map((row) => row.col)).toEqual([0, 1, 0]);
    expect(reloaded.columnCount).toBe(2);
    expect(reloaded.edges).toContainEqual({ fromRow: 0, fromCol: 0, toRow: 2, toCol: 0, colorIndex: 0 });
    expect(reloaded.edges).toContainEqual({ fromRow: 1, fromCol: 1, toRow: 2, toCol: 0, colorIndex: 0 });
  });

  it("reuses a freed lane for an unrelated later root", () => {
    // A root commit frees its lane immediately (no parents to reserve), so an
    // unrelated second root reuses lane 0 instead of widening the graph.
    const layout = computeGraphLayout([commit("a"), commit("z")]);
    expect(layout.rows.map((row) => row.col)).toEqual([0, 0]);
    expect(layout.columnCount).toBe(1);
    expect(layout.edges).toEqual([]);
  });
});

describe("laneColor", () => {
  it("maps lanes onto theme-driven CSS variables, never hardcoded hex", () => {
    for (const token of LANE_COLOR_VARS) {
      expect(token).toMatch(/^--[a-z-]+$/);
    }
    expect(laneColor(0)).toBe(`var(${LANE_COLOR_VARS[0]})`);
    expect(laneColorVar(0)).not.toBe(laneColorVar(1));
  });

  it("assigns distinct colors per lane and wraps the palette", () => {
    expect(laneColorVar(0)).toBe(LANE_COLOR_VARS[0]);
    expect(laneColorVar(1)).toBe(LANE_COLOR_VARS[1]);
    expect(laneColorVar(LANE_COLOR_VARS.length)).toBe(LANE_COLOR_VARS[0]);
    expect(laneColor(LANE_COLOR_VARS.length)).toBe(laneColor(0));
  });
});
