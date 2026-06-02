import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Sparkles, Trophy, Undo2, Wand2 } from "lucide-react";
import "./styles.css";
import {
  type Card,
  type Destination,
  type GameState,
  type Source,
  RANK_LABELS,
  SUIT_SYMBOLS,
  applyMove,
  autoCompleteStep,
  autoMoveToFoundation,
  canAutoComplete,
  deal,
  drawFromStock,
  findAutoDestination,
  isWon,
  suitColor,
} from "./solitaire-model";

const STATS_TABLE = "stats";
const DRAW_PREF_KEY = "solitaire:draw-mode";

interface Stats {
  id?: string;
  games_played: number;
  games_won: number;
  best_time: number; // seconds, 0 = none
  best_moves: number; // 0 = none
}

const EMPTY_STATS: Stats = { games_played: 0, games_won: 0, best_time: 0, best_moves: 0 };

function coerceStats(row: unknown): Stats {
  if (!row || typeof row !== "object") return { ...EMPTY_STATS };
  const r = row as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    games_played: num(r.games_played),
    games_won: num(r.games_won),
    best_time: num(r.best_time),
    best_moves: num(r.best_moves),
  };
}

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return "--:--";
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

interface AppProps {
  initialState?: GameState;
}

export default function App({ initialState }: AppProps) {
  const [draw, setDraw] = useState<1 | 3>(1);
  const [game, setGame] = useState<GameState>(() => initialState ?? deal(Math.random, draw));
  const [history, setHistory] = useState<GameState[]>([]);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const statsRef = useRef<Stats>(EMPTY_STATS);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(!initialState);
  const [selected, setSelected] = useState<Source | null>(null);
  const recordedWinRef = useRef(false);
  const countedInitialGameRef = useRef(Boolean(initialState));
  const statsLoadedRef = useRef(false);
  const statsRowIdRef = useRef<string | null>(null);
  const statsInsertRef = useRef<Promise<string> | null>(null);
  const pendingGamesPlayedRef = useRef(0);
  const startedAtRef = useRef<number>(Date.now());

  const won = isWon(game);

  useEffect(() => {
    statsRef.current = stats;
  }, [stats]);

  // ---- Stats persistence -------------------------------------------------
  const persistStats = useCallback(async (next: Stats) => {
    statsRef.current = next;
    setStats(next);
    const db = window.MatrixOS?.db;
    if (!db) return;
    const payload = {
      games_played: next.games_played,
      games_won: next.games_won,
      best_time: next.best_time,
      best_moves: next.best_moves,
    };
    try {
      const rowId = next.id ?? statsRowIdRef.current;
      if (rowId) {
        statsRowIdRef.current = rowId;
        await db.update(STATS_TABLE, rowId, payload);
      } else {
        if (!statsInsertRef.current) {
          statsInsertRef.current = db.insert(STATS_TABLE, payload)
            .then((res) => {
              statsRowIdRef.current = res.id;
              setStats((cur) => ({ ...cur, id: res.id }));
              return res.id;
            })
            .finally(() => {
              statsInsertRef.current = null;
            });
        }
        const insertedId = await statsInsertRef.current;
        await db.update(STATS_TABLE, insertedId, payload);
      }
    } catch (err: unknown) {
      console.warn("[solitaire] stats save failed:", err instanceof Error ? err.message : String(err));
      setError("Stats could not be saved to Matrix Postgres.");
    }
  }, []);

  const loadStats = useCallback(async () => {
    const db = window.MatrixOS?.db;
    if (!db) {
      setStats({ ...EMPTY_STATS });
      statsLoadedRef.current = true;
      return;
    }
    try {
      const rows = await db.find(STATS_TABLE, { limit: 1, orderBy: { created_at: "desc" } });
      if (rows && rows.length > 0) {
        const loaded = coerceStats(rows[0]);
        statsRowIdRef.current = loaded.id ?? null;
        setStats(loaded);
      } else {
        setStats({ ...EMPTY_STATS });
      }
      setError(null);
    } catch (err: unknown) {
      console.warn("[solitaire] stats load failed:", err instanceof Error ? err.message : String(err));
      setError("Stats could not be loaded.");
      setStats({ ...EMPTY_STATS });
    }
    statsLoadedRef.current = true;
  }, []);

  useEffect(() => {
    void loadStats();
    const db = window.MatrixOS?.db;
    return db?.onChange?.(STATS_TABLE, () => void loadStats());
  }, [loadStats]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const value = await window.MatrixOS?.readData?.(DRAW_PREF_KEY);
        if (!active) return;
        if (value === 1 || value === 3) {
          setDraw(value);
          if (!initialState) {
            setGame((current) => {
              if (current.moves !== 0 || current.drawCount === value) return current;
              startedAtRef.current = Date.now();
              return deal(Math.random, value);
            });
          }
        }
      } catch (err: unknown) {
        console.warn("[solitaire] draw preference load failed:", err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      active = false;
    };
  }, [initialState]);

  const recordGamePlayed = useCallback(() => {
    if (!statsLoadedRef.current) {
      pendingGamesPlayedRef.current += 1;
      return;
    }
    const cur = statsRef.current;
    const next = { ...cur, games_played: cur.games_played + 1 };
    statsRef.current = next;
    void persistStats(next);
  }, [persistStats]);

  useEffect(() => {
    if (!statsLoadedRef.current) return;
    let increment = pendingGamesPlayedRef.current;
    pendingGamesPlayedRef.current = 0;
    if (!countedInitialGameRef.current) {
      countedInitialGameRef.current = true;
      increment += 1;
    }
    if (increment === 0) return;
    const cur = statsRef.current;
    const next = { ...cur, games_played: cur.games_played + increment };
    statsRef.current = next;
    void persistStats(next);
  }, [persistStats, stats]);

  // ---- Timer -------------------------------------------------------------
  useEffect(() => {
    if (!running || won) return undefined;
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [running, won]);

  // ---- New game ----------------------------------------------------------
  const startNewGame = useCallback(
    (drawCount: 1 | 3 = draw) => {
      setGame(deal(Math.random, drawCount));
      setHistory([]);
      setSelected(null);
      setElapsed(0);
      setError(null);
      recordedWinRef.current = false;
      countedInitialGameRef.current = true;
      startedAtRef.current = Date.now();
      setRunning(true);
      recordGamePlayed();
    },
    [draw, recordGamePlayed],
  );

  const setDrawMode = useCallback((mode: 1 | 3) => {
    setDraw(mode);
    void window.MatrixOS?.writeData?.(DRAW_PREF_KEY, mode).catch((err: unknown) => {
      console.warn("[solitaire] draw preference save failed:", err instanceof Error ? err.message : String(err));
    });
    startNewGame(mode);
  }, [startNewGame]);

  // ---- Move application with history -------------------------------------
  const commit = useCallback((next: GameState) => {
    setHistory((h) => [...h.slice(-200), game]);
    setGame(next);
  }, [game]);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setGame(prev);
    setSelected(null);
  }, [history]);

  const doMove = useCallback(
    (src: Source, dest: Destination) => {
      const next = applyMove(game, src, dest);
      if (next) {
        commit(next);
        setSelected(null);
        return true;
      }
      return false;
    },
    [commit, game],
  );

  const sendToFoundation = useCallback(
    (src: Source) => {
      const next = autoMoveToFoundation(game, src);
      if (next) {
        commit(next);
        setSelected(null);
        return true;
      }
      return false;
    },
    [commit, game],
  );

  const handleDraw = useCallback(() => {
    setSelected(null);
    if (game.stock.length === 0 && game.waste.length === 0) return;
    commit(drawFromStock(game));
  }, [commit, game]);

  // ---- Click-to-move (auto route) ----------------------------------------
  const handleCardActivate = useCallback(
    (src: Source) => {
      // If a source is already selected, attempt to use this click as a destination.
      if (selected) {
        // clicking the same selection clears it
        if (sourceEquals(selected, src)) {
          setSelected(null);
          return;
        }
        const dest = sourceToDestination(src);
        if (dest) {
          if (doMove(selected, dest)) return;
          return;
        }
        setSelected(src);
        return;
      }
      // otherwise auto-route this source to a legal destination
      const dest = findAutoDestination(game, src);
      if (dest) {
        doMove(src, dest);
        return;
      }
      // nothing automatic: select it (so user can pick a destination pile)
      setSelected((cur) => (sourceEquals(cur, src) ? null : src));
    },
    [doMove, game, selected],
  );

  const handlePileActivate = useCallback(
    (dest: Destination) => {
      if (!selected) return;
      doMove(selected, dest);
    },
    [doMove, selected],
  );

  // ---- Drag and drop -----------------------------------------------------
  const dragRef = useRef<Source | null>(null);
  const onDragStart = useCallback((src: Source) => {
    dragRef.current = src;
    setSelected(null);
  }, []);
  const onDrop = useCallback(
    (dest: Destination) => {
      const src = dragRef.current;
      dragRef.current = null;
      if (src) doMove(src, dest);
    },
    [doMove],
  );

  // ---- Auto-complete -----------------------------------------------------
  const autoComplete = useCallback(() => {
    let cur: GameState | null = game;
    let last = game;
    let guard = 0;
    while (cur && !isWon(cur) && guard < 80) {
      const step = autoCompleteStep(cur);
      if (!step) break;
      last = step;
      cur = step;
      guard += 1;
    }
    if (last !== game) {
      setHistory((h) => [...h.slice(-200), game]);
      setGame(last);
    }
    setSelected(null);
  }, [game]);

  // ---- Win handling ------------------------------------------------------
  useEffect(() => {
    if (!won || recordedWinRef.current) return;
    recordedWinRef.current = true;
    setRunning(false);
    const cur = statsRef.current;
    const time = elapsed;
    const moves = game.moves;
    void persistStats({
      ...cur,
      games_won: cur.games_won + 1,
      best_time: cur.best_time === 0 ? time : Math.min(cur.best_time, time || cur.best_time),
      best_moves: cur.best_moves === 0 ? moves : Math.min(cur.best_moves, moves || cur.best_moves),
    });
  }, [won, elapsed, game.moves, persistStats]);

  // ---- Keyboard ----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if (e.key === "Escape") {
        setSelected(null);
      } else if (e.key === " " || e.key === "Spacebar") {
        if (game.stock.length > 0 || game.waste.length > 0) {
          e.preventDefault();
          handleDraw();
        }
      } else if (e.key.toLowerCase() === "n") {
        startNewGame();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game.stock.length, game.waste.length, handleDraw, startNewGame, undo]);

  const showAutoComplete = useMemo(() => canAutoComplete(game), [game]);
  const wasteTop = game.waste.length > 0 ? game.waste[game.waste.length - 1] : null;

  return (
    <main className="sol-app" data-reduced-ok>
      <header className="sol-bar">
        <div className="sol-brand">
          <span className="sol-mark" aria-hidden="true">
            <Sparkles size={16} />
          </span>
          <span>Matrix Solitaire</span>
        </div>
        <div className="sol-stats" aria-label="Game status">
          <Stat label="Time" value={formatTime(elapsed)} />
          <Stat label="Moves" value={String(game.moves)} />
          <Stat label="Score" value={String(game.score)} />
        </div>
        <div className="sol-controls">
          <div className="sol-segment" role="group" aria-label="Draw mode">
            <button
              type="button"
              className={draw === 1 ? "seg seg--on" : "seg"}
              onClick={() => setDrawMode(1)}
            >
              Draw 1
            </button>
            <button
              type="button"
              className={draw === 3 ? "seg seg--on" : "seg"}
              onClick={() => setDrawMode(3)}
            >
              Draw 3
            </button>
          </div>
          <button type="button" className="sol-btn" onClick={undo} disabled={history.length === 0} title="Undo (Cmd/Ctrl+Z)">
            <Undo2 size={15} /> Undo
          </button>
          {showAutoComplete && !won && (
            <button type="button" className="sol-btn sol-btn--accent" onClick={autoComplete} title="Auto-complete">
              <Wand2 size={15} /> Auto
            </button>
          )}
          <button type="button" className="sol-btn sol-btn--primary" onClick={() => startNewGame()} title="New game (N)">
            <RotateCcw size={15} /> New game
          </button>
        </div>
      </header>

      {error && <div className="sol-toast" role="status">{error}</div>}

      <section className="sol-table" aria-label="Solitaire board">
        <div className="sol-top">
          <div className="sol-deal">
            {/* Stock */}
            <button
              type="button"
              className="sol-slot sol-stock"
              data-testid="stock"
              aria-label={game.stock.length > 0 ? "Draw from stock" : "Recycle waste"}
              onClick={handleDraw}
            >
              {game.stock.length > 0 ? (
                <span className="sol-stock-back">{game.stock.length}</span>
              ) : (
                <span className="sol-recycle"><RotateCcw size={20} /></span>
              )}
            </button>
            {/* Waste */}
            <div className="sol-slot sol-waste" data-testid="waste">
              {wasteTop ? (
                <CardView
                  card={wasteTop}
                  selected={sourceEquals(selected, { type: "waste" })}
                  draggable
                  onActivate={() => handleCardActivate({ type: "waste" })}
                  onSendFoundation={() => sendToFoundation({ type: "waste" })}
                  onDragStart={() => onDragStart({ type: "waste" })}
                />
              ) : (
                <span className="sol-empty-mark">♢</span>
              )}
            </div>
          </div>

          <div className="sol-foundations">
            {game.foundations.map((pile, f) => {
              const top = pile.length > 0 ? pile[pile.length - 1] : null;
              return (
                <div
                  key={f}
                  className="sol-slot sol-foundation"
                  data-testid="foundation"
                  onClick={() => handlePileActivate({ type: "foundation", pile: f })}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop({ type: "foundation", pile: f })}
                >
                  {top ? (
                    <CardView
                      card={top}
                      draggable
                      onActivate={() => handleCardActivate({ type: "foundation", pile: f })}
                      onDragStart={() => onDragStart({ type: "foundation", pile: f })}
                    />
                  ) : (
                    <span className="sol-empty-mark">A</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="sol-tableau">
          {game.tableau.map((pile, t) => (
            <div
              key={t}
              className="sol-col"
              data-testid="tableau-pile"
              onClick={() => {
                if (pile.length === 0) handlePileActivate({ type: "tableau", pile: t });
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop({ type: "tableau", pile: t })}
            >
              {pile.length === 0 && <span className="sol-empty-mark sol-empty-mark--col">K</span>}
              {pile.map((card, idx) => {
                const src: Source = { type: "tableau", pile: t, index: idx };
                return (
                  <div
                    className="sol-stacked"
                    key={card.id}
                    style={{ top: `calc(${idx} * var(--stack-step))` }}
                  >
                    <CardView
                      card={card}
                      selected={sourceEquals(selected, src)}
                      draggable={card.faceUp}
                      onActivate={() => card.faceUp && handleCardActivate(src)}
                      onSendFoundation={() => idx === pile.length - 1 && sendToFoundation(src)}
                      onDragStart={() => card.faceUp && onDragStart(src)}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      {won && (
        <div className="sol-win" role="dialog" aria-label="You won" data-testid="win-banner">
          <div className="sol-confetti" aria-hidden="true">
            {Array.from({ length: 24 }).map((_, i) => (
              <i key={i} style={{ "--i": i } as React.CSSProperties} />
            ))}
          </div>
          <div className="sol-win-card">
            <Trophy size={34} />
            <h2>You win!</h2>
            <p>
              {game.moves} moves · {formatTime(elapsed)} · {stats.games_won} total wins
            </p>
            <button type="button" className="sol-btn sol-btn--primary" onClick={() => startNewGame()}>
              <RotateCcw size={15} /> Play again
            </button>
          </div>
        </div>
      )}

      <footer className="sol-footer">
        <span>
          Won {stats.games_won}/{stats.games_played}
        </span>
        <span>Best time {formatTime(stats.best_time)}</span>
        <span>Best moves {stats.best_moves || "--"}</span>
        <span className="sol-hint">Double-click → foundation · Cmd/Ctrl+Z undo · N new</span>
      </footer>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="sol-stat">
      <span className="sol-stat-label">{label}</span>
      <strong className="sol-stat-value">{value}</strong>
    </div>
  );
}

interface CardViewProps {
  card: Card;
  selected?: boolean;
  draggable?: boolean;
  onActivate?: () => void;
  onSendFoundation?: () => void;
  onDragStart?: () => void;
}

function CardView({ card, selected, draggable, onActivate, onSendFoundation, onDragStart }: CardViewProps) {
  if (!card.faceUp) {
    return <div className="sol-card sol-card--back" data-testid={`card-${card.id}`} aria-hidden="true" />;
  }
  const color = suitColor(card.suit);
  const symbol = SUIT_SYMBOLS[card.suit];
  const label = `${RANK_LABELS[card.rank]} of ${card.suit}`;
  return (
    <div
      className={`sol-card sol-card--${color}${selected ? " sol-card--selected" : ""}`}
      data-testid={`card-${card.id}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      draggable={draggable}
      onClick={(e) => {
        e.stopPropagation();
        onActivate?.();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onSendFoundation?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onActivate?.();
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer?.setData("text/plain", card.id);
        onDragStart?.();
      }}
    >
      <span className="sol-corner sol-corner--tl">
        <em>{RANK_LABELS[card.rank]}</em>
        <i>{symbol}</i>
      </span>
      <span className="sol-pip" aria-hidden="true">
        {symbol}
      </span>
      <span className="sol-corner sol-corner--br">
        <em>{RANK_LABELS[card.rank]}</em>
        <i>{symbol}</i>
      </span>
    </div>
  );
}

function sourceEquals(a: Source | null, b: Source | null): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "waste" && b.type === "waste") return true;
  if (a.type === "foundation" && b.type === "foundation") return a.pile === b.pile;
  if (a.type === "tableau" && b.type === "tableau") return a.pile === b.pile && a.index === b.index;
  return false;
}

// When a selected source is clicked onto another card, treat that card's pile
// as the destination.
function sourceToDestination(src: Source): Destination | null {
  if (src.type === "tableau") return { type: "tableau", pile: src.pile };
  if (src.type === "foundation") return { type: "foundation", pile: src.pile };
  return null;
}
