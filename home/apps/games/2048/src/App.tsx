import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { RotateCcw, Undo2, Trophy, Sparkles, X } from "lucide-react";
import "./styles.css";
import {
  type Board,
  type Direction,
  type GameState,
  addRandomTile,
  animationCellsForMove,
  cloneBoard,
  hasWon,
  isGameOver,
  move,
  newGame,
} from "./game-2048";
import { nextTileId, tilesFromBoard, type Tile } from "./tile-animation";

const BEST_KEY = "matrixos.2048.best";
const SCORES_TABLE = "scores";

interface InternalState extends GameState {
  tiles: Tile[];
  history: { board: Board; score: number; tiles: Tile[] } | null;
}

type Action =
  | { type: "reset" }
  | { type: "move"; direction: Direction }
  | { type: "undo" };

function freshGame(): InternalState {
  const g = newGame();
  const tiles: Tile[] = [];
  for (let row = 0; row < g.board.length; row += 1) {
    for (let col = 0; col < g.board[row].length; col += 1) {
      const value = g.board[row][col];
      if (value !== 0) {
        tiles.push({ id: nextTileId(), value, row, col, spawned: true, merged: false });
      }
    }
  }
  return { ...g, tiles, history: null };
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
      const animationCells = animationCellsForMove(state.board, action.direction);
      const tiles = tilesFromBoard(nextBoard, state.tiles, spawn.spawned, animationCells.merged, animationCells.consumed, action.direction);

      return {
        board: nextBoard,
        score: nextScore,
        won: hasWon(nextBoard),
        over: isGameOver(nextBoard),
        tiles,
        history,
      };
    }

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
  const scoreRowEnsureRef = useRef<Promise<string> | null>(null);
  const dbInitialLoadRef = useRef<Promise<void> | null>(null);
  const pendingBestRef = useRef(0);
  const latestScoreRef = useRef(0);
  const sessionRef = useRef(0);
  const boardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    latestScoreRef.current = state.score;
  }, [state.score]);

  const ensureScoreRow = useCallback(async (db: MatrixOSDb, scoreHint: number): Promise<string> => {
    if (dbRowId.current) return dbRowId.current;
    if (dbInitialLoadRef.current) {
      await dbInitialLoadRef.current;
    }
    if (dbRowId.current) return dbRowId.current;
    if (!scoreRowEnsureRef.current) {
      scoreRowEnsureRef.current = db.insert(SCORES_TABLE, {
        score: Math.max(scoreHint, latestScoreRef.current),
        best: Math.max(pendingBestRef.current, latestScoreRef.current),
        created_at: new Date().toISOString(),
      })
        .then((res) => {
          dbRowId.current = res.id;
          return res.id;
        })
        .finally(() => {
          scoreRowEnsureRef.current = null;
        });
    }
    return scoreRowEnsureRef.current;
  }, []);

  const persistScore = useCallback((score: number) => {
    const db = window.MatrixOS?.db;
    if (!db) return;
    const session = sessionRef.current;
    (async () => {
      try {
        const id = await ensureScoreRow(db, score);
        if (session !== sessionRef.current) return;
        await db.update(SCORES_TABLE, id, { score: Math.max(score, latestScoreRef.current) });
      } catch (err) {
        console.warn("[2048] failed to update current score", err);
      }
    })();
  }, [ensureScoreRow]);

  // ---- Load best score: DB first, localStorage fallback -------------------
  useEffect(() => {
    let active = true;
    const db = window.MatrixOS?.db;

    const fromLocal = () => {
      try {
        const raw = window.localStorage.getItem(BEST_KEY);
        if (raw && active) {
          const localBest = Number(raw) || 0;
          pendingBestRef.current = Math.max(pendingBestRef.current, localBest);
          setBest((prev) => Math.max(prev, localBest));
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "SecurityError")) {
          console.warn("[2048] unexpected localStorage read error", err);
        }
      }
    };

    if (!db) {
      fromLocal();
      return () => {
        active = false;
      };
    }

    const load = (async () => {
      try {
        const rows = await db.find(SCORES_TABLE, { orderBy: { created_at: "desc" }, limit: 1 });
        if (!active) return;
        const row = rows[0];
        if (row) {
          const loadedBest = Number(row.best) || 0;
          const rowId = (row.id as string) ?? null;
          dbRowId.current = rowId;
          pendingBestRef.current = Math.max(pendingBestRef.current, loadedBest);
          setBest((prev) => Math.max(prev, loadedBest));
          if (rowId && latestScoreRef.current === 0) {
            void db.update(SCORES_TABLE, rowId, { score: 0 }).catch((err) => {
              console.warn("[2048] failed to sync loaded score row", err);
            });
          }
        } else {
          fromLocal();
        }
        setError(null);
      } catch (err) {
        if (!active) return;
        console.warn("[2048] failed to load best score from MatrixOS.db", err);
        setError("Couldn't load your best score; playing locally.");
        fromLocal();
      } finally {
        dbInitialLoadRef.current = null;
      }
    })();
    dbInitialLoadRef.current = load;

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
              const rowId = typeof row.id === "string" ? row.id : null;
              if (dbRowId.current && rowId && rowId !== dbRowId.current) return;
              dbRowId.current = rowId ?? dbRowId.current;
              pendingBestRef.current = Math.max(pendingBestRef.current, Number(row.best) || 0);
              setBest((prev) => Math.max(prev, Number(row.best) || 0));
              setError(null);
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
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "SecurityError")) {
        console.warn("[2048] unexpected localStorage write error", err);
      }
    }
    const db = window.MatrixOS?.db;
    if (!db) return;
    pendingBestRef.current = Math.max(pendingBestRef.current, newBest);
    const session = sessionRef.current;
    (async () => {
      try {
        const id = await ensureScoreRow(db, newBest);
        if (session !== sessionRef.current) return;
        await db.update(SCORES_TABLE, id, {
          score: latestScoreRef.current,
          best: Math.max(newBest, pendingBestRef.current),
        });
        setError(null);
      } catch (err) {
        console.warn("[2048] failed to persist best score", err);
        setError("Best score saved locally; sync failed.");
      }
    })();
  }, [ensureScoreRow]);

  // Update best whenever current score beats it.
  useEffect(() => {
    if (state.score > best) {
      setBest(state.score);
      persistBest(state.score);
    }
  }, [state.score, best, persistBest]);

  // Persist the current score onto the score row too (so DB.score is live).
  useEffect(() => {
    if (state.score === 0 && !dbRowId.current) return;
    persistScore(state.score);
  }, [persistScore, state.score]);

  const showWin = state.won && !keepPlaying;
  const showOver = state.over && (!state.won || keepPlaying);
  const undoMove = useCallback(() => {
    setKeepPlaying(false);
    dispatch({ type: "undo" });
  }, []);

  // ---- Keyboard input ------------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if ((e.key === "z" || e.key === "Z") && state.history) {
          e.preventDefault();
          undoMove();
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
  }, [showWin, state.history, undoMove]);

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
    sessionRef.current += 1;
    setKeepPlaying(false);
    dispatch({ type: "reset" });
  }, []);

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
          <button type="button" className="btn ghost" onClick={undoMove} disabled={!state.history}>
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
            <span>{error}</span>
            <button type="button" className="banner-dismiss" aria-label="Dismiss sync message" onClick={() => setError(null)}>
              <X size={13} aria-hidden />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
