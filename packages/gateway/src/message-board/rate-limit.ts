/**
 * Sliding one-minute write limit per actor. The registry is capped: when full,
 * the least recently active actor is evicted, which can only let that actor
 * write a little sooner, never block anyone.
 */
export interface WriteRateLimiter {
  /** Records a write; false when the actor is over its per-minute budget. */
  take(actorKey: string, nowMs: number): boolean;
  size(): number;
}

const WINDOW_MS = 60_000;

export function createWriteRateLimiter(options: { perMinute: number; maxActors?: number }): WriteRateLimiter {
  const maxActors = options.maxActors ?? 1_024;
  const windows = new Map<string, number[]>();
  return {
    take(actorKey, nowMs) {
      const recent = (windows.get(actorKey) ?? []).filter((at) => nowMs - at < WINDOW_MS);
      // Reinsert so iteration order is least-recently-active first.
      windows.delete(actorKey);
      if (recent.length >= options.perMinute) {
        windows.set(actorKey, recent);
        return false;
      }
      recent.push(nowMs);
      windows.set(actorKey, recent);
      while (windows.size > maxActors) {
        const oldest = windows.keys().next().value;
        if (oldest === undefined) break;
        windows.delete(oldest);
      }
      return true;
    },
    size: () => windows.size,
  };
}
