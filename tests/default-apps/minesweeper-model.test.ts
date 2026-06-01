import { describe, expect, it } from "vitest";
import {
  CELL,
  chord,
  createBoard,
  difficultyConfig,
  flagsPlaced,
  generateMines,
  isLost,
  isWon,
  minesRemaining,
  neighbors,
  placeMinesAvoiding,
  reveal,
  toggleFlag,
  type Board,
} from "../../home/apps/games/minesweeper/src/minesweeper-model";

// Deterministic RNG: returns values from a fixed queue, looping.
function seededRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

function countMines(board: Board): number {
  let n = 0;
  for (const row of board.cells) for (const c of row) if (c.mine) n += 1;
  return n;
}

describe("minesweeper difficulty config", () => {
  it("defines classic Windows difficulties", () => {
    expect(difficultyConfig("beginner")).toEqual({ rows: 9, cols: 9, mines: 10 });
    expect(difficultyConfig("intermediate")).toEqual({ rows: 16, cols: 16, mines: 40 });
    expect(difficultyConfig("expert")).toEqual({ rows: 16, cols: 30, mines: 99 });
  });
});

describe("createBoard", () => {
  it("creates a fully hidden board with no mines until first click", () => {
    const board = createBoard({ rows: 9, cols: 9, mines: 10 });
    expect(board.rows).toBe(9);
    expect(board.cols).toBe(9);
    expect(board.mines).toBe(10);
    expect(board.status).toBe("ready");
    expect(countMines(board)).toBe(0);
    for (const row of board.cells) {
      for (const c of row) {
        expect(c.state).toBe(CELL.HIDDEN);
        expect(c.mine).toBe(false);
      }
    }
  });
});

describe("generateMines / placeMinesAvoiding (first-click safety)", () => {
  it("places exactly the requested number of mines", () => {
    const positions = generateMines(9, 9, 10, new Set<number>(), seededRng([0.0, 0.99, 0.5, 0.25, 0.75, 0.1, 0.3, 0.6, 0.8, 0.4, 0.2, 0.7]));
    expect(positions.size).toBe(10);
  });

  it("never places a mine on the safe cell or its neighbors", () => {
    const board = createBoard({ rows: 9, cols: 9, mines: 10 });
    // first click at center 4,4
    const placed = placeMinesAvoiding(board, 4, 4, seededRng([0.01, 0.5, 0.9, 0.2, 0.7, 0.3, 0.6, 0.15, 0.85, 0.45]));
    const safeIndex = 4 * 9 + 4;
    const safeZone = new Set<number>([safeIndex, ...neighbors(4, 4, 9, 9).map(([r, c]) => r * 9 + c)]);
    expect(countMines(placed)).toBe(10);
    for (const idx of safeZone) {
      const r = Math.floor(idx / 9);
      const c = idx % 9;
      expect(placed.cells[r][c].mine).toBe(false);
    }
  });

  it("computes adjacency counts correctly", () => {
    const board = createBoard({ rows: 3, cols: 3, mines: 1 });
    // force a single mine at (0,0) by avoiding everywhere else
    const placed = placeMinesAvoiding(board, 2, 2, seededRng([0.0]));
    // mine should be away from (2,2) safe zone -> at (0,0)
    expect(placed.cells[0][0].mine).toBe(true);
    expect(placed.cells[0][1].adjacent).toBe(1);
    expect(placed.cells[1][0].adjacent).toBe(1);
    expect(placed.cells[1][1].adjacent).toBe(1);
    expect(placed.cells[2][2].adjacent).toBe(0);
  });
});

