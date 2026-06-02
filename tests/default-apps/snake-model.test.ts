import { describe, expect, it } from "vitest";
import {
  GRID_COLS,
  GRID_ROWS,
  createGame,
  isOpposite,
  nextDirection,
  queuedDirection,
  spawnFood,
  speedForScore,
  step,
  type Direction,
  type GameState,
} from "../../home/apps/games/snake/src/snake-model";

// Deterministic RNG helper: cycles through provided values then 0.
function seededRng(values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0);
}

describe("snake-model: direction", () => {
  it("detects opposite directions (180-degree reversal)", () => {
    expect(isOpposite("up", "down")).toBe(true);
    expect(isOpposite("down", "up")).toBe(true);
    expect(isOpposite("left", "right")).toBe(true);
    expect(isOpposite("right", "left")).toBe(true);
    expect(isOpposite("up", "left")).toBe(false);
    expect(isOpposite("up", "up")).toBe(false);
  });

  it("prevents 180-degree reversal via nextDirection", () => {
    expect(nextDirection("right", "left")).toBe("right");
    expect(nextDirection("right", "up")).toBe("up");
    expect(nextDirection("up", "down")).toBe("up");
    expect(nextDirection("up", "right")).toBe("right");
  });

  it("does not clobber an already queued turn with its opposite", () => {
    expect(queuedDirection("right", "up", "down")).toBe("up");
    expect(queuedDirection("right", "right", "left")).toBe("right");
    expect(queuedDirection("right", "up", "left")).toBe("up");
    expect(queuedDirection("right", "right", "up")).toBe("up");
  });

  it("does not clobber an already queued turn with the current heading", () => {
    expect(queuedDirection("right", "up", "right")).toBe("up");
    expect(queuedDirection("up", "left", "up")).toBe("left");
  });
});

describe("snake-model: createGame", () => {
  it("creates a centered snake of length 3 moving right with score 0", () => {
    const game = createGame(seededRng([0.5, 0.5]));
    expect(game.snake.length).toBe(3);
    expect(game.direction).toBe("right");
    expect(game.score).toBe(0);
    expect(game.status).toBe("ready");
    expect(game.food).toBeTruthy();
  });

  it("never spawns food on the snake", () => {
    const game = createGame(seededRng([0, 0]));
    const onSnake = game.snake.some((c) => c.x === game.food.x && c.y === game.food.y);
    expect(onSnake).toBe(false);
  });
});

describe("snake-model: step movement", () => {
  it("moves the head one cell in the current direction and keeps length when no food", () => {
    const game = createGame(seededRng([0.9, 0.9]));
    const head = game.snake[0];
    const running: GameState = { ...game, status: "running" };
    const next = step(running, seededRng([0.9, 0.9]));
    expect(next.snake[0]).toEqual({ x: head.x + 1, y: head.y });
    expect(next.snake.length).toBe(game.snake.length);
    expect(next.status).toBe("running");
  });

  it("does not advance when not running", () => {
    const game = createGame(seededRng([0.5, 0.5]));
    const next = step(game, seededRng([0.5, 0.5]));
    expect(next).toEqual(game);
  });
});

describe("snake-model: growth on food", () => {
  it("grows the snake and increments score when eating food", () => {
    const base = createGame(seededRng([0.5, 0.5]));
    const head = base.snake[0];
    // Place food directly in front of the head.
    const running: GameState = {
      ...base,
      status: "running",
      food: { x: head.x + 1, y: head.y },
    };
    const next = step(running, seededRng([0.95, 0.95]));
    expect(next.snake.length).toBe(base.snake.length + 1);
    expect(next.score).toBe(base.score + 1);
    // A new food is placed somewhere not on the snake.
    const onSnake = next.snake.some((c) => c.x === next.food.x && c.y === next.food.y);
    expect(onSnake).toBe(false);
  });
});

describe("snake-model: collisions", () => {
  it("ends the game on wall collision", () => {
    const head = { x: GRID_COLS - 1, y: 2 };
    const running: GameState = {
      snake: [head, { x: GRID_COLS - 2, y: 2 }, { x: GRID_COLS - 3, y: 2 }],
      direction: "right",
      nextDir: "right",
      food: { x: 0, y: 0 },
      score: 0,
      status: "running",
    };
    const next = step(running, seededRng([0.5, 0.5]));
    expect(next.status).toBe("over");
  });

  it("ends the game on self collision", () => {
    // Snake shaped so that moving down folds onto its own body.
    const snake = [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 4, y: 6 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
    ];
    const running: GameState = {
      snake,
      direction: "right",
      nextDir: "down",
      food: { x: 0, y: 0 },
      score: 0,
      status: "running",
    };
    const next = step(running, seededRng([0.5, 0.5]));
    expect(next.status).toBe("over");
  });

  it("applies the queued direction before moving", () => {
    const base = createGame(seededRng([0.9, 0.9]));
    const queued: GameState = { ...base, status: "running", nextDir: "up" };
    const next = step(queued, seededRng([0.9, 0.9]));
    expect(next.direction).toBe("up");
    expect(next.snake[0].y).toBe(base.snake[0].y - 1);
  });
});

describe("snake-model: speed", () => {
  it("returns faster (smaller) tick interval as score rises", () => {
    const slow = speedForScore(0);
    const fast = speedForScore(50);
    expect(fast).toBeLessThan(slow);
    expect(fast).toBeGreaterThan(0);
  });
});

describe("snake-model: spawnFood", () => {
  it("returns a free cell within the grid bounds", () => {
    const snake = [{ x: 0, y: 0 }];
    const food = spawnFood(snake, seededRng([0.5, 0.5]));
    expect(food).not.toBeNull();
    if (!food) throw new Error("expected food to spawn");
    expect(food.x).toBeGreaterThanOrEqual(0);
    expect(food.x).toBeLessThan(GRID_COLS);
    expect(food.y).toBeGreaterThanOrEqual(0);
    expect(food.y).toBeLessThan(GRID_ROWS);
    expect(food.x === 0 && food.y === 0).toBe(false);
  });

  it("returns null when the board is full", () => {
    const full: { x: number; y: number }[] = [];
    for (let y = 0; y < GRID_ROWS; y++) {
      for (let x = 0; x < GRID_COLS; x++) full.push({ x, y });
    }
    expect(spawnFood(full, seededRng([0.5]))).toBeNull();
  });

  it("wins the game when food fills the last cell", () => {
    // Fill the whole board except one cell in front of the head.
    const cells: { x: number; y: number }[] = [];
    for (let y = 0; y < GRID_ROWS; y++) {
      for (let x = 0; x < GRID_COLS; x++) cells.push({ x, y });
    }
    // Head at (1,0) moving left into (0,0) which holds food; rest fills board.
    const head = { x: 1, y: 0 };
    const food = { x: 0, y: 0 };
    const body = cells.filter((c) => !(c.x === food.x && c.y === food.y));
    // Ensure head is first.
    const snake = [head, ...body.filter((c) => !(c.x === head.x && c.y === head.y))];
    const running: GameState = {
      snake,
      direction: "left",
      nextDir: "left",
      food,
      score: snake.length - 3,
      status: "running",
    };
    const next = step(running, seededRng([0.5, 0.5]));
    expect(next.status).toBe("won");
  });
});

export type { Direction };
