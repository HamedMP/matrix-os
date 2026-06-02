import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Bot, Brain, FlipVertical2, RotateCcw, Save, Sparkles, Swords, Trophy, Users } from "lucide-react";
import {
  PIECE_GLYPHS,
  capturedFromHistory,
  groupMovesIntoPairs,
  materialDelta,
  squareColor,
  squaresOfBoard,
  type PieceColor,
  type PieceLike,
  type PieceType,
} from "./chess-model";
import { DIFFICULTY_DEPTH, findBestMove, type ChessLike, type Difficulty } from "./chess-ai";
import "./styles.css";

const GAMES_TABLE = "games";
const LS_KEY = "matrixos.chess.games";
const PROMOTION_PIECES: PieceType[] = ["q", "r", "b", "n"];

type SaveState = "idle" | "saving" | "saved" | "error";
type GameMode = "two-player" | "vs-computer";

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

interface VerboseMove {
  from: string;
  to: string;
  san: string;
  color: PieceColor;
  piece: PieceType;
  captured?: PieceType;
  promotion?: PieceType;
}

interface PendingPromotion {
  from: string;
  to: string;
  color: PieceColor;
}

interface StatusInfo {
  text: string;
  tone: "turn" | "check" | "win" | "draw";
  result: string | null;
}

function colorName(color: PieceColor): string {
  return color === "w" ? "White" : "Black";
}

/** Decide game status from the chess.js engine. */
function deriveStatus(game: Chess): StatusInfo {
  const turn = game.turn() as PieceColor;
  if (game.isCheckmate()) {
    const winner = turn === "w" ? "Black" : "White";
    return { text: `Checkmate — ${winner} wins`, tone: "win", result: turn === "w" ? "0-1" : "1-0" };
  }
  if (game.isStalemate()) {
    return { text: "Stalemate — draw", tone: "draw", result: "1/2-1/2" };
  }
  if (game.isDraw()) {
    return { text: "Draw", tone: "draw", result: "1/2-1/2" };
  }
  if (game.isCheck()) {
    return { text: `${colorName(turn)} is in check`, tone: "check", result: null };
  }
  return { text: `${colorName(turn)} to move`, tone: "turn", result: null };
}

async function persistGame(pgn: string, result: string): Promise<void> {
  const db = window.MatrixOS?.db;
  if (db) {
    await db.insert(GAMES_TABLE, { pgn, result });
    return;
  }
  if (window.MatrixOS) return;
  // localStorage fallback when the DB bridge is unavailable.
  const raw = window.localStorage.getItem(LS_KEY);
  let prior: unknown[] = [];
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) prior = parsed;
  } catch (err: unknown) {
    console.warn("[chess] could not parse saved games:", err instanceof Error ? err.message : String(err));
  }
  prior.unshift({ pgn, result, created_at: new Date().toISOString() });
  window.localStorage.setItem(LS_KEY, JSON.stringify(prior.slice(0, 50)));
}

