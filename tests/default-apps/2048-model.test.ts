import { describe, expect, it } from "vitest";
import {
  type Board,
  type Direction,
  addRandomTile,
  canMove,
  cloneBoard,
  countEmpty,
  createEmptyBoard,
  hasWon,
  isGameOver,
  move,
  newGame,
} from "../../home/apps/games/2048/src/game-2048";

// A deterministic RNG returning the values in `seq`, cycling if exhausted.
function seqRng(seq: number[]): () => number {
  let i = 0;
  return () => {
    const v = seq[i % seq.length];
    i += 1;
    return v;
  };
}

// Build a board from a 4x4 grid of numbers (0 = empty).
function grid(rows: number[][]): Board {
  return rows.map((r) => [...r]);
}

function flat(b: Board): number[] {
  return b.flat();
}

describe("2048 engine — empty board + helpers", () => {
  it("creates an empty 4x4 board", () => {
    const b = createEmptyBoard();
    expect(b.length).toBe(4);
    expect(b.every((r) => r.length === 4)).toBe(true);
    expect(countEmpty(b)).toBe(16);
  });

  it("cloneBoard makes an independent copy", () => {
    const b = grid([
      [2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const c = cloneBoard(b);
    c[0][0] = 4;
    expect(b[0][0]).toBe(2);
  });
});

describe("2048 engine — slide + merge per direction", () => {
  it("slides tiles left and merges equal neighbors once", () => {
    const b = grid([
      [2, 2, 2, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const r = move(b, "left");
    expect(r.board[0]).toEqual([4, 4, 0, 0]);
    expect(r.moved).toBe(true);
    expect(r.gained).toBe(8); // two merges of 2+2 -> 4 + 4
  });

  it("slides and merges right", () => {
    const b = grid([
      [2, 2, 4, 4],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const r = move(b, "right");
    expect(r.board[0]).toEqual([0, 0, 4, 8]);
    expect(r.gained).toBe(12);
  });

  it("slides and merges up", () => {
    const b = grid([
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    const r = move(b, "up");
    expect(r.board.map((row) => row[0])).toEqual([4, 4, 0, 0]);
    expect(r.gained).toBe(8);
  });

  it("slides and merges down", () => {
    const b = grid([
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [4, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const r = move(b, "down");
    expect(r.board.map((row) => row[0])).toEqual([0, 0, 4, 4]);
    expect(r.gained).toBe(4);
  });

  it("does not double-merge in a single move (8 not 16)", () => {
    // [2,2,4,0] left -> first 2+2 merge into 4, then existing 4 stays separate
    const b = grid([
      [2, 2, 4, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const r = move(b, "left");
    expect(r.board[0]).toEqual([4, 4, 0, 0]);
    expect(r.gained).toBe(4);
  });

  it("merges both adjacent pairs in correct order (left)", () => {
    const b = grid([
      [4, 4, 2, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const r = move(b, "left");
    expect(r.board[0]).toEqual([8, 4, 0, 0]);
    expect(r.gained).toBe(12);
  });

  it("reports moved=false when nothing changes", () => {
    const b = grid([
      [2, 4, 8, 16],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const r = move(b, "left");
    expect(r.moved).toBe(false);
    expect(r.gained).toBe(0);
    expect(r.board).toEqual(b);
  });

  it("does not mutate the input board", () => {
    const b = grid([
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const snapshot = flat(b);
    move(b, "left");
    expect(flat(b)).toEqual(snapshot);
  });
});

describe("2048 engine — spawn", () => {
  it("addRandomTile fills exactly one empty cell", () => {
    const b = createEmptyBoard();
    // rng: first value picks the empty-cell index, second picks 2-vs-4
    const r = addRandomTile(b, seqRng([0, 0]));
    expect(countEmpty(r.board)).toBe(15);
    expect(r.spawned).not.toBeNull();
  });

  it("spawns a 4 roughly 10% of the time (rng >= 0.9 -> 4)", () => {
    const b = createEmptyBoard();
    const r = addRandomTile(b, seqRng([0, 0.95]));
    expect(r.spawned).not.toBeNull();
    expect(r.board[r.spawned!.row][r.spawned!.col]).toBe(4);
  });

  it("spawns a 2 when rng < 0.9", () => {
    const b = createEmptyBoard();
    const r = addRandomTile(b, seqRng([0, 0.1]));
    expect(r.board[r.spawned!.row][r.spawned!.col]).toBe(2);
  });

  it("returns null spawn when board is full", () => {
    const full = grid([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    const r = addRandomTile(full, seqRng([0, 0]));
    expect(r.spawned).toBeNull();
    expect(r.board).toEqual(full);
  });
});

describe("2048 engine — win + game over", () => {
  it("hasWon true when a 2048 tile exists", () => {
    const b = grid([
      [2048, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(hasWon(b)).toBe(true);
  });

  it("hasWon false otherwise", () => {
    expect(hasWon(createEmptyBoard())).toBe(false);
  });

  it("canMove true when an empty cell exists", () => {
    const b = grid([
      [2, 4, 8, 16],
      [4, 8, 16, 32],
      [8, 16, 32, 64],
      [16, 32, 64, 0],
    ]);
    expect(canMove(b)).toBe(true);
    expect(isGameOver(b)).toBe(false);
  });

  it("canMove true when an adjacent merge is available even with full board", () => {
    const b = grid([
      [2, 2, 8, 16],
      [4, 8, 16, 32],
      [8, 16, 32, 64],
      [16, 32, 64, 128],
    ]);
    expect(canMove(b)).toBe(true);
  });

  it("isGameOver true on a full board with no merges", () => {
    const b = grid([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    expect(canMove(b)).toBe(false);
    expect(isGameOver(b)).toBe(true);
  });
});

describe("2048 engine — newGame", () => {
  it("starts with exactly two tiles", () => {
    const g = newGame(seqRng([0, 0, 0.5, 0, 0]));
    expect(countEmpty(g.board)).toBe(14);
    expect(g.score).toBe(0);
    expect(g.won).toBe(false);
    expect(g.over).toBe(false);
  });

  it("is deterministic given a fixed RNG", () => {
    const a = newGame(seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]));
    const b = newGame(seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]));
    expect(a.board).toEqual(b.board);
  });
});

describe("2048 engine — move directions exhaustive", () => {
  const dirs: Direction[] = ["left", "right", "up", "down"];
  it("every direction is a pure function returning a fresh board", () => {
    const b = grid([
      [2, 0, 2, 0],
      [0, 4, 0, 4],
      [8, 0, 8, 0],
      [0, 0, 0, 0],
    ]);
    for (const d of dirs) {
      const r = move(b, d);
      expect(r.board).not.toBe(b);
      expect(r.board.length).toBe(4);
    }
  });
});
