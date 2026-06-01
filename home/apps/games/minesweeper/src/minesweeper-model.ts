// Pure, UI-free Minesweeper engine. Deterministic given an injectable RNG.
// All board operations return a NEW board (no in-place mutation of inputs).

export const CELL = {
  HIDDEN: "hidden",
  REVEALED: "revealed",
  FLAGGED: "flagged",
  EXPLODED: "exploded",
} as const;

export type CellState = (typeof CELL)[keyof typeof CELL];

export type GameStatus = "ready" | "playing" | "won" | "lost";

export interface Cell {
  mine: boolean;
  adjacent: number; // count of neighboring mines
  state: CellState;
}

export interface Board {
  rows: number;
  cols: number;
  mines: number;
  status: GameStatus;
  cells: Cell[][];
}

export type Difficulty = "beginner" | "intermediate" | "expert" | "custom";

export interface DifficultySpec {
  rows: number;
  cols: number;
  mines: number;
}

// Classic Windows Minesweeper geometries. Expert is 30 wide x 16 tall.
export function difficultyConfig(difficulty: Exclude<Difficulty, "custom">): DifficultySpec {
  switch (difficulty) {
    case "beginner":
      return { rows: 9, cols: 9, mines: 10 };
    case "intermediate":
      return { rows: 16, cols: 16, mines: 40 };
    case "expert":
      return { rows: 16, cols: 30, mines: 99 };
  }
}

export function clampCustom(spec: DifficultySpec): DifficultySpec {
  const rows = Math.max(5, Math.min(30, Math.floor(spec.rows) || 9));
  const cols = Math.max(5, Math.min(48, Math.floor(spec.cols) || 9));
  // At least one safe cell + its 8 neighbors must remain mine-free.
  const maxMines = Math.max(1, rows * cols - 9);
  const mines = Math.max(1, Math.min(maxMines, Math.floor(spec.mines) || 10));
  return { rows, cols, mines };
}

function emptyCell(): Cell {
  return { mine: false, adjacent: 0, state: CELL.HIDDEN };
}

export function createBoard(spec: DifficultySpec): Board {
  const { rows, cols, mines } = spec;
  const cells: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => emptyCell()),
  );
  return { rows, cols, mines, status: "ready", cells };
}

export function inBounds(r: number, c: number, rows: number, cols: number): boolean {
  return r >= 0 && r < rows && c >= 0 && c < cols;
}

export function neighbors(r: number, c: number, rows: number, cols: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds(nr, nc, rows, cols)) out.push([nr, nc]);
    }
  }
  return out;
}

// Choose `mines` distinct flat indices in [0, rows*cols), excluding `forbidden`.
export function generateMines(
  rows: number,
  cols: number,
  mines: number,
  forbidden: Set<number>,
  rng: () => number = Math.random,
): Set<number> {
  const total = rows * cols;
  const available = total - forbidden.size;
  const count = Math.max(0, Math.min(mines, available));
  const picked = new Set<number>();
  // Rejection sampling; fall back to a deterministic scan if RNG is degenerate.
  let guard = 0;
  const maxGuard = total * 50;
  while (picked.size < count && guard < maxGuard) {
    const idx = Math.floor(rng() * total) % total;
    guard += 1;
    if (forbidden.has(idx) || picked.has(idx)) continue;
    picked.add(idx);
  }
  if (picked.size < count) {
    for (let idx = 0; idx < total && picked.size < count; idx += 1) {
      if (!forbidden.has(idx) && !picked.has(idx)) picked.add(idx);
    }
  }
  return picked;
}

function computeAdjacency(cells: Cell[][], rows: number, cols: number): void {
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (cells[r][c].mine) {
        cells[r][c].adjacent = 0;
        continue;
      }
      let count = 0;
      for (const [nr, nc] of neighbors(r, c, rows, cols)) {
        if (cells[nr][nc].mine) count += 1;
      }
      cells[r][c].adjacent = count;
    }
  }
}

function cloneCells(cells: Cell[][]): Cell[][] {
  return cells.map((row) => row.map((c) => ({ ...c })));
}

// Place mines for a board, guaranteeing the first-click cell and its neighbors are safe.
export function placeMinesAvoiding(
  board: Board,
  safeR: number,
  safeC: number,
  rng: () => number = Math.random,
): Board {
  const { rows, cols, mines } = board;
  const forbidden = new Set<number>();
  forbidden.add(safeR * cols + safeC);
  for (const [nr, nc] of neighbors(safeR, safeC, rows, cols)) {
    forbidden.add(nr * cols + nc);
  }
  const minePositions = generateMines(rows, cols, mines, forbidden, rng);
  const cells = cloneCells(board.cells);
  for (const idx of minePositions) {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    cells[r][c].mine = true;
  }
  computeAdjacency(cells, rows, cols);
  return { ...board, cells, status: board.status === "ready" ? "playing" : board.status };
}

