import { describe, expect, it } from "vitest";
import {
  type Card,
  type GameState,
  type Suit,
  applyMove,
  autoCompleteStep,
  autoMoveToFoundation,
  buildDeck,
  canAutoComplete,
  canMoveToFoundation,
  canStackOnTableau,
  cloneState,
  deal,
  drawFromStock,
  findAutoDestination,
  isLegalMove,
  isMovableRun,
  isWon,
  shuffle,
  suitColor,
} from "../../home/apps/games/solitaire/src/solitaire-model";

// Deterministic RNG cycling through a sequence.
function seqRng(seq: number[]): () => number {
  let i = 0;
  return () => seq[i++ % seq.length];
}

function card(suit: Suit, rank: number, faceUp = true): Card {
  return { id: `${suit}-${rank}`, suit, rank, faceUp };
}

function emptyState(over: Partial<GameState> = {}): GameState {
  return {
    stock: [],
    waste: [],
    foundations: [[], [], [], []],
    tableau: [[], [], [], [], [], [], []],
    drawCount: 1,
    moves: 0,
    score: 0,
    ...over,
  };
}

describe("deck", () => {
  it("builds 52 unique cards face-down", () => {
    const deck = buildDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((c) => c.id)).size).toBe(52);
    expect(deck.every((c) => !c.faceUp)).toBe(true);
  });

  it("shuffle is a permutation and uses the rng", () => {
    const deck = buildDeck();
    const shuffled = shuffle(deck, seqRng([0.99, 0.1, 0.5, 0.3]));
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled.map((c) => c.id)).size).toBe(52);
  });
});

describe("deal", () => {
  it("lays out 28 cards across 7 piles with only the top face-up", () => {
    const s = deal(seqRng([0.42]));
    expect(s.tableau).toHaveLength(7);
    let total = 0;
    s.tableau.forEach((pile, i) => {
      expect(pile).toHaveLength(i + 1);
      total += pile.length;
      pile.forEach((c, idx) => {
        expect(c.faceUp).toBe(idx === pile.length - 1);
      });
    });
    expect(total).toBe(28);
    expect(s.stock).toHaveLength(24);
    expect(s.stock.every((c) => !c.faceUp)).toBe(true);
    expect(s.waste).toHaveLength(0);
    expect(s.foundations.flat()).toHaveLength(0);
  });
});

describe("tableau legality", () => {
  it("allows alternating-color descending", () => {
    // red 7 on black 8
    expect(canStackOnTableau(card("hearts", 7), [card("spades", 8)])).toBe(true);
    expect(canStackOnTableau(card("diamonds", 7), [card("clubs", 8)])).toBe(true);
  });
  it("rejects same color or wrong rank", () => {
    expect(canStackOnTableau(card("hearts", 7), [card("diamonds", 8)])).toBe(false);
    expect(canStackOnTableau(card("hearts", 6), [card("spades", 8)])).toBe(false);
  });
  it("only a King may go to an empty pile", () => {
    expect(canStackOnTableau(card("spades", 13), [])).toBe(true);
    expect(canStackOnTableau(card("spades", 12), [])).toBe(false);
  });
});

describe("foundation legality", () => {
  it("only an Ace starts a foundation, then same-suit ascending", () => {
    expect(canMoveToFoundation(card("spades", 1), [])).toBe(true);
    expect(canMoveToFoundation(card("spades", 2), [])).toBe(false);
    expect(canMoveToFoundation(card("spades", 2), [card("spades", 1)])).toBe(true);
    expect(canMoveToFoundation(card("hearts", 2), [card("spades", 1)])).toBe(false);
    expect(canMoveToFoundation(card("spades", 3), [card("spades", 1)])).toBe(false);
  });

  it("rejects foundation-to-foundation moves", () => {
    const s = emptyState();
    s.foundations[0] = [card("spades", 1)];

    expect(isLegalMove(s, { type: "foundation", pile: 0 }, { type: "foundation", pile: 1 })).toBe(false);
    expect(applyMove(s, { type: "foundation", pile: 0 }, { type: "foundation", pile: 1 })).toBeNull();
    expect(findAutoDestination(s, { type: "foundation", pile: 0 })).toBeNull();
  });

  it("does not auto-route foundation cards back to tableau on single click", () => {
    const s = emptyState();
    s.foundations[0] = [card("spades", 7)];
    s.tableau[0] = [card("hearts", 8)];

    expect(isLegalMove(s, { type: "foundation", pile: 0 }, { type: "tableau", pile: 0 })).toBe(true);
    expect(findAutoDestination(s, { type: "foundation", pile: 0 })).toBeNull();
  });
});

