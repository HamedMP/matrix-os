/** Startup and credential preparation are bounded independently from a busy turn. */
export const CODING_PREPARATION_TIMEOUT_MS = 30_000;

/** A trusted caller may explicitly timebox a run; owner runs have no implicit timebox. */
export function explicitCodingRunTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new RangeError("Invalid coding run timeout");
  return Math.max(1, Math.min(Math.floor(value), 10 * 60_000));
}

/** The credential limit is supplied only by an admitted funded launch. */
export function remainingCodingRunTimeout(deadline: number | undefined, credentialLimit?: number): number | undefined {
  const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
  if (credentialLimit === undefined) return remaining;
  return Math.max(1, Math.min(credentialLimit, remaining ?? credentialLimit));
}

/** Keep cancellation ownership and an optional explicit deadline out of large stores. */
export function createCodingRunLifetime(parent: AbortSignal, timeoutMs?: number) {
  const deadline = new AbortController();
  const reason = new DOMException("Coding run deadline", "TimeoutError");
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => deadline.abort(reason), timeoutMs);
  timer?.unref?.();
  const signal = timer === undefined ? parent : AbortSignal.any([parent, deadline.signal]);
  return { signal, timedOut: () => signal.aborted && signal.reason === reason,
    dispose: () => { if (timer) clearTimeout(timer); } };
}
