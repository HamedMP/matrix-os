/**
 * Root finding for the rate functions (IRR, XIRR, RATE). Newton's method
 * from the caller's guess first; when it does not settle, a scan for a
 * sign change followed by bisection. Every loop is bounded.
 */

const MAX_NEWTON_STEPS = 100;
const MAX_BISECTION_STEPS = 200;
const TOLERANCE = 1e-10;
/** Rates are searched above -1 (a rate of -100% or less has no meaning here). */
const LOWEST_RATE = -0.999999;

function derivative(f: (r: number) => number, r: number): number {
  const h = Math.max(1e-7, Math.abs(r) * 1e-7);
  return (f(r + h) - f(r - h)) / (2 * h);
}

function newton(f: (r: number) => number, guess: number, df?: (r: number) => number): number | null {
  let r = guess;
  for (let i = 0; i < MAX_NEWTON_STEPS; i += 1) {
    const value = f(r);
    if (!Number.isFinite(value)) return null;
    const slope = df === undefined ? derivative(f, r) : df(r);
    if (!Number.isFinite(slope) || slope === 0) return null;
    const next = r - value / slope;
    if (!Number.isFinite(next) || next <= -1) return null;
    if (Math.abs(next - r) <= TOLERANCE * Math.max(1, Math.abs(next))) {
      return Math.abs(f(next)) < 1e-6 * Math.max(1, Math.abs(value)) || Math.abs(f(next)) < 1e-7 ? next : null;
    }
    r = next;
  }
  return null;
}

function bisect(f: (r: number) => number, lo: number, hi: number): number | null {
  let a = lo;
  let b = hi;
  let fa = f(a);
  for (let i = 0; i < MAX_BISECTION_STEPS; i += 1) {
    const mid = (a + b) / 2;
    const fm = f(mid);
    if (!Number.isFinite(fm)) return null;
    if (fm === 0 || (b - a) / 2 < TOLERANCE * Math.max(1, Math.abs(mid))) return mid;
    if (Math.sign(fm) === Math.sign(fa)) {
      a = mid;
      fa = fm;
    } else {
      b = mid;
    }
  }
  return (a + b) / 2;
}

/** Scans outward from the guess for a sign change, then bisects. */
function bracketed(f: (r: number) => number, guess: number): number | null {
  const points: number[] = [LOWEST_RATE];
  for (let r = -0.99; r <= 10; r += 0.01) points.push(Math.round(r * 100) / 100);
  for (let r = 11; r <= 1000; r *= 1.5) points.push(r);
  let best: [number, number] | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as number;
    const b = points[i] as number;
    const fa = f(a);
    const fb = f(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb) || Math.sign(fa) === Math.sign(fb)) continue;
    // Prefer the bracket closest to the guess.
    if (best === null || Math.abs((a + b) / 2 - guess) < Math.abs((best[0] + best[1]) / 2 - guess)) best = [a, b];
  }
  return best === null ? null : bisect(f, best[0], best[1]);
}

/** A rate where `f` is zero, or null when none is found. */
export function solveRate(f: (r: number) => number, guess: number, df?: (r: number) => number): number | null {
  if (!Number.isFinite(guess) || guess <= -1) return null;
  return newton(f, guess, df) ?? bracketed(f, guess);
}
