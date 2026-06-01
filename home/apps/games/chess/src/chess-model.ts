// Pure, UI-free chess helpers. Legal move generation/validation is delegated to
// the chess.js library; this module only handles presentation-layer concerns:
// board square enumeration, square coloring, piece glyphs, SAN grouping, and
// material counting. Everything here is deterministic and unit-tested.

export type PieceColor = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

export interface PieceLike {
  color: PieceColor;
  type: PieceType;
}

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;

/**
 * All 64 squares in render order (top-left to bottom-right). With white at the
 * bottom (flipped=false) this runs a8..h8, a7..h7, … a1..h1. Flipping reverses
 * the orientation so black sits at the bottom.
 */
export function squaresOfBoard(flipped: boolean): string[] {
  const files = flipped ? [...FILES].reverse() : [...FILES];
  const ranks = flipped ? [...RANKS].reverse() : [...RANKS];
  const out: string[] = [];
  for (const rank of ranks) {
    for (const file of files) {
      out.push(`${file}${rank}`);
    }
  }
  return out;
}

/** Standard chessboard coloring: a1 is dark. */
export function squareColor(square: string): "light" | "dark" {
  const fileIndex = FILES.indexOf(square[0] as (typeof FILES)[number]);
  const rank = Number(square[1]);
  // a1 (fileIndex 0, rank 1) is a dark square: odd sum => dark, even => light.
  return (fileIndex + rank) % 2 === 0 ? "light" : "dark";
}

export const PIECE_GLYPHS: Record<PieceColor, Record<PieceType, string>> = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

export const PIECE_VALUES: Record<PieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export interface MovePair {
  number: number;
  white: string;
  black: string | null;
}

/** Group a flat SAN list into numbered move pairs for a two-column history. */
export function groupMovesIntoPairs(san: string[]): MovePair[] {
  const pairs: MovePair[] = [];
  for (let i = 0; i < san.length; i += 2) {
    pairs.push({
      number: i / 2 + 1,
      white: san[i],
      black: i + 1 < san.length ? san[i + 1] : null,
    });
  }
  return pairs;
}

export interface MaterialDelta {
  white: number;
  black: number;
  advantage: "white" | "black" | "even";
  amount: number;
}

/**
 * Material captured by each side. `capturedByWhite` are the black pieces white
 * has taken; `capturedByBlack` are the white pieces black has taken.
 */
export function materialDelta(
  capturedByWhite: PieceLike[],
  capturedByBlack: PieceLike[],
): MaterialDelta {
  const white = capturedByWhite.reduce((sum, p) => sum + PIECE_VALUES[p.type], 0);
  const black = capturedByBlack.reduce((sum, p) => sum + PIECE_VALUES[p.type], 0);
  const diff = white - black;
  return {
    white,
    black,
    advantage: diff > 0 ? "white" : diff < 0 ? "black" : "even",
    amount: Math.abs(diff),
  };
}

export interface CapturedTray {
  byWhite: PieceLike[];
  byBlack: PieceLike[];
}

/**
 * Derive captured pieces from verbose chess.js move history. Each verbose move
 * may carry a `captured` piece type; the capturer's color is `color`.
 */
export function capturedFromHistory(
  moves: { color: PieceColor; captured?: PieceType }[],
): CapturedTray {
  const byWhite: PieceLike[] = [];
  const byBlack: PieceLike[] = [];
  for (const m of moves) {
    if (!m.captured) continue;
    if (m.color === "w") {
      byWhite.push({ color: "b", type: m.captured });
    } else {
      byBlack.push({ color: "w", type: m.captured });
    }
  }
  return { byWhite, byBlack };
}
