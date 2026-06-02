import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gauge, Pause, Play, RotateCcw, Trophy } from "lucide-react";
import "./styles.css";
import {
  GRID_COLS,
  GRID_ROWS,
  createGame,
  queuedDirection,
  speedForScore,
  step,
  type Direction,
  type GameState,
} from "./snake-model";

const SCORES_TABLE = "scores";
const DATA_BEST_KEY = "matrix-snake-best";

type Difficulty = "chill" | "classic" | "fast";

const DIFFICULTY: Record<Difficulty, { label: string; tickMul: number; hint: string }> = {
  chill: { label: "Chill", tickMul: 1.5, hint: "Relaxed pace" },
  classic: { label: "Classic", tickMul: 1, hint: "Nokia speed" },
  fast: { label: "Fast", tickMul: 0.65, hint: "Reflex test" },
};

const KEY_TO_DIR: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  W: "up",
  s: "down",
  S: "down",
  a: "left",
  A: "left",
  d: "right",
  D: "right",
};

const rng = () => Math.random();

function coerceBest(row: unknown): number {
  if (!row || typeof row !== "object") return 0;
  const data = row as Record<string, unknown>;
  const best = typeof data.best === "number" ? data.best : Number(data.best);
  if (Number.isFinite(best) && best > 0) return best;
  const score = typeof data.score === "number" ? data.score : Number(data.score);
  return Number.isFinite(score) && score > 0 ? score : 0;
}

function coercePositiveNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readFallbackBest(): Promise<number> {
  if (window.MatrixOS?.readData) {
    try {
      return coercePositiveNumber(await window.MatrixOS.readData(DATA_BEST_KEY));
    } catch (err: unknown) {
      console.warn("[snake] app data best read failed:", err instanceof Error ? err.message : String(err));
      return 0;
    }
  }
  return 0;
}

async function writeFallbackBest(value: number): Promise<void> {
  if (window.MatrixOS?.writeData) {
    try {
      await window.MatrixOS.writeData(DATA_BEST_KEY, value);
      return;
    } catch (err: unknown) {
      console.warn("[snake] app data best save failed:", err instanceof Error ? err.message : String(err));
      return;
    }
  }
}

async function loadBest(): Promise<number> {
  const local = await readFallbackBest();
  const db = window.MatrixOS?.db;
  if (!db) return local;
  const rows = await db.find(SCORES_TABLE, { orderBy: { best: "desc" }, limit: 1 });
  const dbBest = rows.length > 0 ? coerceBest(rows[0]) : 0;
  return Math.max(local, dbBest);
}

async function persistScore(score: number, best: number): Promise<void> {
  const db = window.MatrixOS?.db;
  if (!db || score <= 0) return;
  await db.insert(SCORES_TABLE, { score, best });
}