describe("movable runs", () => {
  it("validates alternating descending face-up runs", () => {
    const pile = [card("clubs", 9, false), card("hearts", 8), card("spades", 7), card("diamonds", 6)];
    expect(isMovableRun(pile, 1)).toBe(true);
    expect(isMovableRun(pile, 0)).toBe(false); // face-down
  });
  it("rejects broken runs", () => {
    const pile = [card("hearts", 8), card("diamonds", 7)]; // same color
    expect(isMovableRun(pile, 0)).toBe(false);
  });
});

describe("applyMove", () => {
  it("moves a waste card to a foundation and scores", () => {
    const s = emptyState({ waste: [card("spades", 1)] });
    const next = applyMove(s, { type: "waste" }, { type: "foundation", pile: 0 });
    expect(next).not.toBeNull();
    expect(next!.foundations[0]).toHaveLength(1);
    expect(next!.waste).toHaveLength(0);
    expect(next!.score).toBe(10);
    expect(next!.moves).toBe(1);
  });

  it("moves a tableau run and flips the exposed card", () => {
    const s = emptyState();
    s.tableau[0] = [card("clubs", 10, false), card("hearts", 9), card("spades", 8)];
    s.tableau[1] = [card("clubs", 10)];
    const next = applyMove(s, { type: "tableau", pile: 0, index: 1 }, { type: "tableau", pile: 1 });
    expect(next).not.toBeNull();
    expect(next!.tableau[1]).toHaveLength(3);
    expect(next!.tableau[0]).toHaveLength(1);
    expect(next!.tableau[0][0].faceUp).toBe(true); // flipped
  });

  it("rejects an illegal move", () => {
    const s = emptyState({ waste: [card("spades", 5)] });
    expect(applyMove(s, { type: "waste" }, { type: "foundation", pile: 0 })).toBeNull();
    expect(isLegalMove(s, { type: "waste" }, { type: "foundation", pile: 0 })).toBe(false);
  });

  it("does not mutate the source state", () => {
    const s = emptyState({ waste: [card("spades", 1)] });
    const before = cloneState(s);
    applyMove(s, { type: "waste" }, { type: "foundation", pile: 0 });
    expect(s).toEqual(before);
  });
});

describe("draw / recycle", () => {
  it("draws one card by default and turns it face-up", () => {
    const s = emptyState({ stock: [card("spades", 5, false), card("hearts", 9, false)] });
    const next = drawFromStock(s);
    expect(next.waste).toHaveLength(1);
    expect(next.waste[0].faceUp).toBe(true);
    expect(next.stock).toHaveLength(1);
  });
  it("draws three when drawCount is 3", () => {
    const stock = Array.from({ length: 5 }, (_, i) => card("clubs", i + 1, false));
    const next = drawFromStock(emptyState({ stock, drawCount: 3 }));
    expect(next.waste).toHaveLength(3);
    expect(next.stock).toHaveLength(2);
  });
  it("recycles waste back to stock when stock is empty", () => {
    const s = emptyState({ stock: [], waste: [card("spades", 1), card("hearts", 2)] });
    const next = drawFromStock(s);
    expect(next.stock).toHaveLength(2);
    expect(next.waste).toHaveLength(0);
    expect(next.stock.every((c) => !c.faceUp)).toBe(true);
  });
});

