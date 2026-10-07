import { Chess, type Move } from "chess.js";

export interface SearchOptions { maxDepth?: number; maxNodes?: number; timeoutMs?: number; now?: () => number }
export interface SearchResult { fen: string; whiteScore: number | null; bestMove: string | null; variation: string[]; depth: number; nodes: number; bounded: boolean }
export interface GamePosition { ply: number; san: string; color: "w" | "b"; before: string; after: string }
export function completedGame(pgn: string, status: unknown) {
  if (status !== "Completed" || typeof pgn !== "string" || !pgn.trim() || pgn.length > 12000) throw new Error("Choose a completed game with a PGN of at most 12,000 characters.");
  const stripped = pgn.replace(/\{[^}]*\}/g, "").replace(/;[^\n]*/g, "").trim();
  const result = stripped.match(/(?:^|\s)(1-0|0-1|1\/2-1\/2|\*)\s*$/)?.[1];
  if (!result || result === "*") throw new Error("Only completed games can be reviewed. This PGN has no final result.");
  const declared = [...pgn.matchAll(/\[Result\s+"([^"]+)"\]/g)];
  if (declared.some(match => match[1] !== result)) throw new Error("The PGN result header and final result do not match.");
  const chess = new Chess();
  try { chess.loadPgn(pgn, { strict: true }); } catch (error) { console.warn("Completed PGN failed legal validation", error instanceof Error ? error.name : "UnknownError"); throw new Error("This PGN contains an invalid or illegal move. Review the pasted game."); }
  const moves = chess.history({ verbose: true });
  if (!moves.length || moves.length > 400) throw new Error("Choose a completed game containing between 1 and 400 moves.");
  if ((chess.isCheckmate() && result !== (chess.turn() === "w" ? "0-1" : "1-0")) || (chess.isStalemate() && result !== "1/2-1/2")) throw new Error("The final position and recorded result do not match.");
  return { result, moves: moves.map(move => move.san), finalFen: chess.fen(), positions: moves.map((move, index): GamePosition => ({ ply: index + 1, san: move.san, color: move.color, before: move.before, after: move.after })) };
}

const value = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
function staticEvaluation(chess: Chess): number {
  let total = 0;
  for (const rank of chess.board()) for (const piece of rank) if (piece) {
    const file = piece.square.charCodeAt(0) - 97, row = Number(piece.square[1]) - 1;
    const center = (3.5 - Math.abs(3.5 - file)) + (3.5 - Math.abs(3.5 - row));
    const position = piece.type === "n" || piece.type === "b" ? center * 4 : piece.type === "p" ? (piece.color === "w" ? row : 7 - row) * 2 : 0;
    total += (value[piece.type] + position) * (piece.color === "w" ? 1 : -1);
  }
  return Math.round(total);
}
class SearchBudgetReached extends Error {}
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid local search budget.");
  return value;
}
export function searchPosition(fen: string, options: SearchOptions = {}): SearchResult {
  if (typeof fen !== "string" || fen.length > 200) throw new Error("Invalid board position.");
  const chess = new Chess(fen), now = options.now ?? (() => performance.now());
  const maxDepth = boundedInteger(options.maxDepth, 3, 1, 3), maxNodes = boundedInteger(options.maxNodes, 10000, 1, 20000), timeout = boundedInteger(options.timeoutMs, 600, 1, 3000);
  const deadline = now() + timeout;
  let nodes = 0;
  const result: SearchResult = { fen, whiteScore: null, bestMove: null, variation: [], depth: 0, nodes: 0, bounded: false };
  function terminal(ply: number): number | null {
    if (chess.isCheckmate()) return (chess.turn() === "w" ? -1 : 1) * (100000 - ply);
    if (chess.isDraw()) return 0;
    return null;
  }
  const end = terminal(0);
  if (end !== null) return { ...result, whiteScore: end };
  function search(depth: number, alpha: number, beta: number, ply: number): { score: number; pv: string[] } {
    if (nodes >= maxNodes || now() >= deadline) throw new SearchBudgetReached();
    nodes++;
    const end = terminal(ply);
    if (end !== null) return { score: end, pv: [] };
    if (depth === 0) return { score: staticEvaluation(chess), pv: [] };
    const white = chess.turn() === "w";
    let score = white ? -Infinity : Infinity, pv: string[] = [];
    const moves = chess.moves({ verbose: true }).sort((a, b) => moveOrder(b) - moveOrder(a) || a.san.localeCompare(b.san));
    for (const move of moves) {
      chess.move(move);
      let child: ReturnType<typeof search>;
      try { child = search(depth - 1, alpha, beta, ply + 1); } finally { chess.undo(); }
      if (white ? child.score > score : child.score < score) { score = child.score; pv = [move.san, ...child.pv]; }
      if (white) alpha = Math.max(alpha, score); else beta = Math.min(beta, score);
      if (beta <= alpha) break;
    }
    return { score, pv };
  }
  for (let depth = 1; depth <= maxDepth; depth++) {
    try {
      const searched = search(depth, -Infinity, Infinity, 0);
      result.whiteScore = searched.score; result.bestMove = searched.pv[0] ?? null; result.variation = searched.pv; result.depth = depth;
    } catch (error) {
      if (!(error instanceof SearchBudgetReached)) throw error;
      result.bounded = true; break;
    }
  }
  result.nodes = nodes;
  return result;
}
function moveOrder(move: Move) { return (move.captured ? value[move.captured] * 10 - value[move.piece] : 0) + (move.promotion ? value[move.promotion] : 0) + (move.san.includes("#") ? 100000 : move.san.includes("+") ? 50 : 0); }
export function isLegalVariation(fen: string, variation: string[]): boolean {
  if (!Array.isArray(variation) || variation.length > 3) return false;
  try { const chess = new Chess(fen); for (const move of variation) chess.move(move, { strict: true }); return true; }
  catch (error) { if (!(error instanceof Error)) throw error; return false; }
}

export interface GameAnalysis { engine: string; result: string; positions: Array<{ position: GamePosition; before: SearchResult; after: SearchResult; loss: number | null }> }
export function analyzeCompletedGame(pgn: string, status: unknown, options: SearchOptions & { positions?: number } = {}): GameAnalysis {
  const game = completedGame(pgn, status), now = options.now ?? (() => performance.now()), deadline = now() + 5000;
  const count = boundedInteger(options.positions, 6, 1, 6);
  const positions: GameAnalysis["positions"] = [];
  for (const position of game.positions.slice(-count)) {
    const remaining = Math.floor(deadline - now());
    if (remaining < 10) break;
    const timeoutMs = Math.min(options.timeoutMs ?? 350, 800, Math.floor(remaining / 2));
    const before = searchPosition(position.before, { ...options, timeoutMs });
    const after = searchPosition(position.after, { ...options, timeoutMs });
    const loss = before.whiteScore === null || after.whiteScore === null || Math.abs(before.whiteScore) > 90000 || Math.abs(after.whiteScore) > 90000 ? null : Math.max(0, (before.whiteScore - after.whiteScore) * (position.color === "w" ? 1 : -1));
    positions.push({ position, before, after, loss });
  }
  return { engine: "Local legal alpha-beta search · material and position", result: game.result, positions };
}

export function boardSquares(fen: string) { return new Chess(fen).board().flat().map((piece, index) => ({ square: `${String.fromCharCode(97 + index % 8)}${8 - Math.floor(index / 8)}`, piece: piece ? `${piece.color}${piece.type}` : null })); }
