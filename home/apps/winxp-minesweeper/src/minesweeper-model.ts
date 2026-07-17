export type DifficultyId = "beginner" | "intermediate" | "expert";

export interface Difficulty {
  id: DifficultyId;
  label: string;
  rows: number;
  cols: number;
  mines: number;
}

export const DIFFICULTIES: readonly Difficulty[] = [
  { id: "beginner", label: "Beginner", rows: 9, cols: 9, mines: 10 },
  { id: "intermediate", label: "Intermediate", rows: 16, cols: 16, mines: 40 },
  { id: "expert", label: "Expert", rows: 16, cols: 30, mines: 99 },
];

export type Mark = "none" | "flag" | "question";

export interface Cell {
  mine: boolean;
  revealed: boolean;
  mark: Mark;
  adjacent: number;
  exploded: boolean;
  wrongFlag: boolean;
}

export type GameStatus = "ready" | "playing" | "won" | "lost";

export interface Game {
  difficulty: Difficulty;
  cells: Cell[];
  status: GameStatus;
  minesPlaced: boolean;
  startedAt: number | null;
  endedAt: number | null;
  flagsUsed: number;
}

export function createGame(difficulty: Difficulty): Game {
  return {
    difficulty,
    cells: Array.from({ length: difficulty.rows * difficulty.cols }, () => ({
      mine: false,
      revealed: false,
      mark: "none",
      adjacent: 0,
      exploded: false,
      wrongFlag: false,
    })),
    status: "ready",
    minesPlaced: false,
    startedAt: null,
    endedAt: null,
    flagsUsed: 0,
  };
}

export function neighborIndices(idx: number, rows: number, cols: number): number[] {
  const r = Math.floor(idx / cols);
  const c = idx % cols;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push(nr * cols + nc);
    }
  }
  return out;
}

function withMines(cells: Cell[], mines: number, safeIdx: number, rows: number, cols: number): Cell[] {
  const safe = new Set<number>([safeIdx, ...neighborIndices(safeIdx, rows, cols)]);
  const candidates: number[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    if (!safe.has(i)) candidates.push(i);
  }
  // Fisher-Yates shuffle of candidate positions.
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
  }
  const mined = new Set(candidates.slice(0, Math.min(mines, candidates.length)));
  return cells.map((cell, i) => ({ ...cell, mine: mined.has(i) }));
}

function withAdjacency(cells: Cell[], rows: number, cols: number): Cell[] {
  return cells.map((cell, i) => {
    if (cell.mine) return cell;
    const adjacent = neighborIndices(i, rows, cols).filter((n) => cells[n].mine).length;
    return { ...cell, adjacent };
  });
}

function floodReveal(cells: Cell[], start: number, rows: number, cols: number): Cell[] {
  const next = cells.map((cell) => ({ ...cell }));
  const stack = [start];
  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const cell = next[idx];
    if (cell.revealed || cell.mark === "flag") continue;
    cell.revealed = true;
    if (cell.adjacent === 0 && !cell.mine) {
      for (const n of neighborIndices(idx, rows, cols)) {
        if (!next[n].revealed && !next[n].mine) stack.push(n);
      }
    }
  }
  return next;
}

function finishIfWon(game: Game): Game {
  const won = game.cells.every((cell) => cell.mine || cell.revealed);
  if (!won) return game;
  // Classic behavior: flag every remaining mine so the counter reads 000.
  const cells = game.cells.map((cell) =>
    cell.mine && !cell.revealed ? { ...cell, mark: "flag" as Mark } : cell,
  );
  return { ...game, cells, status: "won", endedAt: Date.now(), flagsUsed: game.difficulty.mines };
}

export function revealCell(game: Game, idx: number): Game {
  if (game.status === "won" || game.status === "lost") return game;
  const { rows, cols, mines } = game.difficulty;
  let cells = game.cells;
  let minesPlaced = game.minesPlaced;
  let startedAt = game.startedAt;
  if (!minesPlaced) {
    cells = withAdjacency(withMines(cells, mines, idx, rows, cols), rows, cols);
    minesPlaced = true;
    startedAt = Date.now();
  }
  const cell = cells[idx];
  if (cell.revealed || cell.mark === "flag") {
    return { ...game, cells, minesPlaced, startedAt };
  }
  if (cell.mine) {
    const lost = cells.map((c, i) => ({
      ...c,
      revealed: c.mine ? true : c.revealed,
      exploded: i === idx,
      wrongFlag: !c.mine && c.mark === "flag",
    }));
    return { ...game, cells: lost, status: "lost", minesPlaced, startedAt, endedAt: Date.now() };
  }
  const opened = floodReveal(cells, idx, rows, cols);
  return finishIfWon({ ...game, cells: opened, status: "playing", minesPlaced, startedAt });
}

export function cycleMark(game: Game, idx: number): Game {
  if (game.status === "won" || game.status === "lost") return game;
  const cell = game.cells[idx];
  if (cell.revealed) return game;
  const nextMark: Mark = cell.mark === "none" ? "flag" : cell.mark === "flag" ? "question" : "none";
  const cells = game.cells.map((c, i) => (i === idx ? { ...c, mark: nextMark } : c));
  const flagsUsed = game.flagsUsed + (nextMark === "flag" ? 1 : 0) - (cell.mark === "flag" ? 1 : 0);
  return { ...game, cells, flagsUsed };
}

/** Chord: clicking a revealed number whose flag count matches reveals its neighbors. */
export function chordCell(game: Game, idx: number): Game {
  if (game.status !== "playing" && game.status !== "ready") return game;
  const cell = game.cells[idx];
  if (!cell.revealed || cell.adjacent === 0) return game;
  const { rows, cols } = game.difficulty;
  const neighbors = neighborIndices(idx, rows, cols);
  const flags = neighbors.filter((n) => game.cells[n].mark === "flag").length;
  if (flags !== cell.adjacent) return game;
  let next = game;
  for (const n of neighbors) {
    if (next.cells[n].revealed || next.cells[n].mark === "flag") continue;
    next = revealCell(next, n);
    if (next.status === "lost") return next;
  }
  return next;
}

export function elapsedSeconds(game: Game, now: number): number {
  if (game.startedAt === null) return 0;
  const end = game.endedAt ?? now;
  return Math.min(999, Math.max(0, Math.floor((end - game.startedAt) / 1000)));
}

export function minesRemaining(game: Game): number {
  return game.difficulty.mines - game.flagsUsed;
}

export type BestTimes = Partial<Record<DifficultyId, number>>;

export function parseBestTimes(value: unknown): BestTimes {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const out: BestTimes = {};
  for (const { id } of DIFFICULTIES) {
    const raw = record[id];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 999) {
      out[id] = Math.floor(raw);
    }
  }
  return out;
}
