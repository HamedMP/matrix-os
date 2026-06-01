// Pure, UI-free Tetris engine. Deterministic with an injectable RNG / bag.
// Guideline-style: 10x20 visible field, 7-bag randomizer, SRS rotation with
// basic wall kicks, lock, line clears, scoring, levels, top-out.

export const COLS = 10;
export const ROWS = 20;
// Two hidden rows above the visible field where pieces spawn.
export const HIDDEN_ROWS = 2;
export const TOTAL_ROWS = ROWS + HIDDEN_ROWS;

export type PieceType = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

export const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];

// Guideline tetromino colors.
export const PIECE_COLORS: Record<PieceType, string> = {
  I: "#3FC4D6", // cyan
  O: "#F2C94C", // yellow
  T: "#A064D4", // purple
  S: "#52C26B", // green
  Z: "#E5564B", // red
  J: "#4C7DE0", // blue
  L: "#E58A3C", // orange
};

// Cell value: null = empty, otherwise the PieceType that occupies it (for color).
export type Cell = PieceType | null;
export type Board = Cell[][];

// Rotation states 0..3. Each piece is described by the filled cell offsets in
// a local box. We use canonical SRS spawn shapes.
type Offsets = ReadonlyArray<readonly [number, number]>;

// Each piece: rotation state -> list of [row, col] offsets within a 4x4 (I) or
// 3x3 (others) bounding box. O is rotation-invariant.
const SHAPES: Record<PieceType, ReadonlyArray<Offsets>> = {
  I: [
    [[1, 0], [1, 1], [1, 2], [1, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 1], [1, 1], [2, 1], [3, 1]],
  ],
  O: [
    [[0, 1], [0, 2], [1, 1], [1, 2]],
    [[0, 1], [0, 2], [1, 1], [1, 2]],
    [[0, 1], [0, 2], [1, 1], [1, 2]],
    [[0, 1], [0, 2], [1, 1], [1, 2]],
  ],
  T: [
    [[0, 1], [1, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 1]],
    [[0, 1], [1, 0], [1, 1], [2, 1]],
  ],
  S: [
    [[0, 1], [0, 2], [1, 0], [1, 1]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 1], [1, 2], [2, 0], [2, 1]],
    [[0, 0], [1, 0], [1, 1], [2, 1]],
  ],
  Z: [
    [[0, 0], [0, 1], [1, 1], [1, 2]],
    [[0, 2], [1, 1], [1, 2], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[0, 1], [1, 0], [1, 1], [2, 0]],
  ],
  J: [
    [[0, 0], [1, 0], [1, 1], [1, 2]],
    [[0, 1], [0, 2], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 0], [2, 1]],
  ],
  L: [
    [[0, 2], [1, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [1, 2], [2, 0]],
    [[0, 0], [0, 1], [1, 1], [2, 1]],
  ],
};

// SRS wall-kick offsets. JLSTZ share one table, I has its own. Index by
// from->to transition. Each entry is the ordered list of [dx, dy] to try
// (dx = column shift, dy = row shift; positive dy = downward).
type KickKey = `${0 | 1 | 2 | 3}>${0 | 1 | 2 | 3}`;

type KickTable = Partial<Record<KickKey, ReadonlyArray<readonly [number, number]>>>;

const KICKS_JLSTZ: KickTable = {
  "0>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "1>0": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "1>2": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "2>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "2>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "3>2": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "3>0": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "0>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};

const KICKS_I: KickTable = {
  "0>1": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  "1>0": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  "1>2": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  "2>1": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  "2>3": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  "3>2": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  "3>0": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  "0>3": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};

export interface ActivePiece {
  type: PieceType;
  rotation: 0 | 1 | 2 | 3;
  row: number; // top-left of bounding box, in TOTAL_ROWS coordinates
  col: number;
}

export interface GameState {
  board: Board; // TOTAL_ROWS x COLS, includes hidden rows at the top
  active: ActivePiece | null;
  queue: PieceType[]; // upcoming pieces (next-queue preview)
  bag: PieceType[]; // remaining pieces in the current 7-bag
  hold: PieceType | null;
  canHold: boolean;
  score: number;
  lines: number;
  level: number;
  over: boolean;
  // Transient: rows cleared on the most recent lock (for animation).
  lastCleared: number[];
}

export type Rng = () => number;

export function createBoard(): Board {
  return Array.from({ length: TOTAL_ROWS }, () => Array<Cell>(COLS).fill(null));
}

