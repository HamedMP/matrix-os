// Pure, UI-free Snake engine. Deterministic given an injectable RNG.

export const GRID_COLS = 20;
export const GRID_ROWS = 20;

export type Direction = "up" | "down" | "left" | "right";
export type Status = "ready" | "running" | "paused" | "over" | "won";

export interface Cell {
  x: number;
  y: number;
}

export interface GameState {
  snake: Cell[]; // head is index 0
  direction: Direction; // current heading (the one applied last tick)
  nextDir: Direction; // queued heading from input, applied at next step
  food: Cell;
  score: number;
  status: Status;
}

export type Rng = () => number;

const DELTAS: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

export function isOpposite(a: Direction, b: Direction): boolean {
  return OPPOSITE[a] === b;
}

/**
 * Resolve the direction the snake should head, rejecting a 180-degree
 * reversal relative to its current heading.
 */
export function nextDirection(current: Direction, requested: Direction): Direction {
  if (isOpposite(current, requested)) return current;
  return requested;
}

export function queuedDirection(current: Direction, queued: Direction, requested: Direction): Direction {
  if (requested === current) return queued;
  if (isOpposite(current, requested) || isOpposite(queued, requested)) return queued;
  return requested;
}

/** Pick a uniformly random free cell, or null if the board is full. */
export function spawnFood(snake: Cell[], rng: Rng): Cell | null {
  const occupied = new Set(snake.map((c) => `${c.x},${c.y}`));
  const free: Cell[] = [];
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < GRID_COLS; x++) {
      if (!occupied.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  if (free.length === 0) return null;
  const idx = Math.min(free.length - 1, Math.floor(rng() * free.length));
  return free[idx];
}

/** Tick interval in milliseconds; gets faster as the score rises. */
export function speedForScore(score: number): number {
  const base = 140;
  const min = 60;
  const stepDown = Math.floor(score / 4) * 8;
  return Math.max(min, base - stepDown);
}

/** Build a fresh game with a centered length-3 snake heading right. */
export function createGame(rng: Rng): GameState {
  const cy = Math.floor(GRID_ROWS / 2);
  const cx = Math.floor(GRID_COLS / 2);
  const snake: Cell[] = [
    { x: cx, y: cy },
    { x: cx - 1, y: cy },
    { x: cx - 2, y: cy },
  ];
  const food = spawnFood(snake, rng) ?? { x: 0, y: 0 };
  return {
    snake,
    direction: "right",
    nextDir: "right",
    food,
    score: 0,
    status: "ready",
  };
}

function outOfBounds(cell: Cell): boolean {
  return cell.x < 0 || cell.y < 0 || cell.x >= GRID_COLS || cell.y >= GRID_ROWS;
}

/**
 * Advance the game by one tick. Returns a new state; never mutates the input.
 * Only advances when status is "running".
 */
export function step(state: GameState, rng: Rng): GameState {
  if (state.status !== "running") return state;

  const direction = nextDirection(state.direction, state.nextDir);
  const delta = DELTAS[direction];
  const head = state.snake[0];
  const newHead: Cell = { x: head.x + delta.x, y: head.y + delta.y };

  if (outOfBounds(newHead)) {
    return { ...state, direction, status: "over" };
  }

  const eating = newHead.x === state.food.x && newHead.y === state.food.y;

  // Body that will persist after the move. When not eating, the tail moves,
  // so the last cell is free to step into (classic snake rule).
  const body = eating ? state.snake : state.snake.slice(0, -1);
  const hitSelf = body.some((c) => c.x === newHead.x && c.y === newHead.y);
  if (hitSelf) {
    return { ...state, direction, status: "over" };
  }

  const newSnake = [newHead, ...body];

  if (!eating) {
    return { ...state, snake: newSnake, direction };
  }

  const score = state.score + 1;
  const nextFood = spawnFood(newSnake, rng);
  if (nextFood === null) {
    // Board completely filled — perfect game.
    return { ...state, snake: newSnake, direction, score, status: "won" };
  }
  return { ...state, snake: newSnake, direction, food: nextFood, score };
}
