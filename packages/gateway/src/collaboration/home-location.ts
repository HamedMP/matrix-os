import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** Resolves the location a configured home really is, following any link in its spelling. */
export type HomeLocationResolver = (homePath: string) => Promise<string>;

export interface HomeLocationCacheLimits {
  /** How long a resolved location is reused before it is resolved again. */
  ttlMs: number;
  /** A gateway serves one home; the cap only bounds misuse. */
  maxHomes: number;
  now: () => number;
}

const DEFAULT_LIMITS: HomeLocationCacheLimits = { ttlMs: 30_000, maxHomes: 8, now: Date.now };

/**
 * Resolves a home's real location with an async `realpath`, reusing each
 * answer for `ttlMs` so the write fence does not touch disk on every write.
 * Concurrent callers share one lookup. A failed lookup is not cached, so the
 * caller refuses and the next request tries again. The cache holds at most
 * `maxHomes` entries and drops the oldest first.
 */
export function createHomeLocationResolver(overrides: Partial<HomeLocationCacheLimits> = {}): HomeLocationResolver {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const cache = new Map<string, { location: Promise<string>; expiresAt: number }>();
  return (homePath) => {
    const key = resolve(homePath);
    const now = limits.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.location;
    cache.delete(key);
    while (cache.size >= limits.maxHomes) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    const entry = {
      expiresAt: now + limits.ttlMs,
      location: realpath(key).then(
        (location) => location,
        (error: unknown) => {
          if (cache.get(key) === entry) cache.delete(key);
          throw error;
        },
      ),
    };
    cache.set(key, entry);
    return entry.location;
  };
}

/** The gateway's shared resolver. */
export const resolveRealHomeLocation: HomeLocationResolver = createHomeLocationResolver();
