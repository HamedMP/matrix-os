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
const LS_KEY = "matrixos.backgammon.matches";

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
      // fall through to localStorage as a best-effort fallback
    }
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => ({
      winner: String((r as MatchRecord).winner ?? ""),
      points: Number((r as MatchRecord).points ?? 0),
    }));
  } catch (err) {
    console.warn("[backgammon] failed to read localStorage matches", err);
    return [];
  }
}

async function saveMatch(record: MatchRecord, setError: (s: string | null) => void): Promise<boolean> {
  const db = window.MatrixOS?.db;
  if (db) {
    try {
      await db.insert(MATCHES_TABLE, { winner: record.winner, points: record.points });
      return true;
    } catch (err) {
      console.warn("[backgammon] failed to persist match to DB", err);
      setError("Could not save the result to Matrix Postgres.");
      return false;
    }
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    const list: MatchRecord[] = raw ? (JSON.parse(raw) as MatchRecord[]) : [];
    list.unshift(record);
    window.localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 50)));
    return true;
  } catch (err) {
    console.warn("[backgammon] failed to persist match to localStorage", err);
    setError("Could not save the result.");
    return false;
  }
}

// ---- presentation helpers --------------------------------------------------

const PLAYER_NAME: Record<Player, string> = { white: "White", black: "Black" };

// Visual board layout. Top row (left->right) = points 13..18 | 19..24.
// Bottom row (left->right) = points 12..7 | 6..1. (Standard backgammon layout.)
const TOP_LEFT = [13, 14, 15, 16, 17, 18];
const TOP_RIGHT = [19, 20, 21, 22, 23, 24];
const BOTTOM_LEFT = [12, 11, 10, 9, 8, 7];
const BOTTOM_RIGHT = [6, 5, 4, 3, 2, 1];

