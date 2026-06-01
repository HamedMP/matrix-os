import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dices, RotateCcw, Undo2 } from "lucide-react";
import "./styles.css";
import {
  BAR,
  OFF,
  type GameState,
  type Move,
  type Player,
  type WinResult,
  applyMove,
  createInitialState,
  generateLegalMoves,
  isGameOver,
  pipCount,
  rollDice,
  startTurn,
  undo as undoMove,
  winnerResult,
} from "./backgammon-model";

const MATCHES_TABLE = "matches";

interface MatchRecord {
  winner: string;
  points: number;
}

// ---- persistence -----------------------------------------------------------

async function loadMatches(setError: (s: string | null) => void): Promise<MatchRecord[]> {
  const db = window.MatrixOS?.db;
  if (db) {
    try {
      const rows = await db.find(MATCHES_TABLE, { orderBy: { created_at: "desc" }, limit: 50 });
      return rows.map((r) => ({
        winner: String(r.winner ?? ""),
        points: Number(r.points ?? 0),
      }));
    } catch (err) {
      console.warn("[backgammon] failed to load matches from DB", err);
      setError("Could not load match history.");
    }
  }
  return [];
}

async function saveMatch(record: MatchRecord, setError: (s: string | null) => void): Promise<boolean> {
  const db = window.MatrixOS?.db;
  if (db) {
    try {
      await db.insert(MATCHES_TABLE, {
        winner: record.winner,
        points: record.points,
        created_at: new Date().toISOString(),
      });
      return true;
    } catch (err) {
      console.warn("[backgammon] failed to persist match to DB", err);
      setError("Could not save the result to Matrix Postgres.");
      return false;
    }
  }
  setError("Match history sync is unavailable.");
  return false;
}

// ---- board geometry --------------------------------------------------------
// Single responsive SVG. viewBox units; the SVG scales to fit its container
// via CSS (width/height 100%, preserveAspectRatio). All coordinates below are
// in these abstract units.

const VB_W = 1000;
const VB_H = 640;
const FRAME = 16; // outer wood frame thickness
const PLAY_X = FRAME; // left edge of the felt play area
const PLAY_Y = FRAME;
const TRAY_W = 96; // bear-off tray on the right
const BAR_W = 56; // central bar
const PLAY_W = VB_W - FRAME * 2 - TRAY_W; // width of the two felt halves + bar
const PLAY_H = VB_H - FRAME * 2;
const HALF_W = (PLAY_W - BAR_W) / 2; // width of one 6-point half
const POINT_W = HALF_W / 6;
const POINT_H = PLAY_H * 0.42; // triangle height
const CHK_R = POINT_W * 0.42; // checker radius
const CHK_GAP = CHK_R * 1.78; // vertical spacing between stacked checkers
const MAX_VISIBLE = 5;

const leftHalfX = PLAY_X;
const barX = PLAY_X + HALF_W;
const rightHalfX = barX + BAR_W;
const trayX = rightHalfX + HALF_W;

// Map a board point (1..24) to its column slot.
// Visual standard layout:
//   top row L->R:    13 14 15 16 17 18 | 19 20 21 22 23 24
//   bottom row L->R: 12 11 10  9  8  7 |  6  5  4  3  2  1
interface Slot {
  cx: number; // center X of the point column
  baseY: number; // Y at the open edge (where checker stack starts)
  dir: 1 | -1; // +1 stacks downward (top points), -1 stacks upward (bottom points)
  top: boolean;
}