// Fisher-Yates shuffle of the 7 pieces using an injectable RNG.
export function newBag(rng: Rng = Math.random): PieceType[] {
  const bag = [...PIECES];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

// Pull the next piece from the bag, refilling from a fresh 7-bag when empty.
export function nextFromBag(
  bag: PieceType[],
  rng: Rng = Math.random,
): { piece: PieceType; bag: PieceType[] } {
  let working = bag.length > 0 ? [...bag] : newBag(rng);
  const piece = working[0];
  working = working.slice(1);
  return { piece, bag: working };
}

// Absolute cells a piece occupies, in TOTAL_ROWS coordinates.
export function cellsFor(piece: ActivePiece): Array<[number, number]> {
  const shape = SHAPES[piece.type][piece.rotation];
  return shape.map(([dr, dc]) => [piece.row + dr, piece.col + dc]);
}

export function isValid(board: Board, piece: ActivePiece): boolean {
  for (const [r, c] of cellsFor(piece)) {
    if (c < 0 || c >= COLS) return false;
    if (r < 0 || r >= TOTAL_ROWS) return false;
    if (board[r][c] !== null) return false;
  }
  return true;
}

function spawnPiece(type: PieceType): ActivePiece {
  // Spawn horizontally centered. Row HIDDEN_ROWS-1 straddles the hidden/visible
  // boundary so the piece's lower cells are immediately visible at the top of
  // the playfield while still leaving a hidden row for top-out detection.
  return { type, rotation: 0, row: HIDDEN_ROWS - 1, col: 3 };
}

const PREVIEW_COUNT = 5;

function ensureQueue(
  queue: PieceType[],
  bag: PieceType[],
  rng: Rng,
): { queue: PieceType[]; bag: PieceType[] } {
  let q = [...queue];
  let b = [...bag];
  while (q.length < PREVIEW_COUNT) {
    const pulled = nextFromBag(b, rng);
    q.push(pulled.piece);
    b = pulled.bag;
  }
  return { queue: q, bag: b };
}

export function createGame(rng: Rng = Math.random): GameState {
  const filled = ensureQueue([], newBag(rng), rng);
  const first = filled.queue[0];
  const queue = filled.queue.slice(1);
  const refilled = ensureQueue(queue, filled.bag, rng);
  const active = spawnPiece(first);
  return {
    board: createBoard(),
    active,
    queue: refilled.queue,
    bag: refilled.bag,
    hold: null,
    canHold: true,
    score: 0,
    lines: 0,
    level: 1,
    over: false,
    lastCleared: [],
  };
}

// Take the next piece from the queue and refill from the bag.
function pullNext(
  state: GameState,
  rng: Rng,
): { type: PieceType; queue: PieceType[]; bag: PieceType[] } {
  const type = state.queue[0];
  const rest = state.queue.slice(1);
  const refilled = ensureQueue(rest, state.bag, rng);
  return { type, queue: refilled.queue, bag: refilled.bag };
}

export function tryMove(state: GameState, dCol: number, dRow: number): GameState {
  if (state.over || !state.active) return state;
  const moved: ActivePiece = {
    ...state.active,
    col: state.active.col + dCol,
    row: state.active.row + dRow,
  };
  if (isValid(state.board, moved)) {
    return { ...state, active: moved };
  }
  return state;
}

export function tryRotate(state: GameState, dir: 1 | -1): GameState {
  if (state.over || !state.active) return state;
  const piece = state.active;
  if (piece.type === "O") return state; // O does not rotate visibly
  const from = piece.rotation;
  const to = (((from + dir) % 4) + 4) % 4 as 0 | 1 | 2 | 3;
  const key = `${from}>${to}` as KickKey;
  const table = piece.type === "I" ? KICKS_I : KICKS_JLSTZ;
  const kicks = table[key] ?? [[0, 0]];
  for (const [dx, dy] of kicks) {
    const candidate: ActivePiece = {
      ...piece,
      rotation: to,
      col: piece.col + dx,
      row: piece.row + dy,
    };
    if (isValid(state.board, candidate)) {
      return { ...state, active: candidate };
    }
  }
  return state;
}

// Scan board, remove full rows, return the cleared row indices and a new board.
export function clearLines(board: Board): { board: Board; cleared: number[] } {
  const cleared: number[] = [];
  for (let r = 0; r < TOTAL_ROWS; r++) {
    if (board[r].every((cell) => cell !== null)) cleared.push(r);
  }
  if (cleared.length === 0) return { board, cleared };
  const kept = board.filter((_, r) => !cleared.includes(r));
  const newRows = Array.from({ length: cleared.length }, () => Array<Cell>(COLS).fill(null));
  return { board: [...newRows, ...kept], cleared };
}

// Guideline-ish line scoring per the cleared count and current level.
const LINE_SCORE = [0, 100, 300, 500, 800];

export function scoreForLines(count: number, level: number): number {
  const base = LINE_SCORE[Math.min(count, 4)] ?? 0;
  return base * level;
}

export function levelForLines(lines: number): number {
  return Math.floor(lines / 10) + 1;
}

// Gravity interval in milliseconds for a given level (classic-ish curve).
export function gravityMs(level: number): number {
  const table = [0, 800, 720, 630, 550, 470, 380, 300, 220, 130, 100, 80, 80, 70, 70, 50];
  return table[Math.min(level, table.length - 1)] ?? 50;
}

// Settle the active piece into the board, clear lines, update score/level, and
// spawn the next piece. Sets `over` on top-out.
export function lockPiece(state: GameState, rng: Rng = Math.random): GameState {
  if (!state.active || state.over) return state;
  const board = state.board.map((row) => [...row]);
  for (const [r, c] of cellsFor(state.active)) {
    if (r >= 0 && r < TOTAL_ROWS && c >= 0 && c < COLS) {
      board[r][c] = state.active.type;
    }
  }
  const { board: clearedBoard, cleared } = clearLines(board);
  const lines = state.lines + cleared.length;
  const level = levelForLines(lines);
  const score = state.score + scoreForLines(cleared.length, state.level);

  const { type, queue, bag } = pullNext(state, rng);
  const next = spawnPiece(type);

  // Top-out: if the freshly spawned piece overlaps existing blocks.
  if (!isValid(clearedBoard, next)) {
    return {
      ...state,
      board: clearedBoard,
      active: null,
      queue,
      bag,
      score,
      lines,
      level,
      canHold: true,
      over: true,
      lastCleared: cleared,
    };
  }

  return {
    ...state,
    board: clearedBoard,
    active: next,
    queue,
    bag,
    score,
    lines,
    level,
    canHold: true,
    over: false,
    lastCleared: cleared,
  };
}

// Apply one gravity step: move down if possible, otherwise lock.
export function step(state: GameState, rng: Rng = Math.random): GameState {
  if (state.over || !state.active) return state;
  const moved: ActivePiece = { ...state.active, row: state.active.row + 1 };
  if (isValid(state.board, moved)) {
    return { ...state, active: moved };
  }
  return lockPiece(state, rng);
}

// Soft drop: move down one, award 1 point per cell if it moved.
export function softDrop(state: GameState): GameState {
  if (state.over || !state.active) return state;
  const moved: ActivePiece = { ...state.active, row: state.active.row + 1 };
  if (isValid(state.board, moved)) {
    return { ...state, active: moved, score: state.score + 1 };
  }
  return state;
}

// Hard drop: drop to the bottom, award 2 points per cell, then lock.
export function hardDrop(state: GameState, rng: Rng = Math.random): GameState {
  if (state.over || !state.active) return state;
  let piece = state.active;
  let dropped = 0;
  while (true) {
    const moved: ActivePiece = { ...piece, row: piece.row + 1 };
    if (!isValid(state.board, moved)) break;
    piece = moved;
    dropped++;
  }
  const withPiece: GameState = {
    ...state,
    active: piece,
    score: state.score + dropped * 2,
  };
  return lockPiece(withPiece, rng);
}

// Hold the current piece, swapping with a previously held one if present.
export function holdPiece(state: GameState, rng: Rng = Math.random): GameState {
  if (state.over || !state.active || !state.canHold) return state;
  const current = state.active.type;
  if (state.hold === null) {
    const { type, queue, bag } = pullNext(state, rng);
    const next = spawnPiece(type);
    return {
      ...state,
      active: isValid(state.board, next) ? next : next,
      hold: current,
      queue,
      bag,
      canHold: false,
    };
  }
  const swapped = spawnPiece(state.hold);
  return {
    ...state,
    active: swapped,
    hold: current,
    canHold: false,
  };
}

// Ghost piece position (where the active piece would hard-drop to).
export function ghostRow(state: GameState): number | null {
  if (!state.active) return null;
  let piece = state.active;
  while (true) {
    const moved: ActivePiece = { ...piece, row: piece.row + 1 };
    if (!isValid(state.board, moved)) break;
    piece = moved;
  }
  return piece.row;
}

// A seedable RNG for deterministic tests / reproducible games (mulberry32).
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
