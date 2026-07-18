import { useCallback, useEffect, useRef, useState } from "react";
import {
  DIFFICULTIES,
  chordCell,
  createGame,
  cycleMark,
  elapsedSeconds,
  minesRemaining,
  parseBestTimes,
  revealCell,
  type BestTimes,
  type Cell,
  type Difficulty,
  type Game,
} from "./minesweeper-model";

const BEST_TIMES_KEY = "winxp-minesweeper/best-times";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/* LCD seven-segment display                                           */
/* ------------------------------------------------------------------ */

// Segment order: a (top), b (top-right), c (bottom-right), d (bottom),
// e (bottom-left), f (top-left), g (middle).
const SEGMENTS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcfgd",
  "-": "g",
  " ": "",
};

const SEGMENT_RECTS: Record<string, { x: number; y: number; w: number; h: number }> = {
  a: { x: 2, y: 0, w: 10, h: 3 },
  b: { x: 11, y: 2, w: 3, h: 9 },
  c: { x: 11, y: 13, w: 3, h: 9 },
  d: { x: 2, y: 21, w: 10, h: 3 },
  e: { x: 0, y: 13, w: 3, h: 9 },
  f: { x: 0, y: 2, w: 3, h: 9 },
  g: { x: 2, y: 10.5, w: 10, h: 3 },
};

function LcdDigit({ char }: { char: string }) {
  const lit = SEGMENTS[char] ?? "";
  return (
    <svg viewBox="0 0 14 24" width="15" height="26" aria-hidden="true">
      {Object.entries(SEGMENT_RECTS).map(([seg, r]) => (
        <rect
          key={seg}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          rx={1}
          fill={lit.includes(seg) ? "#ff2018" : "#3a0d0b"}
        />
      ))}
    </svg>
  );
}