function pointSlot(point: number): Slot {
  // top points: 13..24
  if (point >= 13) {
    const idx = point - 13; // 0..11 left to right
    const half = idx < 6 ? 0 : 1;
    const within = half === 0 ? idx : idx - 6;
    const halfStart = half === 0 ? leftHalfX : rightHalfX;
    const cx = halfStart + within * POINT_W + POINT_W / 2;
    return { cx, baseY: PLAY_Y, dir: 1, top: true };
  }
  // bottom points: 1..12. bottom-left (L->R) = 12 11 10 9 8 7, bottom-right = 6 5 4 3 2 1
  const idx = 12 - point; // point 12 -> idx 0 (leftmost), point 1 -> idx 11 (rightmost)
  const half = idx < 6 ? 0 : 1;
  const within = half === 0 ? idx : idx - 6;
  const halfStart = half === 0 ? leftHalfX : rightHalfX;
  const cx = halfStart + within * POINT_W + POINT_W / 2;
  return { cx, baseY: PLAY_Y + PLAY_H, dir: -1, top: false };
}

// Stacked checker centers for a point, clamped to MAX_VISIBLE.
function stackCenters(slot: Slot, count: number): { cy: number }[] {
  const n = Math.min(count, MAX_VISIBLE);
  const out: { cy: number }[] = [];
  const first = slot.baseY + slot.dir * (CHK_R + 4);
  for (let i = 0; i < n; i++) {
    out.push({ cy: first + slot.dir * i * CHK_GAP });
  }
  return out;
}

// Bar checker stack: vertical column from the top or bottom row toward center.
function barCenters(count: number, fromTop: boolean): number[] {
  const n = Math.min(count, MAX_VISIBLE);
  const out: number[] = [];
  const dir = fromTop ? 1 : -1;
  const start = fromTop ? PLAY_Y + CHK_R + 6 : PLAY_Y + PLAY_H - CHK_R - 6;
  for (let i = 0; i < n; i++) out.push(start + dir * i * CHK_GAP);
  return out;
}

const barCx = barX + BAR_W / 2;
const trayCx = trayX + TRAY_W / 2;
const TRAY_INNER_W = TRAY_W - 18;
const BORNE_H = 13;

const PLAYER_NAME: Record<Player, string> = { white: "White", black: "Black" };

// pip positions for die faces 1..6 on a 3x3 grid (cell indices 0..8)
const DIE_PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function DieFace({ value, used, rolling }: { value: number; used: boolean; rolling: boolean }) {
  const on = new Set(DIE_PIPS[value] ?? []);
  return (
    <div className={`die${used ? " used" : ""}${rolling ? " rolling" : ""}`} aria-label={`die ${value}`}>
      {Array.from({ length: 9 }).map((_, i) => (
        <span key={i} className={`pip${on.has(i) ? "" : " off"}`} />
      ))}
    </div>
  );
}

// Bear-off tray fill: each borne checker is a thin stacked horizontal bar.
function TrayStack({ count, player, fromTop }: { count: number; player: Player; fromTop: boolean }) {
  const dir = fromTop ? 1 : -1;
  const start = fromTop ? PLAY_Y + 20 : PLAY_Y + PLAY_H - 20 - BORNE_H;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <rect
          key={`${player}-${i}`}
          className={`borne ${player}`}
          x={trayCx - TRAY_INNER_W / 2}
          y={start + dir * i * (BORNE_H + 2)}
          width={TRAY_INNER_W}
          height={BORNE_H}
          rx={3}
        />
      ))}
    </>
  );
}

