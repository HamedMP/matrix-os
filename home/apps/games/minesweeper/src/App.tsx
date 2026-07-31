import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bomb, Flag, RotateCcw } from "lucide-react";
import "./styles.css";
import {
  CELL,
  chord,
  clampCustom,
  createBoard,
  difficultyConfig,
  flagsPlaced,
  minesRemaining,
  reveal,
  toggleFlag,
  type Board,
  type Difficulty,
  type DifficultySpec,
} from "./minesweeper-model";

type Face = "happy" | "scared" | "win" | "dead";

interface GameMeta {
  id: number;
  difficulty: Difficulty;
  spec: DifficultySpec;
}

interface PendingBestSave {
  secs: number;
  count: number;
}

const DIFFICULTIES: Array<{ id: Difficulty; label: string }> = [
  { id: "beginner", label: "Beginner" },
  { id: "intermediate", label: "Intermediate" },
  { id: "expert", label: "Expert" },
  { id: "custom", label: "Custom" },
];

// Number colors matching classic Minesweeper.
const NUMBER_COLORS: Record<number, string> = {
  1: "#1d4ed8",
  2: "#15803d",
  3: "#dc2626",
  4: "#1e3a8a",
  5: "#7f1d1d",
  6: "#0e7490",
  7: "#1f2937",
  8: "#6b7280",
};

const BEST_TIME_QUERY_LIMIT = 500;

function specFor(difficulty: Difficulty, custom: DifficultySpec): DifficultySpec {
  if (difficulty === "custom") return clampCustom(custom);
  return difficultyConfig(difficulty);
}

function bestKeyFor(difficulty: Difficulty, spec: DifficultySpec): string {
  return `${difficulty}:${spec.rows}x${spec.cols}:${spec.mines}`;
}

function isDifficulty(value: unknown): value is Difficulty {
  return value === "beginner" || value === "intermediate" || value === "expert" || value === "custom";
}

function pad3(n: number): string {
  const clamped = Math.max(-99, Math.min(999, n));
  if (clamped < 0) return `-${String(Math.abs(clamped)).padStart(2, "0")}`;
  return String(clamped).padStart(3, "0");
}

function rowBestKey(row: Record<string, unknown>): string | null {
  const difficulty = isDifficulty(row.difficulty) ? row.difficulty : null;
  if (!difficulty) return null;
  const rows = typeof row.rows === "number" ? row.rows : Number(row.rows);
  const cols = typeof row.cols === "number" ? row.cols : Number(row.cols);
  const mines = typeof row.mines === "number" ? row.mines : Number(row.mines);
  if (Number.isFinite(rows) && Number.isFinite(cols) && Number.isFinite(mines)) {
    return bestKeyFor(difficulty, clampCustom({ rows, cols, mines }));
  }
  if (difficulty === "custom") return null;
  return bestKeyFor(difficulty, difficultyConfig(difficulty));
}

