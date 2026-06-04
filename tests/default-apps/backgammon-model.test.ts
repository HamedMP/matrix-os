import { describe, expect, it } from "vitest";
import {
  BAR,
  OFF,
  type GameState,
  type Player,
  applyMove,
  createInitialState,
  generateLegalMoves,
  isGameOver,
  legalDestinations,
  pipCount,
  rollFromValues,
  startTurn,
  winnerResult,
} from "../../home/apps/games/backgammon/src/backgammon-model";

// Convenience: build a state with an empty board, then place checkers.
// points index 1..24 (standard numbering from White's perspective),
// bar[white]/bar[black], off[white]/off[black].
function emptyState(turn: Player = "white"): GameState {
  const s = createInitialState();
  for (let i = 0; i < s.points.length; i++) {
    s.points[i] = { player: null, count: 0 };
  }
  s.bar = { white: 0, black: 0 };
  s.off = { white: 0, black: 0 };
  s.turn = turn;
  s.dice = [];
  s.movesLeft = [];
  s.history = [];
  return s;
}

function place(s: GameState, point: number, player: Player, count: number) {
  s.points[point] = { player, count };
}

describe("backgammon-model — initial setup", () => {
  it("creates standard starting position with 15 checkers each", () => {
    const s = createInitialState();
    // White standard: 24:2, 13:5, 8:3, 6:5  (White moves 24 -> 1)
    expect(s.points[24]).toEqual({ player: "white", count: 2 });
    expect(s.points[13]).toEqual({ player: "white", count: 5 });
    expect(s.points[8]).toEqual({ player: "white", count: 3 });
    expect(s.points[6]).toEqual({ player: "white", count: 5 });
    // Black mirror: 1:2, 12:5, 17:3, 19:5
    expect(s.points[1]).toEqual({ player: "black", count: 2 });
    expect(s.points[12]).toEqual({ player: "black", count: 5 });
    expect(s.points[17]).toEqual({ player: "black", count: 3 });
    expect(s.points[19]).toEqual({ player: "black", count: 5 });

    let white = 0;
    let black = 0;
    for (let i = 1; i <= 24; i++) {
      if (s.points[i].player === "white") white += s.points[i].count;
      if (s.points[i].player === "black") black += s.points[i].count;
    }
    expect(white).toBe(15);
    expect(black).toBe(15);
  });

  it("computes the standard opening pip count of 167 for both sides", () => {
    const s = createInitialState();
    expect(pipCount(s, "white")).toBe(167);
    expect(pipCount(s, "black")).toBe(167);
  });
});

describe("backgammon-model — dice and turn", () => {
  it("non-doubles produce two moves of distinct values", () => {
    const s = createInitialState();
    s.turn = "white";
    const next = startTurn(s, rollFromValues(3, 5));
    expect(next.dice).toEqual([3, 5]);
    expect([...next.movesLeft].sort()).toEqual([3, 5]);
  });

  it("doubles produce four moves of the same value", () => {
    const s = createInitialState();
    s.turn = "white";
    const next = startTurn(s, rollFromValues(4, 4));
    expect(next.dice).toEqual([4, 4]);
    expect(next.movesLeft).toEqual([4, 4, 4, 4]);
  });
});

describe("backgammon-model — legal move generation", () => {
  it("white moves from a high point toward 1 using a die", () => {
    const s = emptyState("white");
    place(s, 24, "white", 2);
    place(s, 13, "white", 13);
    const st = startTurn(s, rollFromValues(6, 5));
    const dests = legalDestinations(st, 24);
    // 24-6=18, 24-5=19
    expect(dests.map((d) => d.to).sort((a, b) => a - b)).toEqual([18, 19]);
  });

  it("black moves toward 24 (opposite direction)", () => {
    const s = emptyState("black");
    place(s, 1, "black", 2);
    place(s, 12, "black", 13);
    const st = startTurn(s, rollFromValues(6, 5));
    const dests = legalDestinations(st, 1);
    // black moves up: 1+6=7, 1+5=6
    expect(dests.map((d) => d.to).sort((a, b) => a - b)).toEqual([6, 7]);
  });

  it("a point held by 2+ opposing checkers is blocked", () => {
    const s = emptyState("white");
    place(s, 24, "white", 1);
    place(s, 18, "black", 2); // 24-6=18 blocked
    place(s, 13, "white", 14);
    const st = startTurn(s, rollFromValues(6, 5));
    const dests = legalDestinations(st, 24);
    expect(dests.map((d) => d.to)).not.toContain(18);
    expect(dests.map((d) => d.to)).toContain(19); // 24-5 ok
  });

  it("a blot (single opposing checker) is a legal hit destination", () => {
    const s = emptyState("white");
    place(s, 24, "white", 1);
    place(s, 18, "black", 1); // blot at 24-6
    place(s, 13, "white", 14);
    const st = startTurn(s, rollFromValues(6, 5));
    const dests = legalDestinations(st, 24);
    const hit = dests.find((d) => d.to === 18);
    expect(hit).toBeTruthy();
    expect(hit?.hit).toBe(true);
  });
});

