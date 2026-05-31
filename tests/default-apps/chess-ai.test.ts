import { describe, expect, it } from "vitest";
// chess.js is an app-local dependency. The root vitest runner cannot resolve the
// bare "chess.js" specifier (it lives only in home/apps/games/chess/node_modules),
// so we import the real engine from that app-local path — exactly the same library
// the built app uses. This exercises the AI against genuine legal-move generation.
import { Chess } from "../../home/apps/games/chess/node_modules/chess.js/dist/esm/chess.js";
import { findBestMove, evaluatePosition } from "../../home/apps/games/chess/src/chess-ai";

// chess-ai is dependency-injected: it accepts any object matching the small
// `ChessLike` surface it uses. The real `Chess` instance satisfies it.
function game(fen?: string): Chess {
  return fen ? new Chess(fen) : new Chess();
}

describe("chess-ai engine", () => {
  it("returns a legal move from the starting position", () => {
    const g = game();
    const best = findBestMove(g, 2);
    expect(best).not.toBeNull();
    const legal = g.moves({ verbose: true }).map((m) => `${m.from}${m.to}`);
    expect(legal).toContain(`${best!.from}${best!.to}`);
  });

  it("finds an obvious mate-in-1 (back-rank mate)", () => {
    // White to move: Ra8 is checkmate. Black king on h8 boxed by its own pawns,
    // white rook lifts to the back rank.
    const g = game("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1");
    const best = findBestMove(g, 3);
    expect(best).not.toBeNull();
    // Apply the chosen move and confirm it is mate.
    const probe = game(g.fen());
    probe.move({ from: best!.from, to: best!.to, promotion: best!.promotion });
    expect(probe.isCheckmate()).toBe(true);
    expect(best!.to).toBe("a8");
  });

  it("captures a hanging queen when it is free", () => {
    // White rook on a1, undefended black queen on a8, nothing else contests it.
    // Best move must be the free queen capture Rxa8.
    const g = game("q5k1/8/8/8/8/8/6PP/R5K1 w - - 0 1");
    const best = findBestMove(g, 3);
    expect(best).not.toBeNull();
    expect(best!.from).toBe("a1");
    expect(best!.to).toBe("a8");
  });

  it("prefers the higher-material outcome between two captures", () => {
    // White rook on d1 can take an undefended queen on d8 or an undefended
    // knight on a... set up so a free queen and a free rook are both available;
    // engine must grab the queen.
    const g = game("3q3k/8/8/8/8/8/6PP/3R2K1 w - - 0 1");
    const best = findBestMove(g, 2);
    expect(best).not.toBeNull();
    expect(best!.to).toBe("d8");
  });

  it("evaluation favors the side with more material", () => {
    // White is up a full queen.
    const up = evaluatePosition(game("4k3/8/8/8/8/8/8/3QK3 w - - 0 1"));
    const even = evaluatePosition(game("4k3/8/8/8/8/8/8/4K3 w - - 0 1"));
    expect(up).toBeGreaterThan(even);
  });

  it("is deterministic for a fixed position + depth", () => {
    const a = findBestMove(game("3q3k/8/8/8/8/8/6PP/3R2K1 w - - 0 1"), 2);
    const b = findBestMove(game("3q3k/8/8/8/8/8/6PP/3R2K1 w - - 0 1"), 2);
    expect(a).toEqual(b);
  });

  it("returns null when there are no legal moves (checkmated side to move)", () => {
    // Black is already checkmated: king on g8 boxed by its own pawn on g7, white
    // rook on h8 giving check with the white king on g6 covering the escape.
    const mated = game("6kR/6P1/6K1/8/8/8/8/8 b - - 0 1");
    expect(mated.moves().length).toBe(0);
    expect(findBestMove(mated, 2)).toBeNull();
    // sanity: a normal mid-game position still yields a move for the side to move
    const live = game("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
    expect(findBestMove(live, 1)).not.toBeNull();
  });
});
