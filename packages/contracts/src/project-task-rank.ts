/**
 * Fractional ranks for card order (spec 2699): base-62 digit strings compared
 * as plain strings. A rank never ends in the zero digit, so there is always
 * room for another rank between two neighbours.
 */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Ranks are bounded so a pathological insert pattern cannot grow them forever. */
export const MAX_TASK_RANK_LENGTH = 128;

export class TaskRankError extends Error {
  constructor(readonly code: "invalid_rank" | "rank_order" | "rank_exhausted") {
    super(code);
    this.name = "TaskRankError";
  }
}

function midpoint(low: string, high: string | null): string {
  if (high !== null) {
    let shared = 0;
    while ((low[shared] ?? "0") === high[shared]) shared += 1;
    if (shared > 0) return high.slice(0, shared) + midpoint(low.slice(shared), high.slice(shared));
  }
  const lowDigit = low ? DIGITS.indexOf(low[0]!) : 0;
  const highDigit = high !== null ? DIGITS.indexOf(high[0]!) : DIGITS.length;
  if (highDigit - lowDigit > 1) return DIGITS[Math.round((lowDigit + highDigit) / 2)]!;
  if (high !== null && high.length > 1) return high.slice(0, 1);
  return DIGITS[lowDigit]! + midpoint(low.slice(1), null);
}

export function isTaskRank(rank: string): boolean {
  return rank.length > 0 && rank.length <= MAX_TASK_RANK_LENGTH && !rank.endsWith("0")
    && [...rank].every((digit) => DIGITS.includes(digit));
}

/** A rank that sorts after `before` and before `after`; `null` means the column's open end. */
export function rankBetween(before: string | null, after: string | null): string {
  if ((before !== null && !isTaskRank(before)) || (after !== null && !isTaskRank(after))) throw new TaskRankError("invalid_rank");
  if (before !== null && after !== null && before >= after) throw new TaskRankError("rank_order");
  const rank = midpoint(before ?? "", after);
  if (rank.length > MAX_TASK_RANK_LENGTH) throw new TaskRankError("rank_exhausted");
  return rank;
}

/** `count` evenly spaced, fixed-width ranks for an imported or rebalanced column, in order. */
export function spreadRanks(count: number): string[] {
  if (!Number.isInteger(count) || count < 0 || count > 1_000_000) throw new TaskRankError("invalid_rank");
  let width = 1;
  while (DIGITS.length ** width <= count + 1) width += 1;
  const step = Math.floor(DIGITS.length ** width / (count + 1));
  const ranks: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    let value = index * step;
    let encoded = "";
    for (let position = 0; position < width; position += 1) {
      encoded = DIGITS[value % DIGITS.length]! + encoded;
      value = Math.floor(value / DIGITS.length);
    }
    // A trailing digit keeps every rank valid (never ending in zero) without changing the order.
    ranks.push(`${encoded}V`);
  }
  return ranks;
}
