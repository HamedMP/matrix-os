import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { RotateCcw, Undo2, Trophy, Sparkles } from "lucide-react";
import {
  type Board,
  type Direction,
  type GameState,
  addRandomTile,
  cloneBoard,
  hasWon,
  isGameOver,
  move,
  newGame,
} from "./game-2048";

const BEST_KEY = "matrixos.2048.best";
const SCORES_TABLE = "scores";

// ---- Tile identity for animation ------------------------------------------
// We keep a parallel grid of stable tile ids so React can animate slides/merges
// via CSS transforms keyed by id rather than re-rendering whole cells.
interface Tile {
  id: number;
  value: number;
  row: number;
  col: number;
  merged?: boolean; // pulse on merge
  spawned?: boolean; // pop-in on spawn
}

let TILE_SEQ = 1;
function nextId(): number {
  TILE_SEQ += 1;
  return TILE_SEQ;
}

interface InternalState extends GameState {
  tiles: Tile[];
  history: { board: Board; score: number; tiles: Tile[] } | null;
}

type Action =
  | { type: "reset" }
  | { type: "move"; direction: Direction }
  | { type: "undo" }
  | { type: "load-best"; best: number };

function tilesFromBoard(
  board: Board,
  previous: Tile[] = [],
  spawned: { row: number; col: number; value: number } | null = null,
): Tile[] {
  const tiles: Tile[] = [];
  const used = new Set<number>();
  for (let r = 0; r < board.length; r += 1) {
    for (let c = 0; c < board[r].length; c += 1) {
      if (board[r][c] !== 0) {
        if (spawned && spawned.row === r && spawned.col === c && spawned.value === board[r][c]) {
          tiles.push({ id: nextId(), value: board[r][c], row: r, col: c, spawned: true });
          continue;
        }
        const match = previous
          .filter((tile) => tile.value === board[r][c] && !used.has(tile.id))
          .sort((a, b) => Math.abs(a.row - r) + Math.abs(a.col - c) - (Math.abs(b.row - r) + Math.abs(b.col - c)))[0];
        if (match) {
          used.add(match.id);
          tiles.push({ ...match, row: r, col: c, spawned: false, merged: false });
        } else {
          tiles.push({ id: nextId(), value: board[r][c], row: r, col: c, spawned: false, merged: true });
        }
      }
    }
  }
  return tiles;
}

function freshGame(): InternalState {
  const g = newGame();
  return { ...g, tiles: tilesFromBoard(g.board), history: null };
}

function reducer(state: InternalState, action: Action): InternalState {
  switch (action.type) {
    case "reset":
      return freshGame();

    case "undo": {
      if (!state.history) return state;
      return {
        board: cloneBoard(state.history.board),
        score: state.history.score,
        won: hasWon(state.history.board),
        over: false,
        tiles: state.history.tiles.map((t) => ({ ...t, merged: false, spawned: false })),
        history: null,
      };
    }

    case "move": {
      if (state.over) return state;
      const result = move(state.board, action.direction);
      if (!result.moved) return state;

      const history = {
        board: cloneBoard(state.board),
        score: state.score,
        tiles: state.tiles.map((t) => ({ ...t })),
      };

      const spawn = addRandomTile(result.board, Math.random);
      const nextBoard = spawn.board;
      const nextScore = state.score + result.gained;
      const tiles = tilesFromBoard(nextBoard, state.tiles, spawn.spawned);

      return {
        board: nextBoard,
        score: nextScore,
        won: hasWon(nextBoard),
        over: isGameOver(nextBoard),
        tiles,
        history,
      };
    }

    case "load-best":
      return state;

    default:
      return state;
  }
}