function DieFace({ value, used, rolling }: { value: number; used: boolean; rolling: boolean }) {
  // pip positions for 1..6 on a 3x3 grid (indices 0..8)
  const map: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  const on = new Set(map[value] ?? []);
  return (
    <div className={`die${used ? " used" : ""}${rolling ? " rolling" : ""}`} aria-label={`die ${value}`}>
      {Array.from({ length: 9 }).map((_, i) => (
        <span key={i} className={`pip${on.has(i) ? "" : " off"}`} />
      ))}
    </div>
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

  // destinations available from the currently selected source
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
      saveMatch(record, setError).then((ok) => {
        if (ok) {
          setStatus("Saved to Matrix Postgres");
          setMatches((prev) => [record, ...prev]);
        }
      });
    }
  }, [state]);

  // auto-advance turn when no moves remain or none are possible
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

  const doMove = useCallback(
    (move: Move) => {
      setState((prev) => {
        const next = applyMove(prev, move);
        return next;
      });
      setSelected(null);
    },
    [],
  );

  // when movesLeft empties after a move, allow ending the turn
  useEffect(() => {
    if (!rolled || result) return;
    if (state.movesLeft.length === 0 && state.dice.length > 0) {
      // turn done
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
    setState((prev) => undoMove(prev));
    setSelected(null);
  }, []);

  const handleNewGame = useCallback(() => {
    setState(createInitialState());
    setSelected(null);
    setRolled(false);
    setResult(null);
    savedRef.current = false;
    setError(null);
    setStatus("Roll the dice to begin.");
  }, []);

  // keyboard: R roll, U undo, N new game
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

  const renderPoint = (point: number, position: "top" | "bottom") => {
    const pt = state.points[point];
    const isLegalTarget = legalTargets.has(point);
    const isSelected = selected === point;
    const movable = sourcesWithMoves.has(point);
    const triClass = point % 2 === 0 ? "a" : "b";
    const maxVisible = 5;
    const visible = Math.min(pt.count, maxVisible);
    const extra = pt.count - maxVisible;

    return (
      <div
        key={point}
        data-testid={`point-${point}`}
        className={`bg-point ${position}`}
        data-owner={pt.player ?? "none"}
        data-count={pt.count}
        data-legal={isLegalTarget ? "true" : "false"}
        data-selected={isSelected ? "true" : "false"}
        data-movable={movable ? "true" : "false"}
        onClick={() => (isLegalTarget ? handleTarget(point) : handleSource(point))}
        role="button"
        tabIndex={0}
        aria-label={`point ${point}${pt.player ? `, ${pt.count} ${pt.player}` : ", empty"}`}
      >
        <div className={`bg-triangle ${triClass}`} />
        <div className="bg-checkers">
          {Array.from({ length: visible }).map((_, i) => (
            <div
              key={i}
              className={`checker ${pt.player}${movable && i === visible - 1 ? " movable top-stack" : ""}`}
            />
          ))}
          {extra > 0 && <div className="checker-extra">+{extra}</div>}
        </div>
      </div>
    );
  };

  return (
    <div className="bg-app">
      <div className="bg-topbar">
        <div className="bg-title">
          <Dices size={20} />
          <span>Backgammon</span>
        </div>

        <div className="bg-spacer" />

        <div className="bg-pips">
          <div className="bg-pip">
            <span className="label">White pip</span>
            <span className="value" data-testid="pip-white">
              {pips.white}
            </span>
          </div>
          <div className="bg-pip">
            <span className="label">Black pip</span>
            <span className="value" data-testid="pip-black">
              {pips.black}
            </span>
          </div>
        </div>

        <div className="bg-turn" data-testid="turn-indicator">
          <span className={`dot ${state.turn}`} />
          {PLAYER_NAME[state.turn]} to {rolled ? "move" : "roll"}
        </div>

        <div className="bg-dice" data-testid="dice">
          {state.dice.length === 0 ? (
            <span className="bg-note">no roll</span>
          ) : (
            state.dice.map((d, i) => {
              const used = !diceStillAvailable(state, d, i);
              return <DieFace key={i} value={d} used={used} rolling={rolling} />;
            })
          )}
        </div>

        <button className="bg-btn primary" onClick={handleRoll} disabled={!canRoll}>
          Roll
        </button>
        {canPass ? (
          <button className="bg-btn" onClick={endTurn}>
            Pass
          </button>
        ) : null}
        <button className="bg-btn" onClick={handleUndo} disabled={state.history.length === 0} title="Undo (U)">
          <Undo2 size={15} />
        </button>
        <button className="bg-btn" onClick={handleNewGame} title="New game (N)">
          <RotateCcw size={15} />
        </button>
      </div>

      <div className="bg-board-wrap">
        <div className="bg-board" data-testid="board">
          {/* top-left quadrant: 13..18 */}
          <div className="bg-quadrant top">{TOP_LEFT.map((p) => renderPoint(p, "top"))}</div>

          {/* bar */}
          <div className="bg-bar">
            <div
              className="bar-slot"
              data-testid="bar-black"
              data-legal={onBar && state.turn === "black" && sourcesWithMoves.has(BAR) ? "true" : "false"}
              data-selected={selected === BAR && state.turn === "black" ? "true" : "false"}
              onClick={() => {
                if (state.turn === "black" && onBar) handleSource(BAR);
              }}
            >
              {Array.from({ length: state.bar.black }).map((_, i) => (
                <div key={i} className="checker black" />
              ))}
            </div>
            <div
              className="bar-slot"
              data-testid="bar-white"
              data-legal={onBar && state.turn === "white" && sourcesWithMoves.has(BAR) ? "true" : "false"}
              data-selected={selected === BAR && state.turn === "white" ? "true" : "false"}
              onClick={() => {
                if (state.turn === "white" && onBar) handleSource(BAR);
              }}
            >
              {Array.from({ length: state.bar.white }).map((_, i) => (
                <div key={i} className="checker white" />
              ))}
            </div>
          </div>

          {/* top-right quadrant: 19..24 (black home) */}
          <div className="bg-quadrant top">{TOP_RIGHT.map((p) => renderPoint(p, "top"))}</div>

          {/* off trays */}
          <div className="bg-off">
            <div
              className="bg-tray"
              data-testid="off-black"
              data-legal={selected !== null && legalTargets.has(OFF) && state.turn === "black" ? "true" : "false"}
              onClick={() => legalTargets.has(OFF) && state.turn === "black" && handleTarget(OFF)}
            >
              <span className="tray-label">Black off</span>
              {Array.from({ length: state.off.black }).map((_, i) => (
                <div key={i} className="bg-borne black" />
              ))}
            </div>
            <div
              className="bg-tray"
              data-testid="off-white"
              data-legal={selected !== null && legalTargets.has(OFF) && state.turn === "white" ? "true" : "false"}
              onClick={() => legalTargets.has(OFF) && state.turn === "white" && handleTarget(OFF)}
            >
              <span className="tray-label">White off</span>
              {Array.from({ length: state.off.white }).map((_, i) => (
                <div key={i} className="bg-borne white" />
              ))}
            </div>
          </div>

          {/* bottom-left quadrant: 12..7 */}
          <div className="bg-quadrant bottom">{BOTTOM_LEFT.map((p) => renderPoint(p, "bottom"))}</div>
          {/* bottom bar spacer (shares the .bg-bar column visually) */}
          <div className="bg-bar" style={{ visibility: "hidden", gridRow: "auto" }} />
          {/* bottom-right quadrant: 6..1 (white home) */}
          <div className="bg-quadrant bottom">{BOTTOM_RIGHT.map((p) => renderPoint(p, "bottom"))}</div>
          <div className="bg-off" style={{ visibility: "hidden", gridRow: "auto" }} />

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
              <button className="bg-btn primary" onClick={handleNewGame}>
                New game
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="bg-status">
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
      </div>
      <div className="bg-note" style={{ textAlign: "center" }}>
        Local two-player · doubling cube deferred · keys: R roll, U undo, N new game
      </div>
    </div>
  );
}

function other(p: Player): Player {
  return p === "white" ? "black" : "white";
}

// Determine whether the i-th rolled die is still unconsumed (for grey-out).
function diceStillAvailable(state: GameState, value: number, index: number): boolean {
  // Count how many of `value` remain vs how many were rolled.
  const rolledCount = state.dice.filter((d) => d === value).length;
  const leftCount = state.movesLeft.filter((d) => d === value).length;
  // The first `leftCount` occurrences are still available.
  const occurrenceIndex = state.dice.slice(0, index + 1).filter((d) => d === value).length;
  return occurrenceIndex <= leftCount && rolledCount > 0;
}