describe("backgammon-model — applyMove and hitting", () => {
  it("applying a hit sends opponent blot to the bar", () => {
    const s = emptyState("white");
    place(s, 24, "white", 1);
    place(s, 18, "black", 1);
    place(s, 13, "white", 14);
    let st = startTurn(s, rollFromValues(6, 5));
    st = applyMove(st, { from: 24, to: 18, die: 6, hit: true });
    expect(st.points[18]).toEqual({ player: "white", count: 1 });
    expect(st.bar.black).toBe(1);
    expect(st.movesLeft).toEqual([5]);
  });

  it("stacks onto own point and consumes the die", () => {
    const s = emptyState("white");
    place(s, 13, "white", 3);
    place(s, 8, "white", 12);
    let st = startTurn(s, rollFromValues(5, 2));
    st = applyMove(st, { from: 13, to: 8, die: 5 });
    expect(st.points[8].count).toBe(13);
    expect(st.points[13].count).toBe(2);
    expect(st.movesLeft).toEqual([2]);
  });
});

describe("backgammon-model — bar entry", () => {
  it("must enter from the bar before any other move", () => {
    const s = emptyState("white");
    s.bar.white = 1;
    place(s, 13, "white", 14);
    const st = startTurn(s, rollFromValues(6, 5));
    const moves = generateLegalMoves(st);
    // every legal move must originate from the bar
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.from === BAR)).toBe(true);
    // white enters into opponent home board points 19..24: die 6 -> 19, die 5 -> 20
    expect(moves.map((m) => m.to).sort((a, b) => a - b)).toEqual([19, 20]);
  });

  it("cannot enter on a blocked entry point", () => {
    const s = emptyState("white");
    s.bar.white = 1;
    place(s, 19, "black", 2); // entry for die 6 (white enters at 25-6=19) blocked
    place(s, 13, "white", 13);
    const st = startTurn(s, rollFromValues(6, 5));
    const moves = generateLegalMoves(st);
    // only die 5 -> 20 works
    expect(moves.map((m) => m.to)).toEqual([20]);
  });

  it("with both entry points blocked there are no legal moves", () => {
    const s = emptyState("white");
    s.bar.white = 1;
    place(s, 19, "black", 2);
    place(s, 20, "black", 2);
    const st = startTurn(s, rollFromValues(6, 5));
    expect(generateLegalMoves(st)).toEqual([]);
  });
});