function Lcd({ value }: { value: number }) {
  const clamped = Math.max(-99, Math.min(999, value));
  const text = clamped < 0 ? `-${String(Math.abs(clamped)).padStart(2, "0")}` : String(clamped).padStart(3, "0");
  return (
    <div className="lcd" role="img" aria-label={String(clamped)}>
      {text.split("").map((char, i) => (
        <LcdDigit key={i} char={char} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Smiley face button                                                  */
/* ------------------------------------------------------------------ */

type Mood = "smile" | "ooh" | "dead" | "cool";

function Face({ mood }: { mood: Mood }) {
  return (
    <svg viewBox="0 0 36 36" width="26" height="26" aria-hidden="true">
      <circle cx="18" cy="18" r="15" fill="#ffe14d" stroke="#9c7d00" strokeWidth="1.6" />
      {mood === "cool" ? (
        <>
          <rect x="7" y="12.5" width="9" height="6" rx="2" fill="#202020" />
          <rect x="20" y="12.5" width="9" height="6" rx="2" fill="#202020" />
          <rect x="15.5" y="14" width="5" height="2" fill="#202020" />
          <path d="M12 25 q6 4 12 0" stroke="#5c4a00" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      ) : mood === "dead" ? (
        <>
          <path d="M10 12 l6 6 M16 12 l-6 6" stroke="#202020" strokeWidth="2" strokeLinecap="round" />
          <path d="M20 12 l6 6 M26 12 l-6 6" stroke="#202020" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 27 q3 -2 6 0 q3 2 6 0" stroke="#5c4a00" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="12.5" cy="14.5" r="2.2" fill="#202020" />
          <circle cx="23.5" cy="14.5" r="2.2" fill="#202020" />
          {mood === "ooh" ? (
            <ellipse cx="18" cy="25" rx="3.4" ry="4" fill="#7a4d00" />
          ) : (
            <path d="M11 23 q7 6 14 0" stroke="#5c4a00" strokeWidth="2" fill="none" strokeLinecap="round" />
          )}
        </>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Cell glyphs                                                         */
/* ------------------------------------------------------------------ */

function MineGlyph({ crossed }: { crossed: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path
        d="M10 2v16M2 10h16M4.3 4.3l11.4 11.4M15.7 4.3L4.3 15.7"
        stroke="#202020"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="10" cy="10" r="4.6" fill="#202020" />
      <circle cx="8.4" cy="8.4" r="1.3" fill="#ffffff" />
      {crossed ? <path d="M2 2l16 16" stroke="#ff2018" strokeWidth="2.2" strokeLinecap="round" /> : null}
    </svg>
  );
}

function FlagGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path d="M6 2v16" stroke="#202020" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6 3h9l-3.2 3.5L15 10H6z" fill="#e01b10" />
      <path d="M3.5 18h9" stroke="#202020" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function moodFor(game: Game, pressing: boolean): Mood {
  if (game.status === "won") return "cool";
  if (game.status === "lost") return "dead";
  return pressing ? "ooh" : "smile";
}

export default function App() {
  const [difficulty, setDifficulty] = useState<Difficulty>(DIFFICULTIES[0]);
  const [game, setGame] = useState<Game>(() => createGame(DIFFICULTIES[0]));
  const [bestTimes, setBestTimes] = useState<BestTimes>({});
  const [bestLoaded, setBestLoaded] = useState(false);
  const [pressing, setPressing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // A both-buttons chord fires on mousedown; swallow the trailing click and
  // contextmenu so they do not also reveal/flag the same cell.
  const chordHandled = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const read = window.MatrixOS?.readData;
        if (!read) return;
        const stored = parseBestTimes(await read(BEST_TIMES_KEY));
        if (!cancelled) setBestTimes(stored);
      } catch (err: unknown) {
        console.warn("[minesweeper] best times load failed:", errMsg(err));
      } finally {
        if (!cancelled) setBestLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (game.status !== "playing") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [game.status]);

  // Persist a new best time once per win.
  const recordedWin = useRef<Game | null>(null);
  useEffect(() => {
    if (game.status !== "won" || recordedWin.current === game || !bestLoaded) return;
    recordedWin.current = game;
    const seconds = elapsedSeconds(game, game.endedAt ?? Date.now());
    const current = bestTimes[game.difficulty.id];
    if (current !== undefined && current <= seconds) return;
    const next = { ...bestTimes, [game.difficulty.id]: seconds };
    setBestTimes(next);
    (async () => {
      try {
        await window.MatrixOS?.writeData?.(BEST_TIMES_KEY, next);
      } catch (err: unknown) {
        console.warn("[minesweeper] best times save failed:", errMsg(err));
      }
    })();
  }, [game, bestTimes, bestLoaded]);

  const reset = useCallback((next: Difficulty) => {
    setDifficulty(next);
    setGame(createGame(next));
    setPressing(false);
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, idx: number) => {
      if (e.buttons === 3) {
        // Left+right chord on a satisfied number.
        chordHandled.current = true;
        setGame((g) => chordCell(g, idx));
        return;
      }
      if (e.button === 0) setPressing(true);
    },
    [],
  );

  const handleClick = useCallback((idx: number) => {
    if (chordHandled.current) {
      chordHandled.current = false;
      return;
    }
    setGame((g) => {
      const cell = g.cells[idx];
      return cell.revealed && cell.adjacent > 0 ? chordCell(g, idx) : revealCell(g, idx);
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    if (chordHandled.current) {
      chordHandled.current = false;
      return;
    }
    setGame((g) => cycleMark(g, idx));
  }, []);

  const cellContent = (cell: Cell) => {
    if (cell.wrongFlag) return <MineGlyph crossed />;
    if (cell.revealed) {
      if (cell.mine) return <MineGlyph crossed={false} />;
      return cell.adjacent > 0 ? <span className={`n${cell.adjacent}`}>{cell.adjacent}</span> : null;
    }
    if (cell.mark === "flag") return <FlagGlyph />;
    if (cell.mark === "question") return <span className="question">?</span>;
    return null;
  };

  const { rows, cols } = game.difficulty;
  const seconds = elapsedSeconds(game, now);

  return (
    <div className="xp-app">
      <div className="xp-window">
        <div className="xp-menu">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.id}
              type="button"
              className={d.id === difficulty.id ? "xp-menu-item active" : "xp-menu-item"}
              onClick={() => reset(d)}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="xp-hud">
          <Lcd value={minesRemaining(game)} />
          <button
            type="button"
            className="xp-face"
            aria-label="New game"
            onClick={() => reset(difficulty)}
          >
            <Face mood={moodFor(game, pressing)} />
          </button>
          <Lcd value={seconds} />
        </div>

        <div className="xp-board-scroll">
          <div
            className="xp-board"
            style={{ gridTemplateColumns: `repeat(${cols}, var(--cell))` }}
            onMouseUp={() => setPressing(false)}
            onMouseLeave={() => setPressing(false)}
          >
            {game.cells.map((cell, idx) => {
              const classes = ["xp-cell"];
              if (cell.revealed) classes.push("revealed");
              if (cell.exploded) classes.push("exploded");
              const r = Math.floor(idx / cols);
              const c = idx % cols;
              return (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  className={classes.join(" ")}
                  aria-label={cell.revealed ? undefined : `Cell ${r + 1},${c + 1}`}
                  onMouseDown={(e) => handleMouseDown(e, idx)}
                  onClick={() => handleClick(idx)}
                  onContextMenu={(e) => handleContextMenu(e, idx)}
                >
                  {cellContent(cell)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="xp-status">
          <span>
            {game.status === "won"
              ? "You win!"
              : game.status === "lost"
                ? "Boom — game over."
                : `${rows}×${cols}, ${game.difficulty.mines} mines`}
          </span>
          <span className="xp-best">
            Best: {bestTimes[difficulty.id] !== undefined ? `${bestTimes[difficulty.id]}s` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
