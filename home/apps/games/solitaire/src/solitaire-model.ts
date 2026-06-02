// Pure Klondike Solitaire engine — UI-free, deterministic, unit-testable.
// All randomness is injected via an RNG `() => number` (0 <= n < 1).

export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Color = "red" | "black";

export interface Card {
  id: string; // stable id, e.g. "spades-1"
  suit: Suit;
  rank: number; // 1 (Ace) .. 13 (King)
  faceUp: boolean;
}

// Tableau piles: 7. Foundation piles: 4 (one per suit, by index but suit-agnostic).
export interface GameState {
  stock: Card[]; // face-down draw pile (top = last element)
  waste: Card[]; // face-up discard (top = last element)
  foundations: Card[][]; // 4 piles, ascending same-suit
  tableau: Card[][]; // 7 piles
  drawCount: 1 | 3; // draw 1 or draw 3
  moves: number;
  score: number;
}

export const SUITS: Suit[] = ["spades", "hearts", "diamonds", "clubs"];
export const RED_SUITS: Suit[] = ["hearts", "diamonds"];

export function suitColor(suit: Suit): Color {
  return suit === "hearts" || suit === "diamonds" ? "red" : "black";
}

export const RANK_LABELS: Record<number, string> = {
  1: "A",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
};

export const SUIT_SYMBOLS: Record<Suit, string> = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
};

// ---- Deck -----------------------------------------------------------------

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank += 1) {
      deck.push({ id: `${suit}-${rank}`, suit, rank, faceUp: false });
    }
  }
  return deck;
}

