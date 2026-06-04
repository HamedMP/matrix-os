// Pure, UI-free chess engine: depth-limited negamax with alpha-beta pruning.
//
// Design notes:
// - Dependency-injected. We do NOT import chess.js here; instead the engine
//   operates on any object matching the small `ChessLike` surface (the real
//   `Chess` instance satisfies it). This keeps the module unit-testable from the
//   root vitest runner, which cannot resolve the app-local "chess.js" specifier,
//   and keeps the engine deterministic given a position + depth.
// - chess.js handles all legality (move generation, check/mate/stalemate). The
//   engine only searches and scores.
// - Evaluation = material (standard piece values) + piece-square tables
//   (positional) + a small mobility term. Scores are from the perspective of the
//   side to move (negamax convention).

import type { PieceColor, PieceType } from "./chess-model";
import { PIECE_VALUES } from "./chess-model";

/** A single legal move as produced by chess.js `moves({ verbose: true })`. */
export interface VerboseMove {
  from: string;
  to: string;
  san?: string;
  color: PieceColor;
  piece: PieceType;
  captured?: PieceType;
  promotion?: PieceType;
}

export interface BoardSquare {
  square: string;
  type: PieceType;
  color: PieceColor;
}

/**
 * The minimal subset of the chess.js `Chess` API the engine relies on. Both the
 * real library instance and any faithful test double satisfy this.
 */
export interface ChessLike {
  moves(opts: { verbose: true }): VerboseMove[];
  move(m: { from: string; to: string; promotion?: PieceType }): unknown;
  undo(): unknown;
  turn(): PieceColor;
  board(): (BoardSquare | null)[][];
  isCheckmate(): boolean;
  isStalemate(): boolean;
  isDraw(): boolean;
}

export type AiMove = Pick<VerboseMove, "from" | "to"> & { promotion?: PieceType };

// Centipawn material values (queen = 900, etc.). Derived from the shared
// PIECE_VALUES so material scoring stays consistent with the UI tray.
const MATERIAL: Record<PieceType, number> = {
  p: PIECE_VALUES.p * 100,
  n: PIECE_VALUES.n * 100,
  b: PIECE_VALUES.b * 100,
  r: PIECE_VALUES.r * 100,
  q: PIECE_VALUES.q * 100,
  k: 0,
};

// Large but finite mate score. Adjusted by ply so the engine prefers faster
// mates and delays getting mated.
const MATE = 100_000;

// Piece-square tables (white's perspective, a1 = index 56 .. h8 = index 7 when
// read rank 8 -> rank 1). We index by [rankIndexFromTop][fileIndex]; black uses
// the vertically mirrored value. Values are small positional nudges in
// centipawns — material always dominates.
// prettier-ignore
const PST: Record<PieceType, number[][]> = {
  p: [
    [  0,  0,  0,  0,  0,  0,  0,  0],
    [ 50, 50, 50, 50, 50, 50, 50, 50],
    [ 10, 10, 20, 30, 30, 20, 10, 10],
    [  5,  5, 10, 25, 25, 10,  5,  5],
    [  0,  0,  0, 20, 20,  0,  0,  0],
    [  5, -5,-10,  0,  0,-10, -5,  5],
    [  5, 10, 10,-20,-20, 10, 10,  5],
    [  0,  0,  0,  0,  0,  0,  0,  0],
  ],
  n: [
    [-50,-40,-30,-30,-30,-30,-40,-50],
    [-40,-20,  0,  0,  0,  0,-20,-40],
    [-30,  0, 10, 15, 15, 10,  0,-30],
    [-30,  5, 15, 20, 20, 15,  5,-30],
    [-30,  0, 15, 20, 20, 15,  0,-30],
    [-30,  5, 10, 15, 15, 10,  5,-30],
    [-40,-20,  0,  5,  5,  0,-20,-40],
    [-50,-40,-30,-30,-30,-30,-40,-50],
  ],
  b: [
    [-20,-10,-10,-10,-10,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5, 10, 10,  5,  0,-10],
    [-10,  5,  5, 10, 10,  5,  5,-10],
    [-10,  0, 10, 10, 10, 10,  0,-10],
    [-10, 10, 10, 10, 10, 10, 10,-10],
    [-10,  5,  0,  0,  0,  0,  5,-10],
    [-20,-10,-10,-10,-10,-10,-10,-20],
  ],
  r: [
    [  0,  0,  0,  0,  0,  0,  0,  0],
    [  5, 10, 10, 10, 10, 10, 10,  5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [ -5,  0,  0,  0,  0,  0,  0, -5],
    [  0,  0,  0,  5,  5,  0,  0,  0],
  ],
  q: [
    [-20,-10,-10, -5, -5,-10,-10,-20],
    [-10,  0,  0,  0,  0,  0,  0,-10],
    [-10,  0,  5,  5,  5,  5,  0,-10],
    [ -5,  0,  5,  5,  5,  5,  0, -5],
    [  0,  0,  5,  5,  5,  5,  0, -5],
    [-10,  5,  5,  5,  5,  5,  0,-10],
    [-10,  0,  5,  0,  0,  0,  0,-10],
    [-20,-10,-10, -5, -5,-10,-10,-20],
  ],
  k: [
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-30,-40,-40,-50,-50,-40,-40,-30],
    [-20,-30,-30,-40,-40,-30,-30,-20],
    [-10,-20,-20,-20,-20,-20,-20,-10],
    [ 20, 20,  0,  0,  0,  0, 20, 20],
    [ 20, 30, 10,  0,  0, 10, 30, 20],
  ],
};