export default function App(): React.ReactElement {
  const [difficulty, setDifficulty] = useState<Difficulty>("beginner");
  const [custom, setCustom] = useState<DifficultySpec>({ rows: 16, cols: 16, mines: 40 });
  const [board, setBoard] = useState<Board>(() => createBoard(difficultyConfig("beginner")));
  const [seconds, setSeconds] = useState(0);
  const [face, setFace] = useState<Face>("happy");
  const [bestTimes, setBestTimes] = useState<Record<string, number>>({});
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [gameMeta, setGameMeta] = useState<GameMeta>(() => ({
    id: 0,
    difficulty: "beginner",
    spec: difficultyConfig("beginner"),
  }));

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const savedGameId = useRef<number | null>(null);
  const latestSecondsRef = useRef(seconds);
  const bestTimesRef = useRef(bestTimes);
  const pendingBestSavesRef = useRef<Record<string, PendingBestSave>>({});

  useEffect(() => {
    latestSecondsRef.current = seconds;
  }, [seconds]);

  useEffect(() => {
    bestTimesRef.current = bestTimes;
  }, [bestTimes]);

  const spec = useMemo(() => specFor(difficulty, custom), [difficulty, custom]);
  const bestKey = useMemo(() => bestKeyFor(difficulty, spec), [difficulty, spec]);

  // --- Responsive board sizing --------------------------------------------
  // The board area flexes to fill the remaining window space; we measure it
  // and derive a per-cell size so every difficulty (incl. Expert 30x16) fits
  // without clipping or scroll. Cells stay within a comfortable min/max range.
  const boardAreaRef = useRef<HTMLDivElement | null>(null);
  const [cellSize, setCellSize] = useState(30);

  useEffect(() => {
    const el = boardAreaRef.current;
    if (!el) return;

    const MIN_CELL = 12;
    const MAX_CELL = 34;
    const GRID_PADDING = 12; // .ms-grid padding (6px) on each side
    const CELL_MARGIN = 2; // .ms-cell margin (1px) on each side

    const recompute = () => {
      const node = boardAreaRef.current;
      if (!node) return;
      const availW = node.clientWidth;
      const availH = node.clientHeight;
      if (availW <= 0 || availH <= 0) return;
      const perCellExtra = CELL_MARGIN;
      const usableW = availW - GRID_PADDING;
      const usableH = availH - GRID_PADDING;
      const byW = Math.floor(usableW / board.cols) - perCellExtra;
      const byH = Math.floor(usableH / board.rows) - perCellExtra;
      const next = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.min(byW, byH)));
      setCellSize((prev) => (prev === next ? prev : next));
    };

    recompute();
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!RO) {
      window.addEventListener("resize", recompute);
      return () => window.removeEventListener("resize", recompute);
    }
    const ro = new RO(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [board.rows, board.cols]);

  // --- Timer ---------------------------------------------------------------
  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (board.status === "playing") {
      if (timerRef.current === null) {
        timerRef.current = setInterval(() => {
          setSeconds((s) => Math.min(999, s + 1));
        }, 1000);
      }
    } else {
      stopTimer();
    }
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [board.status, stopTimer]);

  // --- Best-time persistence ----------------------------------------------
  const loadBestTimes = useCallback(async () => {
    const db = window.MatrixOS?.db;
    if (!db) {
      return;
    }
    try {
      const rows = await db.find("times", { orderBy: { seconds: "asc" }, limit: BEST_TIME_QUERY_LIMIT });
      const best: Record<string, number> = {};
      for (const row of rows) {
        const key = rowBestKey(row);
        const secs = typeof row.seconds === "number" ? row.seconds : Number(row.seconds);
        if (!key || Number.isNaN(secs)) continue;
        if (best[key] === undefined || secs < best[key]) best[key] = secs;
      }
      setBestTimes(best);
    } catch (err) {
      console.warn("[minesweeper] failed to load best times from DB", err);
      setStatusMsg("Could not load best times");
    }
  }, []);

  useEffect(() => {
    void loadBestTimes();
    const db = window.MatrixOS?.db;
    if (!db) return;
    let unsub: (() => void) | undefined;
    try {
      unsub = db.onChange("times", () => {
        void loadBestTimes();
      });
    } catch (err) {
      console.warn("[minesweeper] failed to subscribe to best-time changes", err);
    }
    return () => {
      if (unsub) {
        try {
          unsub();
        } catch (err) {
          console.warn("[minesweeper] failed to unsubscribe", err);
        }
      }
    };
  }, [loadBestTimes]);

  const persistBestTime = useCallback(
    async (diff: Difficulty, bestSpec: DifficultySpec, secs: number) => {
      const key = bestKeyFor(diff, bestSpec);
      const db = window.MatrixOS?.db;
      if (!db) {
        setStatusMsg("Best time sync unavailable");
        return;
      }
      const previousBest = bestTimesRef.current[key];
      const pendingForKey = pendingBestSavesRef.current[key];
      if (previousBest !== undefined && previousBest < secs) return;
      if (previousBest === secs && pendingForKey?.secs !== secs) return;
      pendingBestSavesRef.current[key] = {
        secs,
        count: pendingForKey?.secs === secs ? pendingForKey.count + 1 : 1,
      };
      setBestTimes((prev) => {
        const current = prev[key];
        if (current !== undefined && current < secs) return prev;
        return { ...prev, [key]: secs };
      });

      try {
        const inserted = await db.insert("times", {
          difficulty: diff,
          rows: bestSpec.rows,
          cols: bestSpec.cols,
          mines: bestSpec.mines,
          seconds: secs,
        });
        try {
          const rows = await db.find("times", {
            where: { difficulty: diff, rows: bestSpec.rows, cols: bestSpec.cols, mines: bestSpec.mines },
            orderBy: { seconds: "asc" },
            limit: BEST_TIME_QUERY_LIMIT,
          });
          await Promise.all(
            rows
              .filter((row) => typeof row.id === "string" && row.id !== inserted.id && Number(row.seconds) > secs)
              .map((row) => db.delete("times", row.id as string)),
          );
        } catch (err) {
          console.warn("[minesweeper] failed to prune stale best times", err);
          setStatusMsg("Best time saved; cleanup pending");
          return;
        }
        setStatusMsg("Best time saved to Matrix Postgres");
      } catch (err) {
        console.warn("[minesweeper] failed to persist best time", err);
        setStatusMsg("Could not save best time");
        const hasEqualPendingSave = (pendingBestSavesRef.current[key]?.count ?? 0) > 1;
        setBestTimes((prev) => {
          if (hasEqualPendingSave) return prev;
          if (prev[key] !== secs) return prev;
          const next = { ...prev };
          if (previousBest === undefined) delete next[key];
          else next[key] = previousBest;
          return next;
        });
      } finally {
        const pending = pendingBestSavesRef.current[key];
        if (pending?.secs !== secs) return;
        if (pending.count <= 1) delete pendingBestSavesRef.current[key];
        else pendingBestSavesRef.current[key] = { secs, count: pending.count - 1 };
      }
    },
    [],
  );

  // --- Game lifecycle ------------------------------------------------------
  const newGame = useCallback(
    (nextSpec: DifficultySpec, nextDifficulty: Difficulty = difficulty) => {
      stopTimer();
      setBoard(createBoard(nextSpec));
      setGameMeta((current) => ({
        id: current.id + 1,
        difficulty: nextDifficulty,
        spec: nextSpec,
      }));
      setSeconds(0);
      setFace("happy");
      setStatusMsg("");
    },
    [difficulty, stopTimer],
  );

  // Re-create the board when difficulty/custom spec changes.
  useEffect(() => {
    newGame(spec, difficulty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [difficulty, spec.rows, spec.cols, spec.mines]);

  useEffect(() => {
    if (board.status === "won") {
      setFace("win");
      if (savedGameId.current !== gameMeta.id) {
        savedGameId.current = gameMeta.id;
        // Persist against the game metadata from the render that observed the
        // win. A difficulty/custom change can schedule a reset effect in the
        // same commit; using live difficulty/spec here would save the completed
        // game's time under the next board's key.
        const finalSecs = Math.max(1, latestSecondsRef.current);
        void persistBestTime(gameMeta.difficulty, gameMeta.spec, finalSecs);
      }
    } else if (board.status === "lost") {
      setFace("dead");
    }
  }, [board.status, gameMeta, persistBestTime]);

  const onReveal = useCallback(
    (r: number, c: number) => {
      setBoard((prev) => {
        if (prev.status === "won" || prev.status === "lost") return prev;
        return reveal(prev, r, c);
      });
    },
    [],
  );

  const onFlag = useCallback((r: number, c: number) => {
    setBoard((prev) => toggleFlag(prev, r, c));
  }, []);

  const onChord = useCallback(
    (r: number, c: number) => {
      setBoard((prev) => {
        if (prev.status !== "playing") return prev;
        return chord(prev, r, c);
      });
    },
    [],
  );

  // --- Pointer handling (left reveal, right flag, both = chord) ------------
  const pressed = useRef<{ left: boolean; right: boolean }>({ left: false, right: false });
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLongPress = useCallback(() => {
    if (longPress.current !== null) {
      clearTimeout(longPress.current);
      longPress.current = null;
    }
  }, []);

  // Tracks whether the most recent mouseup was a both-button chord, so the
  // synthetic click that follows knows to chord instead of reveal.
  const chordOnClick = useRef(false);

  const onMouseDownCell = useCallback(
    (e: React.MouseEvent) => {
      if (board.status === "won" || board.status === "lost") return;
      if (!pressed.current.left && !pressed.current.right) chordOnClick.current = false;
      if (e.button === 0) pressed.current.left = true;
      if (e.button === 2) pressed.current.right = true;
      if (e.button === 0 || (pressed.current.left && pressed.current.right)) {
        setFace("scared");
      }
    },
    [board.status],
  );

  const onMouseUpCell = useCallback((e: React.MouseEvent) => {
    if (pressed.current.left && pressed.current.right) chordOnClick.current = true;
    if (e.button === 0) pressed.current.left = false;
    if (e.button === 2) pressed.current.right = false;
  }, []);

  // The click handler is the source of truth for left-button reveals so it
  // works with both real pointer input and synthetic test clicks.
  const onClickCell = useCallback(
    (r: number, c: number) => {
      if (board.status === "won" || board.status === "lost") return;
      setFace((f) => (f === "scared" ? "happy" : f));
      const cell = board.cells[r]?.[c];
      if (!cell) return;
      if (chordOnClick.current || cell.state === CELL.REVEALED) {
        chordOnClick.current = false;
        onChord(r, c);
        return;
      }
      onReveal(r, c);
    },
    [board, onChord, onReveal],
  );

  const onContextMenuCell = useCallback(
    (e: React.MouseEvent, r: number, c: number) => {
      e.preventDefault();
      // Reset the right-press flag so a right-click alone flags rather than chords.
      pressed.current.right = false;
      onFlag(r, c);
    },
    [onFlag],
  );

  // Long-press on touch toggles a flag.
  const onTouchStartCell = useCallback(
    (r: number, c: number) => {
      clearLongPress();
      longPress.current = setTimeout(() => {
        onFlag(r, c);
        longPress.current = null;
      }, 350);
    },
    [clearLongPress, onFlag],
  );

  const onTouchEndCell = useCallback(
    (r: number, c: number) => {
      if (longPress.current !== null) {
        // Was a short tap -> reveal.
        clearLongPress();
        const cell = board.cells[r]?.[c];
        if (cell && cell.state === CELL.REVEALED) onChord(r, c);
        else onReveal(r, c);
      }
    },
    [board, clearLongPress, onChord, onReveal],
  );

  const onTouchCancelCell = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const remaining = minesRemaining(board);
  const flags = flagsPlaced(board);
  const best = bestTimes[bestKey];

  const faceGlyph =
    face === "win" ? "😎" : face === "dead" ? "😵" : face === "scared" ? "😮" : "🙂";

  return (
    <div className="ms-root">
      <div className="ms-frame">
        <header className="ms-header">
          <h1 className="ms-title">Minesweeper</h1>
          <div className="ms-difficulty" role="tablist" aria-label="Difficulty">
            {DIFFICULTIES.map((d) => (
              <button
                key={d.id}
                type="button"
                role="tab"
                aria-selected={difficulty === d.id}
                className={`ms-diff-btn${difficulty === d.id ? " is-active" : ""}`}
                onClick={() => setDifficulty(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </header>

        {difficulty === "custom" ? (
          <div className="ms-custom">
            <label>
              Width
              <input
                type="number"
                min={5}
                max={48}
                value={custom.cols}
                onChange={(e) => setCustom((p) => ({ ...p, cols: Number(e.target.value) }))}
              />
            </label>
            <label>
              Height
              <input
                type="number"
                min={5}
                max={30}
                value={custom.rows}
                onChange={(e) => setCustom((p) => ({ ...p, rows: Number(e.target.value) }))}
              />
            </label>
            <label>
              Mines
              <input
                type="number"
                min={1}
                max={spec.rows * spec.cols - 9}
                value={custom.mines}
                onChange={(e) => setCustom((p) => ({ ...p, mines: Number(e.target.value) }))}
              />
            </label>
          </div>
        ) : null}

        <div className="ms-panel">
          <div className="ms-readout" data-testid="mine-counter" aria-label="Mines remaining">
            {pad3(remaining)}
          </div>
          <button
            type="button"
            className="ms-reset"
            data-testid="reset"
            aria-label="New game"
            onClick={() => newGame(spec, difficulty)}
          >
            <span className="ms-face" aria-hidden="true">
              {faceGlyph}
            </span>
            <RotateCcw className="ms-reset-icon" size={14} aria-hidden="true" />
          </button>
          <div className="ms-readout" data-testid="timer" aria-label="Elapsed time">
            {pad3(seconds)}
          </div>
        </div>

        <div className="ms-board-area" ref={boardAreaRef}>
          <div
            className="ms-grid"
            style={{
              gridTemplateColumns: `repeat(${board.cols}, ${cellSize}px)`,
              ["--ms-cell" as string]: `${cellSize}px`,
            }}
            onContextMenu={(e) => e.preventDefault()}
            role="grid"
            tabIndex={-1}
            aria-label="Minefield"
          >
          {board.cells.map((row, r) =>
            row.map((cell, c) => {
              const idx = r * board.cols + c;
              const revealed = cell.state === CELL.REVEALED;
              const exploded = cell.state === CELL.EXPLODED;
              const flagged = cell.state === CELL.FLAGGED;
              const wrongFlag = cell.state === CELL.WRONG_FLAG;
              const showNumber = revealed && !cell.mine && cell.adjacent > 0;
              const showMine = (revealed || exploded) && cell.mine;
              return (
                <button
                  key={idx}
                  type="button"
                  data-testid={`cell-${idx}`}
                  data-state={cell.state}
                  className={`ms-cell${revealed || exploded ? " is-open" : ""}${
                    exploded ? " is-exploded" : ""
                  }${wrongFlag ? " is-wrong-flag" : ""}`}
                  style={showNumber ? { color: NUMBER_COLORS[cell.adjacent] } : undefined}
                  aria-label={
                    wrongFlag
                      ? "Incorrect flag"
                      : flagged
                      ? "Flagged cell"
                      : revealed
                        ? showNumber
                          ? `${cell.adjacent} adjacent mines`
                          : "Empty cell"
                        : "Hidden cell"
                  }
                  onMouseDown={onMouseDownCell}
                  onMouseUp={onMouseUpCell}
                  onClick={() => onClickCell(r, c)}
                  onContextMenu={(e) => onContextMenuCell(e, r, c)}
                  onTouchStart={() => onTouchStartCell(r, c)}
                  onTouchEnd={() => onTouchEndCell(r, c)}
                  onTouchCancel={onTouchCancelCell}
                >
                  {showNumber ? cell.adjacent : null}
                  {showMine ? <Bomb size={14} aria-hidden="true" /> : null}
                  {flagged ? <Flag size={13} className="ms-flag" aria-hidden="true" /> : null}
                  {wrongFlag ? <span className="ms-wrong-flag" aria-hidden="true">x</span> : null}
                </button>
              );
            }),
          )}
          </div>
        </div>

        <footer className="ms-footer">
          <div className="ms-stat" data-testid="best-time">
            <span className="ms-stat-label">Best</span>
            <span className="ms-stat-value">
              {best !== undefined ? `${best}s` : "—"}
            </span>
          </div>
          <div className="ms-stat">
            <span className="ms-stat-label">Flags</span>
            <span className="ms-stat-value">
              {flags}/{board.mines}
            </span>
          </div>
          <output className="ms-status" aria-live="polite">
            {board.status === "won"
              ? statusMsg
                ? `Cleared! ${statusMsg}`
                : "Cleared! 🎉"
              : board.status === "lost"
                ? "Boom — try again"
                : statusMsg}
          </output>
        </footer>
      </div>
    </div>
  );
}