// Fisher–Yates with an injectable RNG.
export function shuffle<T>(items: T[], rng: () => number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// ---- Deal -----------------------------------------------------------------

// Klondike deal: 7 tableau piles, pile i gets i+1 cards, top card face-up,
// 28 cards total in the tableau, rest into the stock face-down.
export function deal(rng: () => number, drawCount: 1 | 3 = 1): GameState {
  const deck = shuffle(buildDeck(), rng);
  const tableau: Card[][] = [[], [], [], [], [], [], []];
  let idx = 0;
  for (let pile = 0; pile < 7; pile += 1) {
    for (let n = 0; n <= pile; n += 1) {
      const card = { ...deck[idx] };
      card.faceUp = n === pile; // only last card face-up
      tableau[pile].push(card);
      idx += 1;
    }
  }
  const stock = deck.slice(idx).map((c) => ({ ...c, faceUp: false }));
  return {
    stock,
    waste: [],
    foundations: [[], [], [], []],
    tableau,
    drawCount,
    moves: 0,
    score: 0,
  };
}

// ---- Helpers --------------------------------------------------------------

export function cloneState(s: GameState): GameState {
  return {
    stock: s.stock.map((c) => ({ ...c })),
    waste: s.waste.map((c) => ({ ...c })),
    foundations: s.foundations.map((p) => p.map((c) => ({ ...c }))),
    tableau: s.tableau.map((p) => p.map((c) => ({ ...c }))),
    drawCount: s.drawCount,
    moves: s.moves,
    score: s.score,
  };
}

function topOf(pile: Card[]): Card | undefined {
  return pile.length > 0 ? pile[pile.length - 1] : undefined;
}

// ---- Legality -------------------------------------------------------------

// A card may stack on a tableau pile if alternating color + descending rank,
// or the pile is empty and the moving card is a King.
export function canStackOnTableau(moving: Card, pile: Card[]): boolean {
  const top = topOf(pile);
  if (!top) return moving.rank === 13; // only Kings to empty
  if (!top.faceUp) return false;
  return suitColor(moving.suit) !== suitColor(top.suit) && moving.rank === top.rank - 1;
}

// A card may go to a foundation pile if it is an Ace onto an empty pile, or
// the same suit and exactly one rank higher than the foundation's top card.
export function canMoveToFoundation(moving: Card, pile: Card[]): boolean {
  const top = topOf(pile);
  if (!top) return moving.rank === 1; // Ace starts a foundation
  return moving.suit === top.suit && moving.rank === top.rank + 1;
}

// Is a run of face-up tableau cards starting at index `start` a valid movable
// sequence (alternating color, descending)?
export function isMovableRun(pile: Card[], start: number): boolean {
  if (start < 0 || start >= pile.length) return false;
  for (let i = start; i < pile.length; i += 1) {
    if (!pile[i].faceUp) return false;
    if (i > start) {
      const prev = pile[i - 1];
      const cur = pile[i];
      if (suitColor(prev.suit) === suitColor(cur.suit) || cur.rank !== prev.rank - 1) {
        return false;
      }
    }
  }
  return true;
}

// ---- Move sources ---------------------------------------------------------

export type Source =
  | { type: "waste" }
  | { type: "foundation"; pile: number }
  | { type: "tableau"; pile: number; index: number };

function flipExposed(pile: Card[]): boolean {
  const top = topOf(pile);
  if (top && !top.faceUp) {
    top.faceUp = true;
    return true;
  }
  return false;
}

function takeFromSource(s: GameState, src: Source): Card[] | null {
  if (src.type === "waste") {
    const c = s.waste.pop();
    return c ? [c] : null;
  }
  if (src.type === "foundation") {
    const c = s.foundations[src.pile].pop();
    return c ? [c] : null;
  }
  // tableau run from index to end
  const pile = s.tableau[src.pile];
  if (src.index < 0 || src.index >= pile.length) return null;
  if (!isMovableRun(pile, src.index)) return null;
  return pile.splice(src.index);
}

// ---- Draw / recycle -------------------------------------------------------

export function drawFromStock(state: GameState): GameState {
  const s = cloneState(state);
  if (s.stock.length === 0) {
    // recycle waste back into stock (reversed, face-down)
    if (s.waste.length === 0) return state; // nothing to do
    s.stock = s.waste.reverse().map((c) => ({ ...c, faceUp: false }));
    s.waste = [];
    s.moves += 1;
    return s;
  }
  const n = Math.min(s.drawCount, s.stock.length);
  for (let i = 0; i < n; i += 1) {
    const c = s.stock.pop();
    if (c) {
      c.faceUp = true;
      s.waste.push(c);
    }
  }
  s.moves += 1;
  return s;
}

// ---- Apply a move ---------------------------------------------------------

// Destination is either a tableau pile or a foundation pile.
export type Destination =
  | { type: "tableau"; pile: number }
  | { type: "foundation"; pile: number };

function scoreFor(src: Source, dest: Destination): number {
  // Microsoft-style standard scoring (subset).
  if (dest.type === "foundation") return 10;
  if (src.type === "waste" && dest.type === "tableau") return 5;
  if (src.type === "foundation" && dest.type === "tableau") return -15;
  return 0;
}

export function isLegalMove(state: GameState, src: Source, dest: Destination): boolean {
  // Foundations only accept single cards.
  if (dest.type === "foundation") {
    if (src.type === "foundation") return false;
    let moving: Card | undefined;
    if (src.type === "waste") moving = topOf(state.waste);
    else {
      const pile = state.tableau[src.pile];
      // a foundation move from tableau must be the single bottom-most face-up card
      if (src.index !== pile.length - 1) return false;
      moving = topOf(pile);
    }
    if (!moving || !moving.faceUp) return false;
    return canMoveToFoundation(moving, state.foundations[dest.pile]);
  }
  // tableau destination
  let movingFirst: Card | undefined;
  if (src.type === "waste") movingFirst = topOf(state.waste);
  else if (src.type === "foundation") movingFirst = topOf(state.foundations[src.pile]);
  else {
    const pile = state.tableau[src.pile];
    if (!isMovableRun(pile, src.index)) return false;
    movingFirst = pile[src.index];
  }
  if (!movingFirst || !movingFirst.faceUp) return false;
  // Cannot move onto the same tableau pile
  if (src.type === "tableau" && src.pile === dest.pile) return false;
  return canStackOnTableau(movingFirst, state.tableau[dest.pile]);
}

// Apply a move, returning a new state, or null if illegal.
export function applyMove(state: GameState, src: Source, dest: Destination): GameState | null {
  if (!isLegalMove(state, src, dest)) return null;
  const s = cloneState(state);
  const cards = takeFromSource(s, src);
  if (!cards) return null;
  if (dest.type === "foundation") {
    s.foundations[dest.pile].push(cards[0]);
  } else {
    s.tableau[dest.pile].push(...cards);
  }
  // flip the newly exposed tableau card under the source
  if (src.type === "tableau") {
    flipExposed(s.tableau[src.pile]);
  }
  s.moves += 1;
  s.score = Math.max(0, s.score + scoreFor(src, dest));
  return s;
}

// ---- Auto-route -----------------------------------------------------------

// Find a legal destination for a click on a given source. Prefers foundation
// for a single top card, then any legal tableau pile.
export function findAutoDestination(state: GameState, src: Source): Destination | null {
  if (src.type === "foundation") return null;

  const isSingleTop =
    (src.type === "waste") ||
    (src.type === "tableau" && src.index === state.tableau[src.pile].length - 1);

  if (isSingleTop) {
    for (let f = 0; f < 4; f += 1) {
      if (isLegalMove(state, src, { type: "foundation", pile: f })) {
        return { type: "foundation", pile: f };
      }
    }
  }
  for (let t = 0; t < 7; t += 1) {
    if (isLegalMove(state, src, { type: "tableau", pile: t })) {
      // Prefer non-empty piles so we don't waste a King slot needlessly,
      // but still allow empty as a fallback (handled by ordering below).
      const dest: Destination = { type: "tableau", pile: t };
      if (state.tableau[t].length > 0) return dest;
    }
  }
  // empty tableau fallback
  for (let t = 0; t < 7; t += 1) {
    if (state.tableau[t].length === 0 && isLegalMove(state, src, { type: "tableau", pile: t })) {
      return { type: "tableau", pile: t };
    }
  }
  return null;
}

// Send a single card to a foundation if legal; returns new state or null.
export function autoMoveToFoundation(state: GameState, src: Source): GameState | null {
  for (let f = 0; f < 4; f += 1) {
    const next = applyMove(state, src, { type: "foundation", pile: f });
    if (next) return next;
  }
  return null;
}

// ---- Auto-complete --------------------------------------------------------

// True when every card is face-up (stock+waste empty or fully exposed): the
// game is mechanically solved and can auto-finish to the foundations.
export function canAutoComplete(state: GameState): boolean {
  if (isWon(state)) return false;
  if (state.stock.length > 0) return false;
  for (const pile of state.tableau) {
    for (const card of pile) {
      if (!card.faceUp) return false;
    }
  }
  return autoCompleteStep(state) !== null;
}

// Perform one auto-complete step: send the lowest available top card to a
// foundation. Returns the next state, or null if no move is available.
export function autoCompleteStep(state: GameState): GameState | null {
  const candidates: Source[] = [];
  if (state.waste.length > 0) candidates.push({ type: "waste" });
  for (let t = 0; t < 7; t += 1) {
    const pile = state.tableau[t];
    if (pile.length > 0) candidates.push({ type: "tableau", pile: t, index: pile.length - 1 });
  }
  // choose the candidate with the lowest rank that has a legal foundation move
  let best: { src: Source; rank: number } | null = null;
  for (const src of candidates) {
    let card: Card | undefined;
    if (src.type === "waste") card = topOf(state.waste);
    else if (src.type === "tableau") card = topOf(state.tableau[src.pile]);
    if (!card) continue;
    for (let f = 0; f < 4; f += 1) {
      if (isLegalMove(state, src, { type: "foundation", pile: f })) {
        if (!best || card.rank < best.rank) best = { src, rank: card.rank };
        break;
      }
    }
  }
  if (!best) return null;
  return autoMoveToFoundation(state, best.src);
}

// ---- Win ------------------------------------------------------------------

export function isWon(state: GameState): boolean {
  return state.foundations.every((pile) => pile.length === 13);
}