/**
 * Static evaluation of a position, in centipawns, from the perspective of the
 * side to move (positive = good for the side to move). Material dominates;
 * piece-square tables and a small mobility term break ties positionally.
 */
export function evaluatePosition(game: ChessLike): number {
  if (game.isCheckmate()) {
    // Side to move is mated -> worst possible.
    return -MATE;
  }
  if (game.isStalemate() || game.isDraw()) {
    return 0;
  }

  const board = game.board();
  let whiteScore = 0;
  // board() is rank 8 (index 0) down to rank 1 (index 7), file a..h (0..7).
  for (let r = 0; r < 8; r += 1) {
    const row = board[r];
    for (let f = 0; f < 8; f += 1) {
      const sq = row[f];
      if (!sq) continue;
      const material = MATERIAL[sq.type];
      // White reads the table directly; black reads the vertically mirrored row.
      const positional = sq.color === "w" ? PST[sq.type][r][f] : PST[sq.type][7 - r][f];
      const contribution = material + positional;
      whiteScore += sq.color === "w" ? contribution : -contribution;
    }
  }

  // Small mobility term: count of legal moves for the side to move. Bounded so it
  // never outweighs a pawn.
  const mobility = game.moves({ verbose: true }).length;
  whiteScore += (game.turn() === "w" ? mobility : -mobility) * 2;

  // Convert to side-to-move perspective for negamax.
  return game.turn() === "w" ? whiteScore : -whiteScore;
}

// Order moves so captures (most-valuable-victim) are searched first; better
// move ordering makes alpha-beta prune far more aggressively.
function orderMoves(moves: VerboseMove[]): VerboseMove[] {
  // toSorted() (ES2023) would be cleaner, but the app's tsconfig lib target
  // predates it; a copy-then-sort keeps the input array immutable.
  return [...moves].sort((a, b) => captureScore(b) - captureScore(a));
}

function captureScore(m: VerboseMove): number {
  if (!m.captured) return 0;
  // MVV-LVA-ish: prize the victim, lightly discount the attacker.
  return MATERIAL[m.captured] - MATERIAL[m.piece] / 10 + 1;
}

/**
 * Negamax with alpha-beta pruning. Returns the score (centipawns) of `game` for
 * the side to move, searching `depth` plies deep. `ply` tracks distance from the
 * root so mate scores prefer the quickest mate.
 */
function negamax(game: ChessLike, depth: number, alpha: number, beta: number, ply: number): number {
  if (game.isCheckmate()) {
    // Being mated now is bad; the deeper (later) the mate, the less bad.
    return -MATE + ply;
  }
  if (game.isStalemate() || game.isDraw()) {
    return 0;
  }
  if (depth === 0) {
    return evaluatePosition(game);
  }

  const moves = orderMoves(game.moves({ verbose: true }));
  if (moves.length === 0) {
    // No legal moves but not flagged mate/stalemate above: treat as draw.
    return 0;
  }

  let best = -Infinity;
  let a = alpha;
  for (const m of moves) {
    game.move({ from: m.from, to: m.to, promotion: m.promotion });
    const score = -negamax(game, depth - 1, -beta, -a, ply + 1);
    game.undo();
    if (score > best) best = score;
    if (best > a) a = best;
    if (a >= beta) break; // beta cutoff
  }
  return best;
}

/**
 * Pick the best move for the side to move at the given search depth. Returns
 * `null` when there are no legal moves (checkmate/stalemate). Deterministic for a
 * fixed position + depth: ties keep the first move in the (stable) ordering.
 */
export function findBestMove(game: ChessLike, depth: number): AiMove | null {
  const moves = orderMoves(game.moves({ verbose: true }));
  if (moves.length === 0) return null;

  const searchDepth = Math.max(1, Math.floor(depth));
  let bestMove: VerboseMove = moves[0];
  let bestScore = -Infinity;
  let alpha = -Infinity;
  const beta = Infinity;

  for (const m of moves) {
    game.move({ from: m.from, to: m.to, promotion: m.promotion });
    const score = -negamax(game, searchDepth - 1, -beta, -alpha, 1);
    game.undo();
    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
    }
    if (bestScore > alpha) alpha = bestScore;
  }

  return { from: bestMove.from, to: bestMove.to, promotion: bestMove.promotion };
}

/** Map a difficulty label to a search depth. */
export type Difficulty = "easy" | "medium" | "hard";

export const DIFFICULTY_DEPTH: Record<Difficulty, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
};
