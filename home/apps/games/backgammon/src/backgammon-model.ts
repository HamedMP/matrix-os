// Pure, UI-free backgammon engine. Deterministic with injectable dice.
//
// Board numbering (standard, 1..24):
//   - White moves from high points toward 1 and bears off past point 1.
//     White home board = points 1..6. White enters from the bar onto 19..24.
//   - Black moves from low points toward 24 and bears off past point 24.
//     Black home board = points 19..24. Black enters from the bar onto 1..6.
//
// Special destinations:
export const BAR = -1; // a checker sitting on the bar (used as move.from)
export const OFF = 0; // borne off (used as move.to)

export type Player = "white" | "black";

export interface Point {
  player: Player | null;
  count: number;
}

export interface GameState {
  // points[1..24]; index 0 is unused padding.
  points: Point[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
  turn: Player;
  dice: number[]; // the raw roll (2 values; doubles repeat)
  movesLeft: number[]; // remaining die pips that can still be played this turn
  history: HistorySnapshot[]; // for undo within the current turn
}

export interface HistorySnapshot {
  points: Point[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
  movesLeft: number[];
}

export interface Move {
  from: number; // 1..24 or BAR
  to: number; // 1..24 or OFF
  die: number;
  hit?: boolean;
  bearOff?: boolean;
}

export interface Roll {
  values: [number, number];
}

export interface WinResult {
  winner: Player;
  multiplier: 1 | 2 | 3;
  points: number;
  label: "single" | "gammon" | "backgammon";
}

function clonePoints(points: Point[]): Point[] {
  return points.map((p) => ({ player: p.player, count: p.count }));
}

export function createInitialState(): GameState {
  const points: Point[] = [];
  for (let i = 0; i <= 24; i++) points.push({ player: null, count: 0 });

  // White (moves 24 -> 1)
  points[24] = { player: "white", count: 2 };
  points[13] = { player: "white", count: 5 };
  points[8] = { player: "white", count: 3 };
  points[6] = { player: "white", count: 5 };
  // Black (mirror, moves 1 -> 24)
  points[1] = { player: "black", count: 2 };
  points[12] = { player: "black", count: 5 };
  points[17] = { player: "black", count: 3 };
  points[19] = { player: "black", count: 5 };

  return {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    dice: [],
    movesLeft: [],
    history: [],
  };
}

export function rollFromValues(a: number, b: number): Roll {
  return { values: [a, b] };
}

export function rollDice(rng: () => number = Math.random): Roll {
  const d = () => Math.floor(rng() * 6) + 1;
  return { values: [d(), d()] };
}

// Begin a turn with a given roll: sets dice + movesLeft, clears undo history.
export function startTurn(state: GameState, roll: Roll): GameState {
  const [a, b] = roll.values;
  const movesLeft = a === b ? [a, a, a, a] : [a, b];
  return {
    ...state,
    points: clonePoints(state.points),
    bar: { ...state.bar },
    off: { ...state.off },
    dice: [a, b],
    movesLeft: [...movesLeft],
    history: [],
  };
}

function opponent(p: Player): Player {
  return p === "white" ? "black" : "white";
}

// The destination point for a checker leaving `from` using `die`, in board coords.
// Returns OFF when the checker would bear off, or a number outside 1..24 when illegal.
function targetPoint(state: GameState, from: number, die: number): number {
  const player = state.turn;
  if (from === BAR) {
    // entry point
    return player === "white" ? 25 - die : die;
  }
  return player === "white" ? from - die : from + die;
}

function inHomeBoard(state: GameState, player: Player): boolean {
  if (player === "white") {
    if (state.bar.white > 0) return false;
    for (let i = 7; i <= 24; i++) {
      if (state.points[i].player === "white" && state.points[i].count > 0) return false;
    }
    return true;
  }
  if (state.bar.black > 0) return false;
  for (let i = 1; i <= 18; i++) {
    if (state.points[i].player === "black" && state.points[i].count > 0) return false;
  }
  return true;
}

// Highest point distance from bearing-off edge that the player still occupies.
// For white, that's the largest point index in 1..6. For black, smallest index in 19..24
// expressed as a "pip from edge" (25 - index).
function highestHomePip(state: GameState, player: Player): number {
  if (player === "white") {
    for (let i = 6; i >= 1; i--) {
      if (state.points[i].player === "white" && state.points[i].count > 0) return i;
    }
    return 0;
  }
  for (let i = 19; i <= 24; i++) {
    if (state.points[i].player === "black" && state.points[i].count > 0) return 25 - i;
  }
  return 0;
}

// distance to bear off from a home point for the current player
function bearOffPip(player: Player, from: number): number {
  return player === "white" ? from : 25 - from;
}

function canLandOn(state: GameState, to: number): { ok: boolean; hit: boolean } {
  if (to < 1 || to > 24) return { ok: false, hit: false };
  const pt = state.points[to];
  const opp = opponent(state.turn);
  if (pt.player === opp && pt.count >= 2) return { ok: false, hit: false };
  const hit = pt.player === opp && pt.count === 1;
  return { ok: true, hit };
}

// All single-die legal moves from a given source for the current movesLeft set.
export function legalDestinations(state: GameState, from: number): Move[] {
  const player = state.turn;
  const moves: Move[] = [];
  const dice = uniqueDice(state.movesLeft);

  // If on the bar, only bar entries are legal.
  const onBar = player === "white" ? state.bar.white > 0 : state.bar.black > 0;
  if (onBar && from !== BAR) return [];
  if (!onBar && from === BAR) return [];

  // Source must hold a checker of the current player (unless it's the bar).
  if (from !== BAR) {
    const src = state.points[from];
    if (src.player !== player || src.count <= 0) return [];
  }

  for (const die of dice) {
    if (from === BAR) {
      const entry = targetPoint(state, BAR, die);
      const land = canLandOn(state, entry);
      if (land.ok) moves.push({ from: BAR, to: entry, die, hit: land.hit });
      continue;
    }

    const to = targetPoint(state, from, die);
    if (to >= 1 && to <= 24) {
      const land = canLandOn(state, to);
      if (land.ok) moves.push({ from, to, die, hit: land.hit });
      continue;
    }

    // Off the edge: possible bear-off.
    if (!inHomeBoard(state, player)) continue;
    const pip = bearOffPip(player, from);
    if (die === pip) {
      moves.push({ from, to: OFF, die, bearOff: true });
    } else if (die > pip) {
      // Overshoot only allowed if no checker sits on a higher point.
      if (highestHomePip(state, player) <= pip) {
        moves.push({ from, to: OFF, die, bearOff: true });
      }
    }
  }

  return moves;
}

function uniqueDice(movesLeft: number[]): number[] {
  return Array.from(new Set(movesLeft));
}

function ownSources(state: GameState): number[] {
  const player = state.turn;
  const onBar = player === "white" ? state.bar.white > 0 : state.bar.black > 0;
  if (onBar) return [BAR];
  const sources: number[] = [];
  for (let i = 1; i <= 24; i++) {
    if (state.points[i].player === player && state.points[i].count > 0) sources.push(i);
  }
  return sources;
}

// All legal single moves available right now (raw, before the "must use both dice" filter).
function rawLegalMoves(state: GameState): Move[] {
  const moves: Move[] = [];
  for (const src of ownSources(state)) {
    moves.push(...legalDestinations(state, src));
  }
  return moves;
}

// Apply a single move and consume one matching die. Returns a new state.
// Pushes a snapshot for undo.
export function applyMove(state: GameState, move: Move): GameState {
  const next: GameState = {
    ...state,
    points: clonePoints(state.points),
    bar: { ...state.bar },
    off: { ...state.off },
    movesLeft: [...state.movesLeft],
    history: [
      ...state.history,
      {
        points: clonePoints(state.points),
        bar: { ...state.bar },
        off: { ...state.off },
        movesLeft: [...state.movesLeft],
      },
    ],
  };
  const player = state.turn;
  const opp = opponent(player);

  // remove from source
  if (move.from === BAR) {
    next.bar[player] -= 1;
  } else {
    const src = next.points[move.from];
    src.count -= 1;
    if (src.count === 0) src.player = null;
  }

  // place at destination
  if (move.to === OFF) {
    next.off[player] += 1;
  } else {
    const dest = next.points[move.to];
    if (move.hit || (dest.player === opp && dest.count === 1)) {
      // send opponent blot to the bar
      next.bar[opp] += 1;
      dest.player = player;
      dest.count = 1;
    } else {
      dest.player = player;
      dest.count += 1;
    }
  }

  // consume the die
  const idx = next.movesLeft.indexOf(move.die);
  if (idx >= 0) next.movesLeft.splice(idx, 1);

  return next;
}

// Undo the last move within the current turn. No-op if no history.
export function undo(state: GameState): GameState {
  if (state.history.length === 0) return state;
  const history = [...state.history];
  const snap = history.pop()!;
  return {
    ...state,
    points: clonePoints(snap.points),
    bar: { ...snap.bar },
    off: { ...snap.off },
    movesLeft: [...snap.movesLeft],
    history,
  };
}

// Whether the current player has any legal move with the remaining dice.
export function hasAnyMove(state: GameState): boolean {
  return rawLegalMoves(state).length > 0;
}

// Max number of die-plays the player could make from this position (search).
function maxPlayable(state: GameState, depth = 0): number {
  if (state.movesLeft.length === 0) return 0;
  const moves = rawLegalMoves(state);
  if (moves.length === 0) return 0;
  let best = 0;
  for (const m of moves) {
    const after = applyMove(state, m);
    const sub = 1 + maxPlayable(after, depth + 1);
    if (sub > best) best = sub;
  }
  return best;
}

// Legal moves enforcing the "must use both dice if possible / larger die if only one" rule.
export function generateLegalMoves(state: GameState): Move[] {
  const raw = rawLegalMoves(state);
  if (raw.length === 0) return [];

  // Doubles or already-partial turns: still enforce maximal usage.
  const maxUse = maxPlayable(state);

  // Keep only moves that allow the player to reach the maximum number of die-plays.
  let filtered = raw.filter((m) => {
    const after = applyMove(state, m);
    return 1 + maxPlayable(after) >= maxUse;
  });

  // Special rule: when only ONE die can be played (maxUse === 1) and the two dice differ,
  // the player must play the larger die if a choice exists.
  const distinctDice = uniqueDice(state.movesLeft);
  if (maxUse === 1 && distinctDice.length === 2) {
    const larger = Math.max(...distinctDice);
    const hasLarger = filtered.some((m) => m.die === larger);
    if (hasLarger) {
      filtered = filtered.filter((m) => m.die === larger);
    }
  }

  return filtered;
}

export function pipCount(state: GameState, player: Player): number {
  let total = 0;
  for (let i = 1; i <= 24; i++) {
    const pt = state.points[i];
    if (pt.player !== player) continue;
    const pip = player === "white" ? i : 25 - i;
    total += pip * pt.count;
  }
  total += state.bar[player] * 25;
  return total;
}

export function isGameOver(state: GameState): boolean {
  return state.off.white >= 15 || state.off.black >= 15;
}

export function winnerResult(state: GameState): WinResult | null {
  if (!isGameOver(state)) return null;
  const winner: Player = state.off.white >= 15 ? "white" : "black";
  const loser = opponent(winner);

  if (state.off[loser] > 0) {
    return { winner, multiplier: 1, points: 1, label: "single" };
  }

  // Loser has borne off nothing -> at least a gammon.
  // Backgammon if the loser still has a checker on the bar or in the winner's home board.
  const loserOnBarOrWinnerHome = (() => {
    if (state.bar[loser] > 0) return true;
    // winner's home board: white -> 1..6, black -> 19..24
    if (winner === "white") {
      for (let i = 1; i <= 6; i++) {
        if (state.points[i].player === loser && state.points[i].count > 0) return true;
      }
    } else {
      for (let i = 19; i <= 24; i++) {
        if (state.points[i].player === loser && state.points[i].count > 0) return true;
      }
    }
    return false;
  })();

  if (loserOnBarOrWinnerHome) {
    return { winner, multiplier: 3, points: 3, label: "backgammon" };
  }
  return { winner, multiplier: 2, points: 2, label: "gammon" };
}

// Convenience: bear-off readiness for UI badges.
export function canBearOff(state: GameState, player: Player): boolean {
  return inHomeBoard(state, player);
}