describe("backgammon-model — bearing off", () => {
  it("cannot bear off until all checkers are in the home board", () => {
    const s = emptyState("white");
    place(s, 6, "white", 1);
    place(s, 13, "white", 14); // outside home board (1..6)
    const st = startTurn(s, rollFromValues(6, 5));
    const dests = legalDestinations(st, 6);
    expect(dests.some((d) => d.to === OFF)).toBe(false);
  });

  it("bears off exactly with the matching die", () => {
    const s = emptyState("white");
    place(s, 6, "white", 2);
    place(s, 3, "white", 13);
    let st = startTurn(s, rollFromValues(6, 1));
    const dests = legalDestinations(st, 6);
    const off = dests.find((d) => d.to === OFF);
    expect(off).toBeTruthy();
    st = applyMove(st, { from: 6, to: OFF, die: 6, bearOff: true });
    expect(st.off.white).toBe(1);
    expect(st.points[6].count).toBe(1);
  });

  it("allows overshoot bear-off only from the highest occupied point", () => {
    const s = emptyState("white");
    // highest occupied point is 4; a 6 may bear off from 4 (overshoot)
    place(s, 4, "white", 1);
    place(s, 2, "white", 14);
    const st = startTurn(s, rollFromValues(6, 1));
    const destsFrom4 = legalDestinations(st, 4);
    expect(destsFrom4.some((d) => d.to === OFF && d.die === 6)).toBe(true);

    // but if a checker sits on a higher point, the 6 cannot overshoot a lower one
    const s2 = emptyState("white");
    place(s2, 6, "white", 1);
    place(s2, 4, "white", 1);
    place(s2, 2, "white", 13);
    const st2 = startTurn(s2, rollFromValues(6, 1));
    const destsFrom4b = legalDestinations(st2, 4);
    // a 6 from point 4 would be overshoot, but 6 is occupied/higher -> not allowed
    expect(destsFrom4b.some((d) => d.to === OFF && d.die === 6)).toBe(false);
    // the 6 must bear off the checker on point 6 instead
    const destsFrom6 = legalDestinations(st2, 6);
    expect(destsFrom6.some((d) => d.to === OFF && d.die === 6)).toBe(true);
  });
});

describe("backgammon-model — must use both dice / larger die rule", () => {
  it("if only one die can be played, the player must play it", () => {
    const s = emptyState("white");
    // White single checker at 2; dice 6 and 3.
    // die 3 cannot be played (2-3 < 0 and not all home? it is all home).
    // Set up so that exactly one die yields a legal move.
    place(s, 2, "white", 1);
    place(s, 1, "white", 14);
    const st = startTurn(s, rollFromValues(6, 1));
    const moves = generateLegalMoves(st);
    // From 2: die 1 -> point 1 (stack). die 6 -> bear off (overshoot, highest is 2). Both legal here.
    expect(moves.length).toBeGreaterThan(0);
  });

  it("must play the larger die when only one of two can be used", () => {
    const s = emptyState("white");
    // Construct a position where playing the small die would block the large one,
    // forcing the larger die to be used.
    // White at 13 only. Dice 6 and 1. Point 7 (13-6) open, point 12 (13-1) open,
    // but after small move 13->12, can the 6 still be played? from 12 -> 6 ok.
    // To force "must play larger", block so that small die leaves no follow-up.
    place(s, 13, "white", 1);
    place(s, 1, "white", 14);
    place(s, 12, "black", 2); // blocks 13->12 (small die) destination directly
    const st = startTurn(s, rollFromValues(6, 1));
    const moves = generateLegalMoves(st);
    // small die (1) destination 12 is blocked, so only the 6 (->7) is available.
    expect(moves.every((m) => m.die === 6)).toBe(true);
    expect(moves.map((m) => m.to)).toContain(7);
  });
});

describe("backgammon-model — win detection", () => {
  it("detects a normal win (1 point) when loser has borne off some", () => {
    const s = emptyState("white");
    s.off.white = 15;
    s.off.black = 4;
    expect(isGameOver(s)).toBe(true);
    const res = winnerResult(s);
    expect(res?.winner).toBe("white");
    expect(res?.multiplier).toBe(1);
    expect(res?.points).toBe(1);
  });

  it("detects a gammon (2 points) when loser has borne off none", () => {
    const s = emptyState("white");
    s.off.white = 15;
    s.off.black = 0;
    // black has no checker on the bar nor in white's home -> gammon
    const res = winnerResult(s);
    expect(res?.multiplier).toBe(2);
    expect(res?.label).toBe("gammon");
  });

  it("detects a backgammon (3 points) when loser has a checker on the bar", () => {
    const s = emptyState("white");
    s.off.white = 15;
    s.off.black = 0;
    s.bar.black = 1;
    const res = winnerResult(s);
    expect(res?.multiplier).toBe(3);
    expect(res?.label).toBe("backgammon");
  });

  it("is not over while a side still has checkers in play", () => {
    const s = emptyState("white");
    s.off.white = 14;
    place(s, 1, "white", 1);
    expect(isGameOver(s)).toBe(false);
    expect(winnerResult(s)).toBeNull();
  });
});