export default function App() {
  const [state, setState] = useState<GameState>(() => createInitialState());
  const [selected, setSelected] = useState<number | null>(null);
  const [rolled, setRolled] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Roll the dice to begin.");
  const [result, setResult] = useState<WinResult | null>(null);
  const savedRef = useRef(false);

  // load history + subscribe
  useEffect(() => {
    let active = true;
    loadMatches(setError).then((rows) => {
      if (active) setMatches(rows);
    });
    const db = window.MatrixOS?.db;
    let unsub: (() => void) | undefined;
    if (db) {
      try {
        unsub = db.onChange(MATCHES_TABLE, () => {
          loadMatches(setError).then((rows) => setMatches(rows));
        });
      } catch (err) {
        console.warn("[backgammon] onChange subscription failed", err);
      }
    }
    return () => {
      active = false;
      if (unsub) unsub();
    };
  }, []);

  const legalMoves = useMemo<Move[]>(() => {
    if (!rolled || result) return [];
    return generateLegalMoves(state);
  }, [state, rolled, result]);

  const legalFromSelected = useMemo<Move[]>(() => {
    if (selected === null) return [];
    return legalMoves.filter((m) => m.from === selected);
  }, [legalMoves, selected]);

  const legalTargets = useMemo(() => new Set(legalFromSelected.map((m) => m.to)), [legalFromSelected]);
  const sourcesWithMoves = useMemo(() => new Set(legalMoves.map((m) => m.from)), [legalMoves]);

  const pips = useMemo(
    () => ({ white: pipCount(state, "white"), black: pipCount(state, "black") }),
    [state],
  );

  // end-of-game detection + persistence
  useEffect(() => {
    if (!isGameOver(state)) return;
    const res = winnerResult(state);
    setResult(res);
    if (res && !savedRef.current) {
      savedRef.current = true;
      const record: MatchRecord = { winner: res.winner, points: res.points };
      const usedDb = Boolean(window.MatrixOS?.db);
      saveMatch(record, setError).then((ok) => {
        if (ok) {
          setStatus(usedDb ? "Saved to Matrix Postgres" : "Saved");
          setMatches((prev) => [record, ...prev]);
        }
      });
    }
  }, [state]);

  useEffect(() => {
    if (!rolled || result) return;
    if (legalMoves.length === 0) {
      if (state.movesLeft.length === 0) {
        setStatus(`${PLAYER_NAME[state.turn]} finished. ${PLAYER_NAME[other(state.turn)]} to roll.`);
      } else {
        setStatus(`No legal moves for ${PLAYER_NAME[state.turn]} — pass.`);
      }
    }
  }, [legalMoves, rolled, result, state.movesLeft.length, state.turn]);

  const handleRoll = useCallback(() => {
    if (rolled || result) return;
    const roll = rollDice();
    setRolling(true);
    const next = startTurn(state, roll);
    setState(next);
    setRolled(true);
    setSelected(null);
    setError(null);
    setStatus(`${PLAYER_NAME[next.turn]} rolled ${roll.values[0]} & ${roll.values[1]}.`);
    window.setTimeout(() => setRolling(false), 420);
  }, [state, rolled, result]);

  const endTurn = useCallback(() => {
    setState((prev) => ({ ...prev, turn: other(prev.turn), movesLeft: [], dice: [], history: [] }));
    setRolled(false);
    setSelected(null);
  }, []);

  const doMove = useCallback((move: Move) => {
    setState((prev) => applyMove(prev, move));
    setSelected(null);
  }, []);

  useEffect(() => {
    if (!rolled || result) return;
    if (state.movesLeft.length === 0 && state.dice.length > 0) {
      const timer = window.setTimeout(endTurn, 250);
      return () => window.clearTimeout(timer);
    }
  }, [state.movesLeft.length, state.dice.length, rolled, result, endTurn]);

  const handleSource = useCallback(
    (point: number) => {
      if (!rolled || result) return;
      if (!sourcesWithMoves.has(point)) return;
      setSelected((cur) => (cur === point ? null : point));
    },
    [rolled, result, sourcesWithMoves],
  );

  const handleTarget = useCallback(
    (to: number) => {
      if (selected === null) return;
      const move = legalFromSelected.find((m) => m.to === to);
      if (!move) return;
      doMove(move);
    },
    [selected, legalFromSelected, doMove],
  );

  const handleUndo = useCallback(() => {
    if (result) return;
    setState((prev) => undoMove(prev));
    setSelected(null);
  }, [result]);

  const handleNewGame = useCallback(() => {
    setState(createInitialState());
    setSelected(null);
    setRolled(false);
    setResult(null);
    savedRef.current = false;
    setError(null);
    setStatus("Roll the dice to begin.");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "r" || e.key === "R") handleRoll();
      else if ((e.key === "z" && (e.metaKey || e.ctrlKey)) || e.key === "u" || e.key === "U") {
        e.preventDefault();
        handleUndo();
      } else if (e.key === "n" || e.key === "N") handleNewGame();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleRoll, handleUndo, handleNewGame]);

  const onBar = state.turn === "white" ? state.bar.white > 0 : state.bar.black > 0;
  const canRoll = !rolled && !result;
  const canPass = rolled && !result && legalMoves.length === 0 && state.movesLeft.length > 0;

  // -- click routing for a point: prefer landing if it's a legal target --------
  const onPointClick = useCallback(
    (point: number) => {
      if (legalTargets.has(point)) handleTarget(point);
      else handleSource(point);
    },
    [legalTargets, handleTarget, handleSource],
  );

  const offTargetable = (player: Player) =>
    selected !== null && legalTargets.has(OFF) && state.turn === player;

  // ---- SVG point rendering ---------------------------------------------------
  const renderPoint = (point: number) => {
    const pt = state.points[point];
    const slot = pointSlot(point);
    const isLegalTarget = legalTargets.has(point);
    const isSelected = selected === point;
    const movable = sourcesWithMoves.has(point);
    const odd = point % 2 === 1;

    // triangle apex points toward the center of the board
    const apexY = slot.baseY + slot.dir * POINT_H;
    const x0 = slot.cx - POINT_W / 2 + 1.5;
    const x1 = slot.cx + POINT_W / 2 - 1.5;
    const tri = `${x0},${slot.baseY} ${x1},${slot.baseY} ${slot.cx},${apexY}`;

    const centers = stackCenters(slot, pt.count);
    const extra = pt.count - MAX_VISIBLE;
    // label position for the +N count: just inside the apex of the last checker
    const lastCy = centers.length ? centers[centers.length - 1].cy : slot.baseY;

    return (
      <g
        key={point}
        data-testid={`point-${point}`}
        data-owner={pt.player ?? "none"}
        data-count={pt.count}
        data-legal={isLegalTarget ? "true" : "false"}
        data-selected={isSelected ? "true" : "false"}
        data-movable={movable ? "true" : "false"}
        className={`pt${isLegalTarget ? " legal" : ""}${isSelected ? " selected" : ""}${movable ? " movable" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`point ${point}${pt.player ? `, ${pt.count} ${pt.player}` : ", empty"}`}
        onClick={() => onPointClick(point)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPointClick(point);
          }
        }}
      >
        <polygon className={`tri ${odd ? "tri-a" : "tri-b"}`} points={tri} />
        {isLegalTarget ? <polygon className="tri-target" points={tri} /> : null}
        {isSelected ? <polygon className="tri-selected" points={tri} /> : null}
        {centers.map((c, i) => {
          const top = i === centers.length - 1;
          return (
            <circle
              key={i}
              className={`chk ${pt.player}${movable && top ? " movable-top" : ""}`}
              cx={slot.cx}
              cy={c.cy}
              r={CHK_R}
            />
          );
        })}
        {extra > 0 ? (
          <text className="chk-count" x={slot.cx} y={lastCy} dominantBaseline="central" textAnchor="middle">
            +{extra}
          </text>
        ) : null}
        {/* invisible hit area so the whole column is clickable */}
        <rect
          className="hit"
          x={slot.cx - POINT_W / 2}
          y={slot.top ? PLAY_Y : PLAY_Y + PLAY_H / 2}
          width={POINT_W}
          height={PLAY_H / 2}
          fill="transparent"
        />
      </g>
    );
  };

  // black hit checkers sit on the top of the bar, white on the bottom (mirrors home dirs)
  const blackBarLegal = onBar && state.turn === "black" && sourcesWithMoves.has(BAR);
  const whiteBarLegal = onBar && state.turn === "white" && sourcesWithMoves.has(BAR);

  return (
    <div className="bg-app">
      {/* ---------- header ---------- */}
      <header className="bg-topbar">
        <div className="bg-title">
          <Dices size={18} />
          <span>Backgammon</span>
        </div>

        <div className="bg-turn" data-testid="turn-indicator">
          <span className={`dot ${state.turn}`} />
          {PLAYER_NAME[state.turn]} to {rolled ? "move" : "roll"}
        </div>

        <div className="bg-dice" data-testid="dice">
          {state.dice.length === 0 ? (
            <span className="bg-note">tap roll</span>
          ) : (
            // Doubles still render as the two rolled dice; movesLeft carries
            // four consumable die plays and drives the used/available state.
            state.dice.map((d, i) => {
              const used = !diceStillAvailable(state, d, i);
              return <DieFace key={i} value={d} used={used} rolling={rolling} />;
            })
          )}
        </div>

        <div className="bg-spacer" />

        <div className="bg-pips">
          <div className="bg-pip">
            <span className="label">White</span>
            <span className="value" data-testid="pip-white">
              {pips.white}
            </span>
          </div>
          <div className="bg-pip">
            <span className="label">Black</span>
            <span className="value" data-testid="pip-black">
              {pips.black}
            </span>
          </div>
        </div>

        <div className="bg-actions">
          <button type="button" className="bg-btn primary" onClick={handleRoll} disabled={!canRoll}>
            <Dices size={15} /> Roll
          </button>
          {canPass ? (
            <button type="button" className="bg-btn" onClick={endTurn}>
              Pass
            </button>
          ) : null}
          <button
            type="button"
            className="bg-btn icon"
            onClick={handleUndo}
            disabled={!!result || state.history.length === 0}
            title="Undo (U)"
            aria-label="Undo"
          >
            <Undo2 size={15} />
          </button>
          <button
            type="button"
            className="bg-btn icon"
            onClick={handleNewGame}
            title="New game (N)"
            aria-label="New game"
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </header>

      {/* ---------- board ---------- */}
      <div className="bg-board-wrap">
        <div className="bg-board" data-testid="board">
          <svg
            className="bg-svg"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Backgammon board"
          >
            {/* wood frame */}
            <rect className="frame" x={0} y={0} width={VB_W} height={VB_H} rx={20} />
            {/* felt halves */}
            <rect className="felt" x={leftHalfX} y={PLAY_Y} width={HALF_W} height={PLAY_H} />
            <rect className="felt" x={rightHalfX} y={PLAY_Y} width={HALF_W} height={PLAY_H} />
            {/* center bar */}
            <rect className="bar" x={barX} y={PLAY_Y} width={BAR_W} height={PLAY_H} rx={6} />
            {/* bear-off tray */}
            <rect className="tray" x={trayX + 4} y={PLAY_Y} width={TRAY_W - 8} height={PLAY_H} rx={8} />
            <line
              className="tray-divider"
              x1={trayX + 12}
              y1={PLAY_Y + PLAY_H / 2}
              x2={trayX + TRAY_W - 12}
              y2={PLAY_Y + PLAY_H / 2}
            />

            {/* points */}
            {Array.from({ length: 24 }, (_, i) => renderPoint(i + 1))}

            {/* bar: hit checkers + click targets */}
            <g
              data-testid="bar-black"
              data-legal={blackBarLegal ? "true" : "false"}
              data-selected={selected === BAR && state.turn === "black" ? "true" : "false"}
              className={`bar-slot${blackBarLegal ? " legal" : ""}${selected === BAR && state.turn === "black" ? " selected" : ""}`}
              onClick={() => {
                if (state.turn === "black" && onBar) handleSource(BAR);
              }}
            >
              <rect
                className="bar-hit"
                x={barX}
                y={PLAY_Y}
                width={BAR_W}
                height={PLAY_H / 2}
                fill="transparent"
              />
              {barCenters(state.bar.black, true).map((cy, i) => (
                <circle key={i} className="chk black" cx={barCx} cy={cy} r={CHK_R} />
              ))}
            </g>
            <g
              data-testid="bar-white"
              data-legal={whiteBarLegal ? "true" : "false"}
              data-selected={selected === BAR && state.turn === "white" ? "true" : "false"}
              className={`bar-slot${whiteBarLegal ? " legal" : ""}${selected === BAR && state.turn === "white" ? " selected" : ""}`}
              onClick={() => {
                if (state.turn === "white" && onBar) handleSource(BAR);
              }}
            >
              <rect
                className="bar-hit"
                x={barX}
                y={PLAY_Y + PLAY_H / 2}
                width={BAR_W}
                height={PLAY_H / 2}
                fill="transparent"
              />
              {barCenters(state.bar.white, false).map((cy, i) => (
                <circle key={i} className="chk white" cx={barCx} cy={cy} r={CHK_R} />
              ))}
            </g>

            {/* off trays (black top, white bottom — matches home-board sides) */}
            <g
              data-testid="off-black"
              data-legal={offTargetable("black") ? "true" : "false"}
              className={`tray-slot${offTargetable("black") ? " legal" : ""}`}
              onClick={() => offTargetable("black") && handleTarget(OFF)}
            >
              <rect
                className="tray-hit"
                x={trayX + 4}
                y={PLAY_Y}
                width={TRAY_W - 8}
                height={PLAY_H / 2}
                fill="transparent"
              />
              <TrayStack count={state.off.black} player="black" fromTop />
            </g>
            <g
              data-testid="off-white"
              data-legal={offTargetable("white") ? "true" : "false"}
              className={`tray-slot${offTargetable("white") ? " legal" : ""}`}
              onClick={() => offTargetable("white") && handleTarget(OFF)}
            >
              <rect
                className="tray-hit"
                x={trayX + 4}
                y={PLAY_Y + PLAY_H / 2}
                width={TRAY_W - 8}
                height={PLAY_H / 2}
                fill="transparent"
              />
              <TrayStack count={state.off.white} player="white" fromTop={false} />
            </g>

            <text className="tray-tag" x={trayCx} y={PLAY_Y + PLAY_H / 2 - 4} textAnchor="middle">
              {state.off.black}
            </text>
            <text className="tray-tag" x={trayCx} y={PLAY_Y + PLAY_H / 2 + 16} textAnchor="middle">
              {state.off.white}
            </text>
          </svg>

          {result ? (
            <div className="bg-overlay">
              <h2>{PLAYER_NAME[result.winner]} wins!</h2>
              <p>
                {result.label === "single"
                  ? "Single game"
                  : result.label === "gammon"
                    ? "Gammon"
                    : "Backgammon"}{" "}
                · {result.points} point{result.points > 1 ? "s" : ""}
              </p>
              <button type="button" className="bg-btn primary" onClick={handleNewGame}>
                New game
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* ---------- footer ---------- */}
      <footer className="bg-status">
        {error ? (
          <span className="err">{error}</span>
        ) : status === "Saved to Matrix Postgres" ? (
          <span className="ok">{status}</span>
        ) : (
          <span>{status}</span>
        )}
        <span className="bg-records" data-testid="match-count">
          {matches.length} match{matches.length === 1 ? "" : "es"} recorded
        </span>
      </footer>
    </div>
  );
}

function other(p: Player): Player {
  return p === "white" ? "black" : "white";
}

// Determine whether the i-th rolled die is still unconsumed (for grey-out).
function diceStillAvailable(state: GameState, value: number, index: number): boolean {
  const rolledCount = state.dice.filter((d) => d === value).length;
  const leftCount = state.movesLeft.filter((d) => d === value).length;
  const occurrenceIndex = state.dice.slice(0, index + 1).filter((d) => d === value).length;
  return occurrenceIndex <= leftCount && rolledCount > 0;
}
