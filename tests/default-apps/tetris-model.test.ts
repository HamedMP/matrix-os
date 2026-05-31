import { describe, expect, it } from "vitest";
import {
  COLS,
  TOTAL_ROWS,
  PIECES,
  PIECE_COLORS,
  type Board,
  type Cell,
  type PieceType,
  createBoard,
  newBag,
  nextFromBag,
  createGame,
  cellsFor,
  isValid,
  tryMove,
  tryRotate,
  clearLines,
  scoreForLines,
  levelForLines,
  gravityMs,
  lockPiece,
  step,
  softDrop,
  hardDrop,
  holdPiece,
  ghostRow,
  seededRng,
} from "../../home/apps/games/tetris/src/tetris-model";

// Deterministic RNG factory for reproducible tests.
const rng = () => seededRng(12345);

function emptyBoard(): Board {
  return createBoard();
}

// Fill all columns of a row except one, so a single piece can complete it.
function fillRowExcept(board: Board, row: number, gapCol: number, fill: PieceType = "I"): void {
  for (let c = 0; c < COLS; c++) {
    board[row][c] = c === gapCol ? null : fill;
  }
}

describe("7-bag randomizer", () => {
  it("newBag yields each of the 7 pieces exactly once", () => {
    const bag = newBag(rng());
    expect(bag).toHaveLength(7);
    const sorted = [...bag].sort();
    expect(sorted).toEqual([...PIECES].sort());
  });

  it("is a permutation (no duplicates, no missing)", () => {
    const bag = newBag(rng());
    expect(new Set(bag).size).toBe(7);
  });

  it("nextFromBag refills with a fresh bag when empty", () => {
    const empty: PieceType[] = [];
    const { piece, bag } = nextFromBag(empty, rng());
    expect(PIECES).toContain(piece);
    expect(bag).toHaveLength(6); // a fresh 7-bag minus the pulled piece
  });

  it("every piece type has a defined color", () => {
    for (const p of PIECES) {
      expect(PIECE_COLORS[p]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("across many draws each piece appears at the expected 7-bag frequency", () => {
    const counts: Record<string, number> = {};
    let bag = newBag(rng());
    const r = rng();
    for (let i = 0; i < 70; i++) {
      const pulled = nextFromBag(bag, r);
      bag = pulled.bag;
      counts[pulled.piece] = (counts[pulled.piece] ?? 0) + 1;
    }
    // 70 draws over 7-bags => each piece exactly 10 times.
    for (const p of PIECES) {
      expect(counts[p]).toBe(10);
    }
  });
});

describe("piece geometry & rotation", () => {
  it("an active piece always occupies exactly 4 cells", () => {
    const game = createGame(rng());
    expect(cellsFor(game.active!)).toHaveLength(4);
  });

  it("rotation keeps the piece valid inside the field for a T piece", () => {
    let game = createGame(rng());
    // Force a T piece in a clean position.
    game = {
      ...game,
      active: { type: "T", rotation: 0, row: 5, col: 3 },
    };
    const rotated = tryRotate(game, 1);
    expect(rotated.active!.rotation).toBe(1);
    expect(isValid(rotated.board, rotated.active!)).toBe(true);
  });

  it("CCW rotation is the inverse of CW for a T piece", () => {
    let game = createGame(rng());
    game = { ...game, active: { type: "T", rotation: 0, row: 5, col: 3 } };
    const cw = tryRotate(game, 1);
    const back = tryRotate(cw, -1);
    expect(back.active!.rotation).toBe(0);
  });

  it("O piece rotation does not change occupied cells", () => {
    let game = createGame(rng());
    game = { ...game, active: { type: "O", rotation: 0, row: 5, col: 3 } };
    const before = cellsFor(game.active!).map(String).sort();
    const rotated = tryRotate(game, 1);
    const after = cellsFor(rotated.active!).map(String).sort();
    expect(after).toEqual(before);
  });
});

describe("collision & walls", () => {
  it("blocks horizontal move past the left wall", () => {
    let game = createGame(rng());
    game = { ...game, active: { type: "O", rotation: 0, row: 5, col: -1 } };
    // O occupies cols 1,2 of its box, so col -1 puts cells at 0,1 (valid).
    // Move further left should hit the wall eventually.
    let moved = game;
    for (let i = 0; i < 5; i++) moved = tryMove(moved, -1, 0);
    for (const [, c] of cellsFor(moved.active!)) {
      expect(c).toBeGreaterThanOrEqual(0);
    }
  });

  it("blocks horizontal move past the right wall", () => {
    let game = createGame(rng());
    game = { ...game, active: { type: "O", rotation: 0, row: 5, col: 3 } };
    let moved = game;
    for (let i = 0; i < 20; i++) moved = tryMove(moved, 1, 0);
    for (const [, c] of cellsFor(moved.active!)) {
      expect(c).toBeLessThan(COLS);
    }
  });

  it("rejects a piece overlapping a filled cell", () => {
    const board = emptyBoard();
    board[6][4] = "Z";
    const piece = { type: "O" as PieceType, rotation: 0 as const, row: 5, col: 3 };
    // O occupies (5,4),(5,5),(6,4),(6,5) -> (6,4) is filled.
    expect(isValid(board, piece)).toBe(false);
  });

  it("step locks the piece when it cannot move down further", () => {
    let game = createGame(rng());
    // Place an O just above the floor.
    game = { ...game, active: { type: "O", rotation: 0, row: TOTAL_ROWS - 2, col: 3 } };
    const after = step(game, rng());
    // Piece should have locked; a new active piece spawned at the top.
    expect(after.active!.row).toBeLessThan(5);
    // The bottom rows should now contain locked O cells.
    const filledBottom = after.board[TOTAL_ROWS - 1].some((c) => c !== null);
    expect(filledBottom).toBe(true);
  });
});

describe("line clears", () => {
  it("clears a single completed row and reports it", () => {
    const board = emptyBoard();
    const row = TOTAL_ROWS - 1;
    for (let c = 0; c < COLS; c++) board[row][c] = "I";
    const { board: cleared, cleared: rows } = clearLines(board);
    expect(rows).toEqual([row]);
    expect(cleared[row].every((c) => c === null)).toBe(true);
  });

  it("clears four rows simultaneously (a tetris)", () => {
    const board = emptyBoard();
    for (let r = TOTAL_ROWS - 4; r < TOTAL_ROWS; r++) {
      for (let c = 0; c < COLS; c++) board[r][c] = "I";
    }
    const { cleared } = clearLines(board);
    expect(cleared).toHaveLength(4);
  });

  it("does not clear an incomplete row", () => {
    const board = emptyBoard();
    fillRowExcept(board, TOTAL_ROWS - 1, 3);
    const { cleared } = clearLines(board);
    expect(cleared).toHaveLength(0);
  });

  it("locking a piece that completes a row increments the line counter", () => {
    let game = createGame(rng());
    const board = emptyBoard();
    // Fill the bottom row leaving a 1-wide gap at col 0 across two stacked cells
    // so a vertical placement can fill it. Simpler: fill bottom row except col 4-5
    // and drop an O there.
    fillRowExcept(board, TOTAL_ROWS - 1, 4);
    board[TOTAL_ROWS - 1][5] = null;
    game = {
      ...game,
      board,
      active: { type: "O", rotation: 0, row: TOTAL_ROWS - 2, col: 3 },
      lines: 0,
    };
    const after = lockPiece(game, rng());
    expect(after.lines).toBe(1);
  });
});

describe("scoring & level", () => {
  it("scores 100/300/500/800 times level for 1/2/3/4 lines", () => {
    expect(scoreForLines(1, 1)).toBe(100);
    expect(scoreForLines(2, 1)).toBe(300);
    expect(scoreForLines(3, 1)).toBe(500);
    expect(scoreForLines(4, 1)).toBe(800);
    expect(scoreForLines(4, 3)).toBe(2400);
  });

  it("zero lines scores zero", () => {
    expect(scoreForLines(0, 5)).toBe(0);
  });

  it("level increases every 10 lines", () => {
    expect(levelForLines(0)).toBe(1);
    expect(levelForLines(9)).toBe(1);
    expect(levelForLines(10)).toBe(2);
    expect(levelForLines(25)).toBe(3);
  });

  it("gravity gets faster as level rises", () => {
    expect(gravityMs(1)).toBeGreaterThan(gravityMs(5));
    expect(gravityMs(5)).toBeGreaterThan(gravityMs(10));
  });

  it("soft drop awards a point per cell", () => {
    let game = createGame(rng());
    game = { ...game, active: { type: "O", rotation: 0, row: 5, col: 3 }, score: 0 };
    const after = softDrop(game);
    expect(after.score).toBe(1);
    expect(after.active!.row).toBe(6);
  });

  it("hard drop awards two points per dropped cell and locks", () => {
    let game = createGame(rng());
    game = { ...game, board: emptyBoard(), active: { type: "O", rotation: 0, row: 0, col: 3 }, score: 0 };
    const after = hardDrop(game, rng());
    expect(after.score).toBeGreaterThan(0);
    // After lock, a new piece spawns at the top.
    expect(after.active!.row).toBeLessThan(5);
  });
});

describe("hold piece", () => {
  it("first hold stashes the current piece and pulls the next", () => {
    let game = createGame(rng());
    const current = game.active!.type;
    const after = holdPiece(game, rng());
    expect(after.hold).toBe(current);
    expect(after.canHold).toBe(false);
    expect(after.active).not.toBeNull();
  });

  it("does not allow holding twice in a row", () => {
    let game = createGame(rng());
    const once = holdPiece(game, rng());
    const twice = holdPiece(once, rng());
    expect(twice).toBe(once); // unchanged because canHold is false
  });
});

describe("ghost & top-out", () => {
  it("ghost row is at or below the active piece row", () => {
    let game = createGame(rng());
    game = { ...game, board: emptyBoard(), active: { type: "O", rotation: 0, row: 0, col: 3 } };
    const g = ghostRow(game);
    expect(g).not.toBeNull();
    expect(g!).toBeGreaterThanOrEqual(game.active!.row);
  });

  it("sets game over when a newly spawned piece collides", () => {
    let game = createGame(rng());
    const board = emptyBoard();
    // Fill the top rows so any spawn collides, but leave col 0 empty in each so
    // these rows are NOT complete lines (otherwise they would be cleared first).
    for (let r = 0; r < 4; r++) {
      for (let c = 1; c < COLS; c++) board[r][c] = "Z";
    }
    // Place an active piece low and lock it; the next spawn must top out.
    // First clear the bottom so lockPiece won't clear lines.
    game = {
      ...game,
      board,
      active: { type: "O", rotation: 0, row: 10, col: 3 },
    };
    const after = lockPiece(game, rng());
    expect(after.over).toBe(true);
    expect(after.active).toBeNull();
  });
});

describe("determinism", () => {
  it("two games with the same seed produce the same first piece", () => {
    const a = createGame(seededRng(99));
    const b = createGame(seededRng(99));
    expect(a.active!.type).toBe(b.active!.type);
    expect(a.queue).toEqual(b.queue);
  });
});