describe("reveal + flood fill", () => {
  it("flood-fills connected zero cells on first click and stays playing", () => {
    const board = createBoard({ rows: 9, cols: 9, mines: 10 });
    const next = reveal(board, 4, 4, seededRng([0.01, 0.5, 0.9, 0.2, 0.7, 0.3, 0.6, 0.15, 0.85, 0.45]));
    expect(next.status).toBe("playing");
    // The clicked cell is revealed.
    expect(next.cells[4][4].state).toBe(CELL.REVEALED);
    // First click should open at least a region (more than just one cell).
    let revealed = 0;
    for (const row of next.cells) for (const c of row) if (c.state === CELL.REVEALED) revealed += 1;
    expect(revealed).toBeGreaterThan(1);
  });

  it("does not reveal flagged cells", () => {
    let board = createBoard({ rows: 5, cols: 5, mines: 1 });
    board = reveal(board, 4, 4, seededRng([0.0])); // initialize mines
    board = toggleFlag(board, 0, 0);
    const before = board.cells[0][0].state;
    const after = reveal(board, 0, 0).cells[0][0].state;
    expect(before).toBe(CELL.FLAGGED);
    expect(after).toBe(CELL.FLAGGED);
  });

  it("does not place mines when the first clicked cell is flagged", () => {
    let board = createBoard({ rows: 5, cols: 5, mines: 1 });
    board = toggleFlag(board, 0, 0);

    const after = reveal(board, 0, 0, seededRng([0.0]));

    expect(after).toBe(board);
    expect(after.status).toBe("ready");
    expect(after.cells.flat().some((cell) => cell.mine)).toBe(false);
  });

  it("loses when revealing a mine and exposes all mines", () => {
    let board = createBoard({ rows: 3, cols: 3, mines: 1 });
    board = placeMinesAvoiding(board, 2, 2, seededRng([0.0])); // mine at (0,0)
    const dead = reveal(board, 0, 0);
    expect(dead.status).toBe("lost");
    expect(isLost(dead)).toBe(true);
    expect(dead.cells[0][0].state).toBe(CELL.EXPLODED);
  });
});

describe("flagging", () => {
  it("toggles flag on hidden cells and counts mines remaining", () => {
    let board = createBoard({ rows: 9, cols: 9, mines: 10 });
    board = reveal(board, 4, 4, seededRng([0.5, 0.1, 0.9, 0.2, 0.7, 0.3, 0.6, 0.15, 0.85, 0.45]));
    expect(minesRemaining(board)).toBe(10);
    board = toggleFlag(board, 0, 0);
    expect(board.cells[0][0].state).toBe(CELL.FLAGGED);
    expect(flagsPlaced(board)).toBe(1);
    expect(minesRemaining(board)).toBe(9);
    board = toggleFlag(board, 0, 0);
    expect(board.cells[0][0].state).toBe(CELL.HIDDEN);
    expect(minesRemaining(board)).toBe(10);
  });

  it("cannot flag a revealed cell", () => {
    let board = createBoard({ rows: 5, cols: 5, mines: 1 });
    board = reveal(board, 4, 4, seededRng([0.0]));
    // (4,4) is revealed; flagging it is a no-op
    const flagged = toggleFlag(board, 4, 4);
    expect(flagged.cells[4][4].state).toBe(CELL.REVEALED);
  });
});

describe("chord", () => {
  it("reveals neighbors when flag count matches the number", () => {
    let board = createBoard({ rows: 3, cols: 3, mines: 1 });
    board = placeMinesAvoiding(board, 2, 2, seededRng([0.0])); // mine at (0,0)
    board = reveal(board, 1, 1); // reveal the "1" at center
    expect(board.cells[1][1].state).toBe(CELL.REVEALED);
    expect(board.cells[1][1].adjacent).toBe(1);
    board = toggleFlag(board, 0, 0); // correctly flag the mine
    const after = chord(board, 1, 1);
    // All non-mine neighbors should now be revealed.
    for (const [r, c] of neighbors(1, 1, 3, 3)) {
      if (!after.cells[r][c].mine) {
        expect(after.cells[r][c].state).toBe(CELL.REVEALED);
      }
    }
    expect(after.status).not.toBe("lost");
  });

  it("explodes on chord if a flag is wrong", () => {
    let board = createBoard({ rows: 3, cols: 3, mines: 1 });
    board = placeMinesAvoiding(board, 2, 2, seededRng([0.0])); // mine at (0,0)
    board = reveal(board, 1, 1);
    board = toggleFlag(board, 0, 1); // wrong flag (not the mine)
    const after = chord(board, 1, 1);
    expect(after.status).toBe("lost");
  });
});

describe("win detection", () => {
  it("wins when all non-mine cells are revealed", () => {
    let board = createBoard({ rows: 3, cols: 3, mines: 1 });
    board = placeMinesAvoiding(board, 2, 2, seededRng([0.0])); // mine at (0,0)
    // reveal every non-mine cell
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        if (!board.cells[r][c].mine) {
          board = reveal(board, r, c);
        }
      }
    }
    expect(isWon(board)).toBe(true);
    expect(board.status).toBe("won");
    // remaining mines display goes to 0 when won (all mines auto-flagged)
    expect(minesRemaining(board)).toBe(0);
  });
});
