import { describe, expect, it } from "vitest";
import {
  PIECE_GLYPHS,
  groupMovesIntoPairs,
  materialDelta,
  squareColor,
  squaresOfBoard,
} from "../../home/apps/games/chess/src/chess-model";

describe("chess-model pure helpers", () => {
  it("enumerates all 64 squares from a8 to h1", () => {
    const squares = squaresOfBoard(false);
    expect(squares).toHaveLength(64);
    expect(squares[0]).toBe("a8");
    expect(squares[7]).toBe("h8");
    expect(squares[56]).toBe("a1");
    expect(squares[63]).toBe("h1");
  });

  it("flips the board orientation when requested", () => {
    const flipped = squaresOfBoard(true);
    expect(flipped).toHaveLength(64);
    expect(flipped[0]).toBe("h1");
    expect(flipped[63]).toBe("a8");
  });

  it("computes square color deterministically (a1 dark, h1 light)", () => {
    expect(squareColor("a1")).toBe("dark");
    expect(squareColor("h1")).toBe("light");
    expect(squareColor("a8")).toBe("light");
    expect(squareColor("h8")).toBe("dark");
  });

  it("maps every piece to a unicode glyph", () => {
    expect(PIECE_GLYPHS.w.k).toBe("♔");
    expect(PIECE_GLYPHS.b.q).toBe("♛");
    // every color/type combination is present
    for (const color of ["w", "b"] as const) {
      for (const type of ["p", "n", "b", "r", "q", "k"] as const) {
        expect(typeof PIECE_GLYPHS[color][type]).toBe("string");
        expect(PIECE_GLYPHS[color][type].length).toBeGreaterThan(0);
      }
    }
  });

  it("groups a SAN move list into numbered white/black pairs", () => {
    const pairs = groupMovesIntoPairs(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    expect(pairs).toEqual([
      { number: 1, white: "e4", black: "e5" },
      { number: 2, white: "Nf3", black: "Nc6" },
      { number: 3, white: "Bb5", black: null },
    ]);
  });

  it("returns an empty pair list for no moves", () => {
    expect(groupMovesIntoPairs([])).toEqual([]);
  });

  it("computes material delta from captured pieces", () => {
    // white captured a black rook (5) and pawn (1) = +6; black captured a white knight (3)
    const delta = materialDelta(
      [
        { color: "b", type: "r" },
        { color: "b", type: "p" },
      ],
      [{ color: "w", type: "n" }],
    );
    expect(delta.white).toBe(6);
    expect(delta.black).toBe(3);
    expect(delta.advantage).toBe("white");
    expect(delta.amount).toBe(3);
  });

  it("reports an even material balance", () => {
    const delta = materialDelta(
      [{ color: "b", type: "p" }],
      [{ color: "w", type: "p" }],
    );
    expect(delta.advantage).toBe("even");
    expect(delta.amount).toBe(0);
  });
});
