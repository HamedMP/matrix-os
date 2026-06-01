import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gauge, Layers, Pause, Play, RotateCcw, Trophy } from "lucide-react";
import {
  COLS,
  ROWS,
  HIDDEN_ROWS,
  PIECE_COLORS,
  type GameState,
  type PieceType,
  createGame,
  cellsFor,
  tryMove,
  tryRotate,
  softDrop,
  hardDrop,
  holdPiece,
  step,
  ghostRow,
  gravityMs,
} from "./tetris-model";
import "./styles.css";

const SCORES_TABLE = "scores";
const BEST_KEY = "matrix-tetris-best";

type Phase = "ready" | "playing" | "paused" | "over";

interface ScoreRow {
  score: number;
  lines: number;
  level: number;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function readLocalBest(): number {
  try {
    const raw = window.localStorage?.getItem(BEST_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch (err: unknown) {
    console.warn("[tetris] local best read failed:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}

function writeLocalBest(value: number): void {
  try {
    window.localStorage?.setItem(BEST_KEY, String(value));
  } catch (err: unknown) {
    console.warn("[tetris] local best write failed:", err instanceof Error ? err.message : String(err));
  }
}

async function loadBest(): Promise<number> {
  if (!window.MatrixOS?.db) return readLocalBest();
  const rows = await window.MatrixOS.db.find(SCORES_TABLE, {
    orderBy: { score: "desc" },
    limit: 1,
  });
  const top = rows[0];
  const dbBest = top && typeof top.score === "number" ? top.score : 0;
  return Math.max(dbBest, readLocalBest());
}

async function persistScore(row: ScoreRow): Promise<void> {
  writeLocalBest(Math.max(readLocalBest(), row.score));
  if (!window.MatrixOS?.db) return;
  await window.MatrixOS.db.insert(SCORES_TABLE, {
    score: row.score,
    lines: row.lines,
    level: row.level,
  });
}

// A small static mini-grid renderer for next / hold previews.
function PiecePreview({ type, label }: { type: PieceType | null; label: string }) {
  // Render a 4x4 box; map the spawn-rotation cells of the piece into it.
  const cells = Array.from({ length: 16 }, () => false as boolean);
  if (type) {
    const offsets = cellsFor({ type, rotation: 0, row: 0, col: 0 });
    for (const [r, c] of offsets) {
      const idx = r * 4 + c;
      if (idx >= 0 && idx < 16) cells[idx] = true;
    }
  }
  return (
    <div className="preview" aria-label={`${label}${type ? `: ${type}` : ": empty"}`}>
      <span className="preview__label">{label}</span>
      <div className="preview__grid">
        {cells.map((on, i) => (
          <span
            key={i}
            className="preview__cell"
            style={on && type ? { background: PIECE_COLORS[type], boxShadow: "inset 0 0 0 1px rgba(255,255,255,.25)" } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [game, setGame] = useState<GameState>(() => createGame());
  const [phase, setPhase] = useState<Phase>("ready");
  const [best, setBest] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const savedForGameRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      setError(null);
      setBest(await loadBest());
    } catch (err: unknown) {
      console.warn("[tetris] best score load failed:", err instanceof Error ? err.message : String(err));
      setBest(readLocalBest());
      setError("High score history could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void reload();
    const unsub = window.MatrixOS?.db?.onChange?.(SCORES_TABLE, () => void reload());
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [reload]);

  const startGame = useCallback(() => {
    savedForGameRef.current = false;
    setSaveNote(null);
    setGame(createGame());
    setPhase("playing");
  }, []);

  const togglePause = useCallback(() => {
    setPhase((p) => (p === "playing" ? "paused" : p === "paused" ? "playing" : p));
  }, []);

  // Gravity loop.
  useEffect(() => {
    if (phase !== "playing") return undefined;
    const interval = gravityMs(game.level);
    const timer = window.setInterval(() => {
      setGame((g) => step(g));
    }, interval);
    return () => window.clearInterval(timer);
  }, [phase, game.level]);

  // Persist score once when the game ends.
  useEffect(() => {
    if (!game.over) return;
    setPhase("over");
    if (savedForGameRef.current) return;
    savedForGameRef.current = true;
    const row: ScoreRow = { score: game.score, lines: game.lines, level: game.level };
    setBest((b) => Math.max(b, game.score));
    void (async () => {
      try {
        await persistScore(row);
        setSaveNote(window.MatrixOS?.db ? "Saved to Matrix Postgres" : "Saved locally");
      } catch (err: unknown) {
        console.warn("[tetris] score save failed:", err instanceof Error ? err.message : String(err));
        setSaveNote("Score could not be saved.");
        setError("Score could not be saved.");
      }
    })();
  }, [game.over, game.score, game.lines, game.level]);

  // Keyboard controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        togglePause();
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && (phase === "ready" || phase === "over")) {
        e.preventDefault();
        startGame();
        return;
      }
      if (phase !== "playing") return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          setGame((g) => tryMove(g, -1, 0));
          break;
        case "ArrowRight":
          e.preventDefault();
          setGame((g) => tryMove(g, 1, 0));
          break;
        case "ArrowDown":
          e.preventDefault();
          setGame((g) => softDrop(g));
          break;
        case "ArrowUp":
        case "x":
        case "X":
          e.preventDefault();
          setGame((g) => tryRotate(g, 1));
          break;
        case "z":
        case "Z":
        case "Control":
          e.preventDefault();
          setGame((g) => tryRotate(g, -1));
          break;
        case "c":
        case "C":
        case "Shift":
          e.preventDefault();
          setGame((g) => holdPiece(g));
          break;
        case " ":
          e.preventDefault();
          setGame((g) => hardDrop(g));
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, startGame, togglePause]);

  // Build the visible 10x20 render grid with the active piece + ghost overlaid.
  const renderGrid = useMemo(() => {
    const grid: Array<{ color: string | null; active: boolean; ghost: boolean }> = Array.from(
      { length: ROWS * COLS },
      () => ({ color: null, active: false, ghost: false }),
    );

    // Locked cells.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = game.board[r + HIDDEN_ROWS][c];
        if (cell) grid[r * COLS + c].color = PIECE_COLORS[cell];
      }
    }

    // Ghost piece.
    if (game.active && phase === "playing") {
      const gRow = ghostRow(game);
      if (gRow !== null) {
        const ghost = { ...game.active, row: gRow };
        for (const [r, c] of cellsFor(ghost)) {
          const vr = r - HIDDEN_ROWS;
          if (vr >= 0 && vr < ROWS && c >= 0 && c < COLS) {
            grid[vr * COLS + c].ghost = true;
          }
        }
      }
    }

    // Active piece.
    if (game.active) {
      const color = PIECE_COLORS[game.active.type];
      for (const [r, c] of cellsFor(game.active)) {
        const vr = r - HIDDEN_ROWS;
        if (vr >= 0 && vr < ROWS && c >= 0 && c < COLS) {
          grid[vr * COLS + c] = { color, active: true, ghost: false };
        }
      }
    }
    return grid;
  }, [game, phase]);

  const overlay =
    phase === "ready"
      ? {
          title: "Matrix Tetris",
          body: "Stack tetrominoes, clear lines, chase your best. Arrow keys to move, Up/Z to rotate, Space to hard drop.",
          cta: "Play",
        }
      : phase === "paused"
        ? { title: "Paused", body: "Take a breath. Press P or Resume to continue.", cta: "Resume" }
        : phase === "over"
          ? {
              title: "Game over",
              body: `You cleared ${game.lines} lines and scored ${game.score.toLocaleString()}.`,
              cta: "Play again",
            }
          : null;

  return (
    <main className={reduced ? "tetris-app tetris-app--reduced" : "tetris-app"}>
      <section className="play-area">
        <div className="board-wrap">
          <div className="board" data-testid="tetris-board" role="grid" aria-label="Tetris playfield">
            {renderGrid.map((cell, i) => (
              <span
                key={i}
                data-testid="tetris-cell"
                data-active={cell.active ? "true" : "false"}
                className={
                  cell.ghost
                    ? "cell cell--ghost"
                    : cell.color
                      ? cell.active
                        ? "cell cell--active"
                        : "cell cell--locked"
                      : "cell"
                }
                style={cell.color ? { background: cell.color } : undefined}
              />
            ))}
          </div>

          {overlay && (
            <div className="overlay" role="dialog" aria-label={overlay.title}>
              <div className="overlay__card">
                <h1>{overlay.title}</h1>
                <p>{overlay.body}</p>
                {phase === "over" && (
                  <div className="overlay__stat">
                    <Trophy size={16} /> Best {best.toLocaleString()}
                  </div>
                )}
                <button type="button" className="primary-action" onClick={startGame}>
                  <Play size={18} /> {overlay.cta}
                </button>
                {saveNote && phase === "over" && <span className="overlay__note">{saveNote}</span>}
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="side-rail" aria-label="Game info">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <Layers size={16} />
          </span>
          Matrix Tetris
        </div>

        <div className="stat-grid">
          <div className="stat">
            <span>Score</span>
            <strong data-testid="tetris-score">{game.score.toLocaleString()}</strong>
          </div>
          <div className="stat">
            <span>Best</span>
            <strong data-testid="tetris-best">{best.toLocaleString()}</strong>
          </div>
          <div className="stat">
            <span>Lines</span>
            <strong>{game.lines}</strong>
          </div>
          <div className="stat">
            <span>Level</span>
            <strong>{game.level}</strong>
          </div>
        </div>

        <PiecePreview type={game.hold} label="Hold" />

        <div className="next-stack">
          <span className="preview__label">Next</span>
          <div className="next-stack__list">
            {game.queue.slice(0, 3).map((type, i) => (
              <PiecePreview key={`${type}-${i}`} type={type} label={`Up ${i + 1}`} />
            ))}
          </div>
        </div>

        <div className="controls">
          {phase === "playing" || phase === "paused" ? (
            <button type="button" className="secondary-action" onClick={togglePause}>
              {phase === "paused" ? <Play size={16} /> : <Pause size={16} />}
              {phase === "paused" ? "Resume" : "Pause"}
            </button>
          ) : (
            <button type="button" className="secondary-action" onClick={startGame}>
              <Play size={16} /> Play
            </button>
          )}
          <button type="button" className="icon-action" title="Restart" onClick={startGame}>
            <RotateCcw size={16} />
          </button>
        </div>

        <div className="hints">
          <Gauge size={14} />
          <span>
            <kbd>←</kbd>
            <kbd>→</kbd> move · <kbd>↓</kbd> soft · <kbd>Space</kbd> drop · <kbd>↑</kbd>/<kbd>Z</kbd> rotate ·{" "}
            <kbd>C</kbd> hold · <kbd>P</kbd> pause
          </span>
        </div>

        {error && <div className="error-note">{error}</div>}
      </aside>
    </main>
  );
}