function floodReveal(cells: Cell[][], r: number, c: number, rows: number, cols: number): void {
  const stack: Array<[number, number]> = [[r, c]];
  while (stack.length > 0) {
    const [cr, cc] = stack.pop() as [number, number];
    const cell = cells[cr][cc];
    if (cell.state === CELL.REVEALED || cell.state === CELL.FLAGGED) continue;
    if (cell.mine) continue;
    cell.state = CELL.REVEALED;
    if (cell.adjacent === 0) {
      for (const [nr, nc] of neighbors(cr, cc, rows, cols)) {
        const ncell = cells[nr][nc];
        if (ncell.state === CELL.HIDDEN && !ncell.mine) stack.push([nr, nc]);
      }
    }
  }
}

function exposeAllMines(cells: Cell[][]): void {
  for (const row of cells) {
    for (const cell of row) {
      if (cell.mine && cell.state !== CELL.EXPLODED && cell.state !== CELL.FLAGGED) {
        cell.state = CELL.REVEALED;
      }
    }
  }
}

function checkWin(board: Board): Board {
  // Win when every non-mine cell is revealed.
  for (const row of board.cells) {
    for (const cell of row) {
      if (!cell.mine && cell.state !== CELL.REVEALED) return board;
    }
  }
  // Auto-flag all mines on win.
  const cells = cloneCells(board.cells);
  for (const row of cells) {
    for (const cell of row) {
      if (cell.mine) cell.state = CELL.FLAGGED;
    }
  }
  return { ...board, cells, status: "won" };
}

export function reveal(board: Board, r: number, c: number, rng: () => number = Math.random): Board {
  if (board.status === "won" || board.status === "lost") return board;
  if (!inBounds(r, c, board.rows, board.cols)) return board;
  const initial = board.cells[r][c];
  if (initial.state === CELL.FLAGGED || initial.state === CELL.REVEALED) return board;

  // Lazily place mines on the first reveal so the first click is always safe.
  let working = board;
  if (working.status === "ready") {
    working = placeMinesAvoiding(working, r, c, rng);
  }

  const target = working.cells[r][c];
  if (target.state === CELL.FLAGGED || target.state === CELL.REVEALED) return working;

  const cells = cloneCells(working.cells);
  const hit = cells[r][c];

  if (hit.mine) {
    hit.state = CELL.EXPLODED;
    exposeAllMines(cells);
    return { ...working, cells, status: "lost" };
  }

  floodReveal(cells, r, c, working.rows, working.cols);
  const next: Board = { ...working, cells, status: "playing" };
  return checkWin(next);
}

export function toggleFlag(board: Board, r: number, c: number): Board {
  if (board.status === "won" || board.status === "lost") return board;
  if (!inBounds(r, c, board.rows, board.cols)) return board;
  const cell = board.cells[r][c];
  if (cell.state === CELL.REVEALED || cell.state === CELL.EXPLODED) return board;
  const cells = cloneCells(board.cells);
  cells[r][c].state = cell.state === CELL.FLAGGED ? CELL.HIDDEN : CELL.FLAGGED;
  return { ...board, cells };
}

// Chord: when clicking a revealed number whose adjacent flags equal its value,
// reveal all non-flagged neighbors (which loses the game if a flag is wrong).
export function chord(board: Board, r: number, c: number, rng: () => number = Math.random): Board {
  if (board.status === "won" || board.status === "lost") return board;
  if (!inBounds(r, c, board.rows, board.cols)) return board;
  const cell = board.cells[r][c];
  if (cell.state !== CELL.REVEALED || cell.adjacent === 0) return board;

  const ns = neighbors(r, c, board.rows, board.cols);
  let flagged = 0;
  for (const [nr, nc] of ns) {
    if (board.cells[nr][nc].state === CELL.FLAGGED) flagged += 1;
  }
  if (flagged !== cell.adjacent) return board;

  let working = board;
  for (const [nr, nc] of ns) {
    const ncell = working.cells[nr][nc];
    if (ncell.state === CELL.HIDDEN) {
      working = reveal(working, nr, nc, rng);
      if (working.status === "lost") return working;
    }
  }
  return working;
}

export function flagsPlaced(board: Board): number {
  let n = 0;
  for (const row of board.cells) for (const c of row) if (c.state === CELL.FLAGGED) n += 1;
  return n;
}

export function minesRemaining(board: Board): number {
  return board.mines - flagsPlaced(board);
}

export function isWon(board: Board): boolean {
  return board.status === "won";
}

export function isLost(board: Board): boolean {
  return board.status === "lost";
}
