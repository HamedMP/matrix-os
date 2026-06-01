// Pure, UI-free 2048 board engine. Deterministic with an injectable RNG.
// A board is a 4x4 grid of tile values; 0 represents an empty cell.

export const SIZE = 4;
export const WIN_VALUE = 2048;

export type Board = number[][];
export type Direction = "left" | "right" | "up" | "down";
export type Rng = () => number;

export interface MoveResult {
  board: Board;
  moved: boolean;
  gained: number;
}

export interface SpawnResult {
  board: Board;
  spawned: { row: number; col: number; value: number } | null;
}

export interface GameState {
  board: Board;
  score: number;
  won: boolean;
  over: boolean;
}

export function createEmptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 0));
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

export function countEmpty(board: Board): number {
  let n = 0;
  for (const row of board) {
    for (const cell of row) if (cell === 0) n += 1;
  }
  return n;
}

export function maxTile(board: Board): number {
  let m = 0;
  for (const row of board) for (const cell of row) if (cell > m) m = cell;
  return m;
}

export function hasWon(board: Board): boolean {
  return maxTile(board) >= WIN_VALUE;
}

// Slide + merge a single row to the left. Returns the new row and points gained.
function collapseRow(row: number[]): { row: number[]; gained: number } {
  const tiles = row.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i += 1) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const merged = tiles[i] * 2;
      out.push(merged);
      gained += merged;
      i += 1; // skip the consumed tile so it cannot merge again this move
    } else {
      out.push(tiles[i]);
    }
  }
  while (out.length < SIZE) out.push(0);
  return { row: out, gained };
}

function rowsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function transpose(board: Board): Board {
  const out = createEmptyBoard();
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      out[c][r] = board[r][c];
    }
  }
  return out;
}

function reverseRows(board: Board): Board {
  return board.map((row) => [...row].reverse());
}

// Move the board in `direction`. Pure: never mutates `board`.
export function move(board: Board, direction: Direction): MoveResult {
  let work = cloneBoard(board);

  // Normalize so we always collapse "to the left", then transform back.
  if (direction === "right") work = reverseRows(work);
  else if (direction === "up") work = transpose(work);
  else if (direction === "down") work = reverseRows(transpose(work));

  let gained = 0;
  const collapsed = work.map((row) => {
    const res = collapseRow(row);
    gained += res.gained;
    return res.row;
  });

  let result = collapsed;
  if (direction === "right") result = reverseRows(result);
  else if (direction === "up") result = transpose(result);
  else if (direction === "down") result = transpose(reverseRows(result));

  let moved = false;
  for (let r = 0; r < SIZE; r += 1) {
    if (!rowsEqual(result[r], board[r])) {
      moved = true;
      break;
    }
  }

  return { board: result, moved, gained };
}

export function emptyCells(board: Board): { row: number; col: number }[] {
  const cells: { row: number; col: number }[] = [];
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (board[r][c] === 0) cells.push({ row: r, col: c });
    }
  }
  return cells;
}

// Add a 2 (90%) or 4 (10%) to a random empty cell. Pure: returns a new board.
export function addRandomTile(board: Board, rng: Rng = Math.random): SpawnResult {
  const cells = emptyCells(board);
  if (cells.length === 0) return { board: cloneBoard(board), spawned: null };
  const idx = Math.min(cells.length - 1, Math.floor(rng() * cells.length));
  const { row, col } = cells[idx];
  const value = rng() < 0.9 ? 2 : 4;
  const next = cloneBoard(board);
  next[row][col] = value;
  return { board: next, spawned: { row, col, value } };
}

export function canMove(board: Board): boolean {
  if (countEmpty(board) > 0) return true;
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const v = board[r][c];
      if (c + 1 < SIZE && board[r][c + 1] === v) return true;
      if (r + 1 < SIZE && board[r + 1][c] === v) return true;
    }
  }
  return false;
}

export function isGameOver(board: Board): boolean {
  return !canMove(board);
}

export function newGame(rng: Rng = Math.random): GameState {
  let board = createEmptyBoard();
  board = addRandomTile(board, rng).board;
  board = addRandomTile(board, rng).board;
  return { board, score: 0, won: false, over: false };
}