export default function App() {
  const gameRef = useRef(new Chess());
  const [, forceVersion] = useState(0);
  const bump = useCallback(() => forceVersion((v) => v + 1), []);

  const [selected, setSelected] = useState<string | null>(null);
  const [legalTargets, setLegalTargets] = useState<Set<string>>(new Set());
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [gamesPlayed, setGamesPlayed] = useState<number>(0);
  const savedResultRef = useRef(false);

  // AI opponent configuration. `humanColor` is the side the user plays in
  // vs-computer mode; the engine plays the other side. `thinking` disables input
  // while the AI search runs.
  const [mode, setMode] = useState<GameMode>("two-player");
  const [humanColor, setHumanColor] = useState<PieceColor>("w");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [thinking, setThinking] = useState(false);
  // Latest settings, read inside the deferred AI callback without re-subscribing.
  const aiConfigRef = useRef({ mode, humanColor, difficulty });
  aiConfigRef.current = { mode, humanColor, difficulty };
  // Guards against double-scheduling and lets New game / Undo cancel a pending move.
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiRunIdRef = useRef(0);
  // Mirrors whether human input is currently locked, so the move callbacks can
  // read it without being re-created on every think tick.
  const inputLockedRef = useRef(false);

  const game = gameRef.current;
  const status = deriveStatus(game);
  const verbose = game.history({ verbose: true }) as unknown as VerboseMove[];
  const sanHistory = verbose.map((m) => m.san);
  const pairs = groupMovesIntoPairs(sanHistory);
  const captured = capturedFromHistory(verbose);
  const delta = materialDelta(captured.byWhite, captured.byBlack);

  // Load prior game count (DB or localStorage) for the stats rail.
  const reloadStats = useCallback(async () => {
    const db = window.MatrixOS?.db;
    try {
      setError(null);
      const clearStatsError = () => setSaveState((current) => current === "error" ? "idle" : current);
      if (db) {
        const n = await db.count(GAMES_TABLE);
        setGamesPlayed(typeof n === "number" ? n : 0);
        clearStatsError();
        return;
      }
      if (window.MatrixOS) {
        setGamesPlayed(0);
        clearStatsError();
        return;
      }
      const raw = window.localStorage.getItem(LS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      setGamesPlayed(Array.isArray(parsed) ? parsed.length : 0);
      clearStatsError();
    } catch (err: unknown) {
      console.warn("[chess] could not load game stats:", err instanceof Error ? err.message : String(err));
      setSaveState("error");
      setError("Saved games could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void reloadStats();
    const db = window.MatrixOS?.db;
    if (!db?.onChange) return undefined;
    return db.onChange(GAMES_TABLE, () => void reloadStats());
  }, [reloadStats]);

  const clearSelection = useCallback(() => {
    setSelected(null);
    setLegalTargets(new Set());
  }, []);

  const refreshLegal = useCallback((square: string) => {
    const moves = gameRef.current.moves({ square: square as never, verbose: true }) as unknown as VerboseMove[];
    setLegalTargets(new Set(moves.map((m) => m.to)));
  }, []);

  // Persist the finished game exactly once when it ends.
  const maybePersistResult = useCallback(
    async (result: string | null) => {
      if (!result || savedResultRef.current) return;
      savedResultRef.current = true;
      setSaveState("saving");
      try {
        await persistGame(gameRef.current.pgn(), result);
        setSaveState("saved");
        await reloadStats();
      } catch (err: unknown) {
        console.warn("[chess] could not save game:", err instanceof Error ? err.message : String(err));
        setSaveState("error");
        setError("This game could not be saved.");
      }
    },
    [reloadStats],
  );

  const applyMove = useCallback(
    (from: string, to: string, promotion?: PieceType) => {
      let move: VerboseMove | null = null;
      try {
        move = gameRef.current.move({ from, to, promotion }) as unknown as VerboseMove | null;
      } catch (err: unknown) {
        // chess.js throws on illegal moves in some versions; treat as rejected.
        console.warn("[chess] rejected move:", err instanceof Error ? err.message : String(err));
        move = null;
      }
      if (!move) {
        clearSelection();
        return false;
      }
      setLastMove({ from, to });
      clearSelection();
      setSaveState("idle");
      bump();
      const next = deriveStatus(gameRef.current);
      void maybePersistResult(next.result);
      return true;
    },
    [bump, clearSelection, maybePersistResult],
  );

  // Attempt a move, opening the promotion picker if a pawn reaches the last rank.
  const attemptMove = useCallback(
    (from: string, to: string): boolean => {
      const piece = gameRef.current.get(from as never) as PieceLike | undefined;
      const promotionRank = to[1] === "8" || to[1] === "1";
      if (piece && piece.type === "p" && promotionRank) {
        const legal = (gameRef.current.moves({ square: from as never, verbose: true }) as unknown as VerboseMove[]).some(
          (m) => m.to === to,
        );
        if (legal) {
          setPendingPromotion({ from, to, color: piece.color });
          return true;
        }
      }
      return applyMove(from, to);
    },
    [applyMove],
  );

  const handleSquareClick = useCallback(
    (square: string) => {
      if (pendingPromotion || inputLockedRef.current) return;
      const piece = gameRef.current.get(square as never) as PieceLike | undefined;
      const turn = gameRef.current.turn() as PieceColor;

      if (selected) {
        if (square === selected) {
          clearSelection();
          return;
        }
        if (legalTargets.has(square)) {
          attemptMove(selected, square);
          return;
        }
        // Reselect another own piece, otherwise clear.
        if (piece && piece.color === turn) {
          setSelected(square);
          refreshLegal(square);
        } else {
          clearSelection();
        }
        return;
      }

      if (piece && piece.color === turn) {
        setSelected(square);
        refreshLegal(square);
      }
    },
    [attemptMove, clearSelection, legalTargets, pendingPromotion, refreshLegal, selected],
  );

  const handleDrop = useCallback(
    (from: string, to: string) => {
      if (pendingPromotion || from === to || inputLockedRef.current) return;
      attemptMove(from, to);
    },
    [attemptMove, pendingPromotion],
  );

  const completePromotion = useCallback(
    (type: PieceType) => {
      if (!pendingPromotion) return;
      applyMove(pendingPromotion.from, pendingPromotion.to, type);
      setPendingPromotion(null);
    },
    [applyMove, pendingPromotion],
  );

  // Cancel any scheduled/in-flight AI reply so resets and undos can't be raced
  // by a stale engine move.
  const cancelAiMove = useCallback(() => {
    if (aiTimerRef.current !== null) {
      clearTimeout(aiTimerRef.current);
      aiTimerRef.current = null;
    }
    aiRunIdRef.current += 1; // invalidate any deferred run already queued
    setThinking(false);
  }, []);

  const newGame = useCallback(() => {
    cancelAiMove();
    gameRef.current.reset();
    savedResultRef.current = false;
    setLastMove(null);
    setPendingPromotion(null);
    setSaveState("idle");
    clearSelection();
    bump();
  }, [bump, cancelAiMove, clearSelection]);

  // Switching mode or side starts a fresh game so the engine plays a coherent
  // game from the new configuration (and never has to "take over" mid-game).
  const startMode = useCallback(
    (next: GameMode) => {
      setMode(next);
      newGame();
    },
    [newGame],
  );

  const chooseColor = useCallback(
    (color: PieceColor) => {
      setHumanColor(color);
      // Flip the board so the human's pieces sit at the bottom.
      setFlipped(color === "b");
      newGame();
    },
    [newGame],
  );

  const undo = useCallback(() => {
    if (pendingPromotion) return;
    cancelAiMove();
    // In vs-computer mode an "undo" should take back the full human+AI pair so
    // the human is the side to move again (unless only one ply exists).
    const config = aiConfigRef.current;
    const takeBackPair =
      config.mode === "vs-computer" && gameRef.current.turn() === config.humanColor;
    const undone = gameRef.current.undo();
    if (!undone) return;
    if (takeBackPair) gameRef.current.undo();
    savedResultRef.current = false;
    setSaveState("idle");
    setLastMove(null);
    clearSelection();
    bump();
  }, [bump, cancelAiMove, clearSelection, pendingPromotion]);

  // Keyboard: Esc clears selection / dismisses promotion, Cmd/Ctrl+Z undoes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pendingPromotion) setPendingPromotion(null);
        else clearSelection();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (!pendingPromotion) undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection, pendingPromotion, undo]);

  const aiColor: PieceColor = humanColor === "w" ? "b" : "w";
  const aiToMove =
    mode === "vs-computer" && !pendingPromotion && game.turn() === aiColor && status.result === null;
  // Lock human input while the engine is to move or actively searching.
  const inputLocked = thinking || aiToMove;
  inputLockedRef.current = inputLocked;

  // Schedule the AI reply whenever it becomes the engine's turn. We defer the
  // (synchronous, CPU-bound) negamax search behind a setTimeout so the human's
  // move paints first and the UI never freezes mid-interaction; `thinking`
  // disables input meanwhile. A run-id guards against stale moves after the user
  // resets or undoes while a search is queued.
  useEffect(() => {
    if (!aiToMove) return undefined;
    const runId = aiRunIdRef.current;
    setThinking(true);
    aiTimerRef.current = setTimeout(() => {
      aiTimerRef.current = null;
      // Bail if a reset/undo invalidated this run while it was queued.
      if (aiRunIdRef.current !== runId) return;
      const cfg = aiConfigRef.current;
      try {
        const best = findBestMove(gameRef.current as unknown as ChessLike, DIFFICULTY_DEPTH[cfg.difficulty]);
        if (aiRunIdRef.current !== runId) return;
        if (best) {
          applyMove(best.from, best.to, best.promotion);
        } else {
          setMode("two-player");
          setSaveState("error");
          setError("The computer could not find a move. Continuing as local two-player.");
        }
      } catch (err: unknown) {
        if (aiRunIdRef.current !== runId) return;
        console.warn("[chess] AI search failed:", err instanceof Error ? err.message : String(err));
        setMode("two-player");
        setSaveState("error");
        setError("The computer could not find a move. Continuing as local two-player.");
      } finally {
        if (aiRunIdRef.current === runId) setThinking(false);
      }
    }, 220);
    return () => {
      if (aiTimerRef.current !== null) {
        clearTimeout(aiTimerRef.current);
        aiTimerRef.current = null;
      }
    };
  }, [aiToMove, applyMove]);

  const squares = useMemo(() => squaresOfBoard(flipped), [flipped]);
  const ranksForCoords = flipped ? ["1", "2", "3", "4", "5", "6", "7", "8"] : ["8", "7", "6", "5", "4", "3", "2", "1"];
  const filesForCoords = flipped ? ["h", "g", "f", "e", "d", "c", "b", "a"] : ["a", "b", "c", "d", "e", "f", "g", "h"];

  const turn = game.turn() as PieceColor;
  const gameOver = status.tone === "win" || status.tone === "draw";

  return (
    <main className="chess-app">
      <section className="board-stage" aria-label="Chess board">
        <header className="stage-head">
          <div className="product-mark" aria-hidden="true">
            <Swords size={18} />
          </div>
          <div className="stage-title">
            <span className="eyebrow">Matrix Chess</span>
            <h1>{mode === "vs-computer" ? "Play the computer" : "Local two-player"}</h1>
          </div>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => setFlipped((v) => !v)}
            title="Flip board"
            aria-label="Flip board"
          >
            <FlipVertical2 size={16} />
          </button>
        </header>

        <div className="setup-bar" data-testid="setup-bar">
          <div className="seg" role="group" aria-label="Game mode">
            <button
              type="button"
              className={`seg-btn${mode === "two-player" ? " seg-btn--on" : ""}`}
              aria-pressed={mode === "two-player"}
              data-testid="mode-two-player"
              onClick={() => startMode("two-player")}
            >
              <Users size={14} /> Two players
            </button>
            <button
              type="button"
              className={`seg-btn${mode === "vs-computer" ? " seg-btn--on" : ""}`}
              aria-pressed={mode === "vs-computer"}
              data-testid="mode-vs-computer"
              onClick={() => startMode("vs-computer")}
            >
              <Bot size={14} /> vs Computer
            </button>
          </div>

          {mode === "vs-computer" && (
            <div className="setup-options">
              <div className="seg" role="group" aria-label="Your color">
                <button
                  type="button"
                  className={`seg-btn${humanColor === "w" ? " seg-btn--on" : ""}`}
                  aria-pressed={humanColor === "w"}
                  data-testid="color-white"
                  onClick={() => chooseColor("w")}
                >
                  White
                </button>
                <button
                  type="button"
                  className={`seg-btn${humanColor === "b" ? " seg-btn--on" : ""}`}
                  aria-pressed={humanColor === "b"}
                  data-testid="color-black"
                  onClick={() => chooseColor("b")}
                >
                  Black
                </button>
              </div>
              <label className="difficulty">
                <Brain size={14} aria-hidden="true" />
                <select
                  aria-label="Difficulty"
                  data-testid="difficulty"
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value as Difficulty)}
                >
                  {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => (
                    <option key={d} value={d}>
                      {DIFFICULTY_LABEL[d]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>

        <div
          className={`status-pill status-pill--${thinking ? "thinking" : status.tone}`}
          role="status"
          data-testid="status"
          data-tone={thinking ? "thinking" : status.tone}
          aria-live="polite"
        >
          {thinking ? (
            <>
              <Bot size={15} className="thinking-spin" />
              <span data-testid="thinking">Computer is thinking…</span>
            </>
          ) : (
            <>
              {gameOver ? <Trophy size={15} /> : <Sparkles size={15} />}
              <span>{status.text}</span>
            </>
          )}
        </div>

        <div className="board-frame">
          <div className="rank-coords" aria-hidden="true">
            {ranksForCoords.map((r) => (
              <span key={r}>{r}</span>
            ))}
          </div>
          <div className="board" data-testid="board" role="grid" aria-label="Chess board">
            {squares.map((sq) => {
              const piece = game.get(sq as never) as PieceLike | undefined;
              const isLegal = legalTargets.has(sq);
              const isSelected = selected === sq;
              const isLast = lastMove?.from === sq || lastMove?.to === sq;
              return (
                <button
                  key={sq}
                  type="button"
                  role="gridcell"
                  data-testid={`square-${sq}`}
                  data-square={sq}
                  data-legal={isLegal ? "true" : "false"}
                  data-selected={isSelected ? "true" : "false"}
                  aria-label={`${sq}${piece ? ` ${colorName(piece.color)} ${piece.type}` : " empty"}`}
                  className={[
                    "square",
                    `square--${squareColor(sq)}`,
                    isSelected ? "square--selected" : "",
                    isLast ? "square--last" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => handleSquareClick(sq)}
                  draggable={Boolean(piece && piece.color === turn && !gameOver && !inputLocked)}
                  onDragStart={(e) => {
                    if (!piece || piece.color !== turn || inputLocked) {
                      e.preventDefault();
                      return;
                    }
                    e.dataTransfer.setData("text/plain", sq);
                    setSelected(sq);
                    refreshLegal(sq);
                  }}
                  onDragOver={(e) => {
                    if (legalTargets.has(sq)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = e.dataTransfer.getData("text/plain");
                    if (from) handleDrop(from, sq);
                  }}
                >
                  {isLegal && !piece && <span className="legal-dot" aria-hidden="true" />}
                  {isLegal && piece && <span className="legal-ring" aria-hidden="true" />}
                  {piece && (
                    <span className={`piece piece--${piece.color}`} aria-hidden="true">
                      {PIECE_GLYPHS[piece.color][piece.type]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="file-coords" aria-hidden="true">
            {filesForCoords.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
        </div>

        <div className="board-actions">
          <button type="button" className="primary-action" onClick={newGame}>
            <Sparkles size={16} /> New game
          </button>
          <button
            type="button"
            className="secondary-action"
            onClick={undo}
            disabled={sanHistory.length === 0 || thinking || Boolean(pendingPromotion)}
          >
            <RotateCcw size={16} /> Undo
          </button>
        </div>
      </section>

      <aside className="side-panel" aria-label="Game information">
        <div className="capture-tray">
          <CaptureRow label="Black captured" pieces={captured.byBlack} edge={delta.advantage === "black" ? delta.amount : 0} />
          <CaptureRow label="White captured" pieces={captured.byWhite} edge={delta.advantage === "white" ? delta.amount : 0} />
        </div>

        <div className="history-card">
          <div className="section-heading">
            <p className="eyebrow">Move history</p>
            <h2>SAN notation</h2>
          </div>
          <div className="move-history" data-testid="move-history">
            {pairs.length === 0 ? (
              <div className="empty-history">
                <Swords size={22} />
                <strong>No moves yet</strong>
                <span>White to move. Click a piece to see its legal squares, then click a target.</span>
              </div>
            ) : (
              <ol className="move-list">
                {pairs.map((p) => (
                  <li key={p.number} className="move-row">
                    <span className="move-no">{p.number}.</span>
                    <span className="move-san">{p.white}</span>
                    <span className="move-san">{p.black ?? ""}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div className={`save-strip${saveState === "error" ? " save-strip--error" : ""}`}>
          <Save size={14} />
          <span>
            {saveState === "saving" && "Saving game to Matrix Postgres…"}
            {saveState === "saved" && "Game saved"}
            {saveState === "error" && (error ?? "Game could not be saved.")}
            {saveState === "idle" && `${gamesPlayed} game${gamesPlayed === 1 ? "" : "s"} on record`}
          </span>
        </div>

        <p className="note">
          {mode === "vs-computer"
            ? `Playing ${colorName(humanColor)} vs the computer (${DIFFICULTY_LABEL[difficulty]}).`
            : "Two-player mode. Switch to vs Computer to play the engine."}
        </p>
      </aside>

      {pendingPromotion && (
        <div className="promo-overlay" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
          <div className="promo-card">
            <p>Promote to</p>
            <div className="promo-options">
              {PROMOTION_PIECES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="promo-btn"
                  data-testid={`promote-${type}`}
                  onClick={() => completePromotion(type)}
                >
                  <span className={`piece piece--${pendingPromotion.color}`}>
                    {PIECE_GLYPHS[pendingPromotion.color][type]}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function CaptureRow({ label, pieces, edge }: { label: string; pieces: PieceLike[]; edge: number }) {
  return (
    <div className="capture-row">
      <span className="capture-label">{label}</span>
      <div className="capture-pieces">
        {pieces.length === 0 ? (
          <span className="capture-empty">—</span>
        ) : (
          pieces.map((p, i) => (
            <span key={`${p.type}-${i}`} className={`capture-glyph capture-glyph--${p.color}`}>
              {PIECE_GLYPHS[p.color][p.type]}
            </span>
          ))
        )}
        {edge > 0 && <span className="capture-edge">+{edge}</span>}
      </div>
    </div>
  );
}
