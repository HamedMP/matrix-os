const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_USERS = 10_000;

export interface SyncRateLimiterConfig {
  maxRequests?: number;
  windowMs?: number;
  maxUsers?: number;
}

export interface SyncRateLimiter {
  check(userId: string): boolean;
}

export function createSyncRateLimiter(
  config?: SyncRateLimiterConfig,
): SyncRateLimiter {
  const maxRequests = config?.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const maxUsers = config?.maxUsers ?? DEFAULT_MAX_USERS;

  const userTimestamps = new Map<string, number[]>();

  return {
    check(userId: string): boolean {
      const now = Date.now();
      const cutoff = now - windowMs;

      let timestamps = userTimestamps.get(userId);
      if (timestamps) {
        // Sliding window: remove expired timestamps
        timestamps = timestamps.filter((t) => t > cutoff);
      } else {
        timestamps = [];
      }

      if (timestamps.length >= maxRequests) {
        userTimestamps.set(userId, timestamps);
        return false;
      }

      timestamps.push(now);
      userTimestamps.set(userId, timestamps);

      // Evict oldest user if map exceeds cap
      if (userTimestamps.size > maxUsers) {
        const oldestKey = userTimestamps.keys().next().value;
        if (oldestKey !== undefined && oldestKey !== userId) {
          userTimestamps.delete(oldestKey);
        }
      }

      return true;
    },
  };
}