const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function App() {
  const [game, setGame] = useState<GameState>(() => createGame(rng));
  const [difficulty, setDifficulty] = useState<Difficulty>("classic");
  const [best, setBest] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastGameWasBest, setLastGameWasBest] = useState(false);

  const gameRef = useRef(game);
  gameRef.current = game;
  const bestRef = useRef(best);
  bestRef.current = best;
  const savedForRef = useRef(false); // guard one save per game-over
  const eatPulseRef = useRef(0);
  const prevScoreRef = useRef(0);
  const bestLoadedRef = useRef(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // --- Load persisted best score ---
  const reloadBest = useCallback(async () => {
    try {
      setError(null);
      const loadedBest = await loadBest();
      bestLoadedRef.current = true;
      setBest(loadedBest);
    } catch (err: unknown) {
      console.warn("[snake] best load failed:", err instanceof Error ? err.message : String(err));
      const fallbackBest = await readFallbackBest();
      bestLoadedRef.current = true;
      setBest(fallbackBest);
      setError("High score could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void reloadBest();
    const db = window.MatrixOS?.db;
    if (!db?.onChange) return undefined;
    return db.onChange(SCORES_TABLE, () => void reloadBest());
  }, [reloadBest]);

  // --- Persist new high score on game end ---
  const commitScore = useCallback(async (finalScore: number) => {
    const bestLoaded = bestLoadedRef.current;
    const newBest = Math.max(bestRef.current, finalScore);
    const wasNewBest = bestLoaded && finalScore > bestRef.current;
    setLastGameWasBest(wasNewBest);
    if (wasNewBest) {
      setBest(newBest);
      await writeFallbackBest(newBest);
    }
    try {
      await persistScore(finalScore, newBest);
    } catch (err: unknown) {
      console.warn("[snake] score save failed:", err instanceof Error ? err.message : String(err));
      setError("Score could not be synced.");
    }
  }, []);

  // --- Game controls ---
  const startNewGame = useCallback(() => {
    savedForRef.current = false;
    prevScoreRef.current = 0;
    setLastGameWasBest(false);
    setError(null);
    setGame({ ...createGame(rng), status: "running" });
  }, []);

  const togglePause = useCallback(() => {
    setGame((current) => {
      if (current.status === "running") return { ...current, status: "paused" };
      if (current.status === "paused") return { ...current, status: "running" };
      if (current.status === "ready") return { ...current, status: "running" };
      return current;
    });
  }, []);

  const queueDirection = useCallback((dir: Direction) => {
    setGame((current) => {
      if (current.status === "over" || current.status === "won") return current;
      const status = current.status === "ready" ? "running" : current.status;
      return {
        ...current,
        status: status === "paused" ? "running" : status,
        nextDir: queuedDirection(current.direction, current.nextDir, dir),
      };
    });
  }, []);

  // --- Keyboard ---
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        togglePause();
        return;
      }
      if (e.key === "Enter") {
        const status = gameRef.current.status;
        if (status === "over" || status === "won" || status === "ready") {
          e.preventDefault();
          startNewGame();
        }
        return;
      }
      const dir = KEY_TO_DIR[e.key];
      if (dir) {
        e.preventDefault();
        queueDirection(dir);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queueDirection, startNewGame, togglePause]);

  // --- Game loop ---
  useEffect(() => {
    if (game.status !== "running") return undefined;
    let cancelled = false;
    let tickTimer: number | null = null;
    let scheduleTimer: number | null = null;
    const schedule = () => {
      if (cancelled || gameRef.current.status !== "running") return;
      const interval = Math.round(speedForScore(gameRef.current.score) * DIFFICULTY[difficulty].tickMul);
      tickTimer = window.setTimeout(tick, interval);
    };
    const tick = () => {
      setGame((current) => step(current, rng));
      scheduleTimer = window.setTimeout(schedule, 0);
    };
    schedule();
    return () => {
      cancelled = true;
      if (tickTimer !== null) window.clearTimeout(tickTimer);
      if (scheduleTimer !== null) window.clearTimeout(scheduleTimer);
    };
  }, [game.status, difficulty]);

  // --- Eat pulse + save-on-end side effects ---
  useEffect(() => {
    if (game.score > prevScoreRef.current) {
      eatPulseRef.current = prefersReducedMotion ? 0 : 1;
    }
    prevScoreRef.current = game.score;
  }, [game.score]);

  useEffect(() => {
    if ((game.status === "over" || game.status === "won") && !savedForRef.current) {
      savedForRef.current = true;
      void commitScore(game.score);
    }
  }, [game.status, game.score, commitScore]);

  // --- Canvas render ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    let raf = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.min(canvas.clientWidth, canvas.clientHeight);
      if (size <= 0) {
        raf = window.requestAnimationFrame(draw);
        return;
      }
      const px = Math.round(size * dpr);
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      const cell = canvas.width / GRID_COLS;
      const cs = window.getComputedStyle(canvas);
      const read = (name: string, fallback: string) => {
        const v = cs.getPropertyValue(name).trim();
        return v || fallback;
      };
      const boardBg = read("--snake-board", "#eef0e6");
      const gridLine = read("--snake-grid", "rgba(67,78,63,0.06)");
      const snakeColor = read("--snake-body", "#434E3F");
      const headColor = read("--snake-head", "#3A7D44");
      const foodColor = read("--snake-food", "#D06F25");

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = boardBg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // subtle grid
      ctx.strokeStyle = gridLine;
      ctx.lineWidth = 1;
      for (let i = 1; i < GRID_COLS; i++) {
        ctx.beginPath();
        ctx.moveTo(i * cell, 0);
        ctx.lineTo(i * cell, canvas.height);
        ctx.stroke();
      }
      for (let j = 1; j < GRID_ROWS; j++) {
        ctx.beginPath();
        ctx.moveTo(0, j * cell);
        ctx.lineTo(canvas.width, j * cell);
        ctx.stroke();
      }

      const g = gameRef.current;
      const pad = Math.max(1, cell * 0.12);
      const radius = Math.max(2, cell * 0.28);

      // food with gentle pulse
      const t = prefersReducedMotion ? 0 : Date.now() / 320;
      const foodPulse = prefersReducedMotion ? 1 : 1 + Math.sin(t) * 0.06;
      const fx = g.food.x * cell + cell / 2;
      const fy = g.food.y * cell + cell / 2;
      ctx.fillStyle = foodColor;
      ctx.beginPath();
      ctx.arc(fx, fy, (cell / 2 - pad) * foodPulse, 0, Math.PI * 2);
      ctx.fill();

      // snake
      for (let s = g.snake.length - 1; s >= 0; s--) {
        const seg = g.snake[s];
        const isHead = s === 0;
        ctx.fillStyle = isHead ? headColor : snakeColor;
        const grow = isHead && eatPulseRef.current > 0 ? eatPulseRef.current * pad * 0.5 : 0;
        const x = seg.x * cell + pad - grow;
        const y = seg.y * cell + pad - grow;
        const w = cell - pad * 2 + grow * 2;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(x, y, w, w, radius);
        } else {
          ctx.rect(x, y, w, w);
        }
        ctx.fill();
      }

      if (eatPulseRef.current > 0) {
        eatPulseRef.current = Math.max(0, eatPulseRef.current - 0.08);
      }
      raf = window.requestAnimationFrame(draw);
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const statusLabel = useMemo(() => {
    switch (game.status) {
      case "running":
        return "Running";
      case "paused":
        return "Paused";
      case "over":
        return "Game over";
      case "won":
        return "Perfect game";
      default:
        return "Ready";
    }
  }, [game.status]);

  const isNewBest = (game.status === "over" || game.status === "won") && lastGameWasBest;
  const overlayVisible = game.status === "ready" || game.status === "over" || game.status === "won";

  return (
    <main className="snake-app">
      <section className="board-panel" aria-label="Snake game board">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Play size={16} />
            </span>
            <span>Matrix Snake</span>
          </div>
          <div className="scoreboard">
            <div className="stat">
              <span>Score</span>
              <strong data-testid="score">{game.score}</strong>
            </div>
            <div className="stat stat--best">
              <span>
                <Trophy size={13} aria-hidden="true" /> Best
              </span>
              <strong data-testid="high-score">{best}</strong>
            </div>
          </div>
        </header>

        <div className="canvas-wrap">
          <canvas ref={canvasRef} className="board" aria-label="Snake play area" />

          {overlayVisible && (
            <div className="overlay" role="dialog" aria-label={statusLabel}>
              <div className="overlay-card">
                {game.status === "ready" && (
                  <>
                    <span className="overlay-icon" aria-hidden="true">
                      <Play size={28} />
                    </span>
                    <h1>Snake</h1>
                    <p>Eat to grow. Avoid the walls and yourself.</p>
                    <div className="keys-hint">
                      <kbd>↑</kbd>
                      <kbd>↓</kbd>
                      <kbd>←</kbd>
                      <kbd>→</kbd>
                      <span>or</span>
                      <kbd>W</kbd>
                      <kbd>A</kbd>
                      <kbd>S</kbd>
                      <kbd>D</kbd>
                      <span>·</span>
                      <kbd>Space</kbd>
                      <span>pause</span>
                    </div>
                    <button className="primary-action" type="button" onClick={startNewGame}>
                      <Play size={18} /> Start game
                    </button>
                  </>
                )}
                {(game.status === "over" || game.status === "won") && (
                  <>
                    <span className="overlay-icon" aria-hidden="true">
                      <Trophy size={28} />
                    </span>
                    <h1>{game.status === "won" ? "Perfect game!" : "Game over"}</h1>
                    <p>
                      You scored <strong>{game.score}</strong>
                      {isNewBest ? " — a new best!" : ""}.
                    </p>
                    <button className="primary-action" type="button" onClick={startNewGame}>
                      <RotateCcw size={18} /> Play again
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="side-panel">
        <div className="control-card">
          <p className="eyebrow">Status</p>
          <div className="status-row">
            <span className={`status-dot status-dot--${game.status}`} aria-hidden="true" />
            <strong data-testid="snake-status">{statusLabel}</strong>
          </div>
          <div className="button-row">
            <button
              className="ghost-action"
              type="button"
              onClick={togglePause}
              disabled={game.status === "over" || game.status === "won"}
            >
              {game.status === "running" ? <Pause size={16} /> : <Play size={16} />}
              {game.status === "running" ? "Pause" : "Resume"}
            </button>
            <button className="ghost-action" type="button" onClick={startNewGame}>
              <RotateCcw size={16} /> New game
            </button>
          </div>
        </div>

        <div className="control-card">
          <p className="eyebrow">
            <Gauge size={13} aria-hidden="true" /> Difficulty
          </p>
          <div className="difficulty-row" role="group" aria-label="Difficulty">
            {(Object.keys(DIFFICULTY) as Difficulty[]).map((key) => (
              <button
                key={key}
                type="button"
                className={key === difficulty ? "diff-chip diff-chip--active" : "diff-chip"}
                onClick={() => setDifficulty(key)}
                aria-pressed={key === difficulty}
              >
                <strong>{DIFFICULTY[key].label}</strong>
                <span>{DIFFICULTY[key].hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="control-card hints">
          <p className="eyebrow">Controls</p>
          <ul>
            <li>
              <kbd>Arrows</kbd> / <kbd>WASD</kbd> steer
            </li>
            <li>
              <kbd>Space</kbd> pause &amp; resume
            </li>
            <li>
              <kbd>Enter</kbd> new game
            </li>
          </ul>
        </div>

        {error && (
          <div className="error-note" role="status">
            {error}
          </div>
        )}
      </aside>
    </main>
  );
}