const KEY_TO_DIR: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  a: "left",
  d: "right",
  w: "up",
  s: "down",
  A: "left",
  D: "right",
  W: "up",
  S: "down",
  h: "left",
  l: "right",
  k: "up",
  j: "down",
};

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, freshGame);
  const [best, setBest] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [keepPlaying, setKeepPlaying] = useState(false);
  const dbRowId = useRef<string | null>(null);
  const dbRowInsertRef = useRef<Promise<string> | null>(null);
  const pendingBestRef = useRef(0);
  const boardRef = useRef<HTMLDivElement | null>(null);

  const persistScore = useCallback((score: number) => {
    const db = window.MatrixOS?.db;
    if (!db || !dbRowId.current) return;
    (async () => {
      try {
        await db.update(SCORES_TABLE, dbRowId.current as string, { score });
      } catch (err) {
        console.warn("[2048] failed to update current score", err);
      }
    })();
  }, []);

  // ---- Load best score: DB first, localStorage fallback -------------------
  useEffect(() => {
    let active = true;
    const db = window.MatrixOS?.db;

    const fromLocal = () => {
      try {
        const raw = window.localStorage.getItem(BEST_KEY);
        if (raw && active) setBest(Number(raw) || 0);
      } catch {
        // localStorage may be unavailable (privacy mode); ignore safely.
      }
    };

    if (!db) {
      fromLocal();
      return () => {
        active = false;
      };
    }

    (async () => {
      try {
        const rows = await db.find(SCORES_TABLE, { orderBy: { created_at: "desc" }, limit: 1 });
        if (!active) return;
        const row = rows[0];
        if (row) {
          dbRowId.current = (row.id as string) ?? null;
          setBest(Number(row.best) || 0);
        } else {
          fromLocal();
        }
      } catch (err) {
        if (!active) return;
        console.warn("[2048] failed to load best score from MatrixOS.db", err);
        setError("Couldn't load your best score; playing locally.");
        fromLocal();
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  // ---- onChange subscription: reconcile best when DB changes --------------
  useEffect(() => {
    const db = window.MatrixOS?.db;
    if (!db?.onChange) return;
    let unsub: (() => void) | undefined;
    try {
      unsub = db.onChange(SCORES_TABLE, () => {
        (async () => {
          try {
            const rows = await db.find(SCORES_TABLE, { orderBy: { created_at: "desc" }, limit: 1 });
            const row = rows[0];
            if (row) {
              dbRowId.current = (row.id as string) ?? dbRowId.current;
              setBest((prev) => Math.max(prev, Number(row.best) || 0));
            }
          } catch (err) {
            console.warn("[2048] onChange reload failed", err);
          }
        })();
      });
    } catch (err) {
      console.warn("[2048] failed to subscribe to scores changes", err);
    }
    return () => {
      if (unsub) unsub();
    };
  }, []);

  // ---- Persist a new best (optimistic local, background DB) ---------------
  const persistBest = useCallback((newBest: number) => {
    // Optimistic local fallback always.
    try {
      window.localStorage.setItem(BEST_KEY, String(newBest));
    } catch {
      // ignore; non-fatal
    }
    const db = window.MatrixOS?.db;
    if (!db) return;
    pendingBestRef.current = Math.max(pendingBestRef.current, newBest);
    (async () => {
      try {
        if (dbRowId.current) {
          await db.update(SCORES_TABLE, dbRowId.current, { best: Math.max(newBest, pendingBestRef.current) });
        } else {
          if (!dbRowInsertRef.current) {
            dbRowInsertRef.current = db.insert(SCORES_TABLE, {
              score: newBest,
              best: pendingBestRef.current,
              created_at: new Date().toISOString(),
            })
              .then((res) => {
                dbRowId.current = res.id;
                return res.id;
              })
              .finally(() => {
                dbRowInsertRef.current = null;
              });
          }
          const id = await dbRowInsertRef.current;
          await db.update(SCORES_TABLE, id, { best: Math.max(newBest, pendingBestRef.current) });
        }
      } catch (err) {
        console.warn("[2048] failed to persist best score", err);
        setError("Best score saved locally; sync failed.");
      }
    })();
  }, []);

  // Update best whenever current score beats it.
  useEffect(() => {
    if (state.score > best) {
      setBest(state.score);
      persistBest(state.score);
    }
  }, [state.score, best, persistBest]);

  // Persist the current score onto the score row too (so DB.score is live).
  useEffect(() => {
    persistScore(state.score);
  }, [persistScore, state.score]);

  const showWin = state.won && !keepPlaying;
  const showOver = state.over && (!state.won || keepPlaying);

  // ---- Keyboard input ------------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if ((e.key === "z" || e.key === "Z") && state.history) {
          e.preventDefault();
          dispatch({ type: "undo" });
        }
        return;
      }
      const dir = KEY_TO_DIR[e.key];
      if (dir) {
        e.preventDefault();
        if (showWin) return;
        dispatch({ type: "move", direction: dir });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showWin, state.history]);

  // ---- Touch swipe ---------------------------------------------------------
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (Math.max(absX, absY) < 24) return; // ignore taps
      let dir: Direction;
      if (absX > absY) dir = dx > 0 ? "right" : "left";
      else dir = dy > 0 ? "down" : "up";
      if (showWin) return;
      dispatch({ type: "move", direction: dir });
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchend", onEnd);
    };
  }, [showWin]);

  const newGameClick = useCallback(() => {
    setKeepPlaying(false);
    persistScore(0);
    dispatch({ type: "reset" });
  }, [persistScore]);

  return (
    <div className="app">
      <div className="shell">
        <header className="topbar">
          <div className="title-block">
            <h1 className="title">2048</h1>
            <p className="subtitle">Join the tiles, reach 2048.</p>
          </div>
          <div className="scores">
            <div className="score-card">
              <span className="score-label">Score</span>
              <span className="score-value" data-testid="score">
                {state.score}
              </span>
            </div>
            <div className="score-card">
              <span className="score-label">
                <Trophy size={11} aria-hidden /> Best
              </span>
              <span className="score-value" data-testid="best">
                {best}
              </span>
            </div>
          </div>
        </header>

        <div className="controls">
          <button type="button" className="btn ghost" onClick={() => dispatch({ type: "undo" })} disabled={!state.history}>
            <Undo2 size={15} aria-hidden /> Undo
          </button>
          <button type="button" className="btn primary" onClick={newGameClick}>
            <RotateCcw size={15} aria-hidden /> New game
          </button>
        </div>

        <div className="board-wrap">
          <div className="board" data-testid="board" ref={boardRef} aria-label="2048 board">
            {Array.from({ length: 16 }).map((_, i) => (
              <div key={`bg-${i}`} className="cell" data-testid="cell" aria-hidden />
            ))}

            {state.tiles.map((tile) => (
              <div
                key={tile.id}
                className={[
                  "tile",
                  `tile-${tile.value > 2048 ? "super" : tile.value}`,
                  tile.merged ? "is-merged" : "",
                  tile.spawned ? "is-new" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={
                  {
                    "--col": tile.col,
                    "--row": tile.row,
                  } as React.CSSProperties
                }
                data-testid="tile"
                data-value={tile.value}
              >
                <span className="tile-inner">{tile.value}</span>
              </div>
            ))}

            {showWin && (
              <div className="overlay win" role="dialog" aria-label="You win">
                <Sparkles size={28} aria-hidden />
                <h2>You made 2048!</h2>
                <p>Keep going for a higher score.</p>
                <div className="overlay-actions">
                  <button type="button" className="btn primary" onClick={() => setKeepPlaying(true)}>
                    Keep playing
                  </button>
                  <button type="button" className="btn ghost" onClick={newGameClick}>
                    New game
                  </button>
                </div>
              </div>
            )}

            {showOver && (
              <div className="overlay over" role="dialog" aria-label="Game over">
                <h2>Game over</h2>
                <p>No more moves. Final score {state.score}.</p>
                <div className="overlay-actions">
                  <button type="button" className="btn primary" onClick={newGameClick}>
                    Try again
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <footer className="hints">
          <span className="hint">
            <kbd>←</kbd>
            <kbd>↑</kbd>
            <kbd>→</kbd>
            <kbd>↓</kbd> or <kbd>WASD</kbd> to move
          </span>
          <span className="hint">
            <kbd>⌘Z</kbd> undo · swipe on touch
          </span>
        </footer>

        {error && (
          <div className="banner" role="status">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