describe("auto-route + auto to foundation", () => {
  it("finds a foundation destination for an Ace", () => {
    const s = emptyState({ waste: [card("diamonds", 1)] });
    const dest = findAutoDestination(s, { type: "waste" });
    expect(dest).toEqual({ type: "foundation", pile: 0 });
  });
  it("autoMoveToFoundation promotes a top card", () => {
    const s = emptyState();
    s.foundations[0] = [card("spades", 1)];
    s.tableau[0] = [card("spades", 2)];
    const next = autoMoveToFoundation(s, { type: "tableau", pile: 0, index: 0 });
    expect(next).not.toBeNull();
    expect(next!.foundations[0]).toHaveLength(2);
  });
});

describe("auto-complete + win", () => {
  it("detects a won game", () => {
    const s = emptyState();
    const suits: Suit[] = ["spades", "hearts", "diamonds", "clubs"];
    s.foundations = suits.map((suit) => Array.from({ length: 13 }, (_, r) => card(suit, r + 1)));
    expect(isWon(s)).toBe(true);
    expect(canAutoComplete(s)).toBe(false);
  });

  it("canAutoComplete when all cards face-up and stock empty", () => {
    const s = emptyState();
    const suits: Suit[] = ["spades", "hearts", "diamonds", "clubs"];
    // each foundation up to Q, each tableau holds the matching King face-up
    s.foundations = suits.map((suit) => Array.from({ length: 12 }, (_, r) => card(suit, r + 1)));
    suits.forEach((suit, i) => {
      s.tableau[i] = [card(suit, 13)];
    });
    expect(canAutoComplete(s)).toBe(true);
    const step = autoCompleteStep(s);
    expect(step).not.toBeNull();
    // one king got promoted
    const promoted = step!.foundations.some((p) => p.length === 13);
    expect(promoted).toBe(true);
  });

  it("can auto-complete through multiple face-up waste cards when stock is empty", () => {
    const s = emptyState();
    s.foundations[0] = [card("spades", 1), card("spades", 2)];
    s.waste = [card("spades", 4), card("spades", 3)];

    expect(canAutoComplete(s)).toBe(true);
    const step = autoCompleteStep(s);
    expect(step?.foundations[0].at(-1)?.rank).toBe(3);
  });

  it("does not offer auto-complete when no top card can move to a foundation", () => {
    const s = emptyState();
    s.tableau[0] = [card("hearts", 1), card("spades", 13)];

    expect(autoCompleteStep(s)).toBeNull();
    expect(canAutoComplete(s)).toBe(false);
  });

  it("auto-completes a near-solved game to a win", () => {
    const s = emptyState();
    const suits: Suit[] = ["spades", "hearts", "diamonds", "clubs"];
    s.foundations = suits.map((suit) => Array.from({ length: 11 }, (_, r) => card(suit, r + 1)));
    suits.forEach((suit, i) => {
      s.tableau[i] = [card(suit, 12), card(suit, 13)].reverse(); // K on top of Q? fix below
    });
    // Lay Q then K so Q is promotable first (Q at top), then K.
    suits.forEach((suit, i) => {
      s.tableau[i] = [card(suit, 13, true), card(suit, 12, true)];
    });
    let cur: GameState | null = s;
    let guard = 0;
    while (cur && !isWon(cur) && guard < 100) {
      cur = autoCompleteStep(cur);
      guard += 1;
    }
    expect(cur).not.toBeNull();
    expect(isWon(cur!)).toBe(true);
  });
});

describe("suitColor", () => {
  it("classifies colors", () => {
    expect(suitColor("hearts")).toBe("red");
    expect(suitColor("diamonds")).toBe("red");
    expect(suitColor("spades")).toBe("black");
    expect(suitColor("clubs")).toBe("black");
  });
});
