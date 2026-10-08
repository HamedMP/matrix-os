/** Owner-scoped readiness hints only; funded authority and selected admissions bypass this cache. */
export function createCatalogReadinessCache<T>(options: {
  ttlMs: number; now: () => number; usable: (value: T) => boolean;
}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.min(60_000, Math.max(0, Math.trunc(options.ttlMs))) : 0;
  const cached = new Map<string, { value: T; expiresAt: number }>();
  const inFlight = new Map<string, Promise<T>>();
  const capacity = 64;
  function evictOldest(map: Map<string, unknown>) {
    if (map.size < capacity) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  function sweep() {
    const now = options.now();
    for (const [ownerId, entry] of cached) if (entry.expiresAt <= now) cached.delete(ownerId);
  }
  function read(ownerId: string, load: () => Promise<T>): Promise<T> {
    if (ttlMs === 0) return load();
    const pending = load().then(value => {
      // Replaced/evicted reads may finish, but cannot restore stale readiness.
      if (inFlight.get(ownerId) !== pending) return value;
      cached.delete(ownerId);
      sweep();
      evictOldest(cached);
      cached.set(ownerId, { value, expiresAt: options.now() + (options.usable(value) ? ttlMs : Math.min(ttlMs, 2_000)) });
      return value;
    }).finally(() => { if (inFlight.get(ownerId) === pending) inFlight.delete(ownerId); });
    evictOldest(inFlight);
    inFlight.set(ownerId, pending);
    return pending;
  }
  return {
    get(ownerId: string, load: () => Promise<T>) {
      if (ttlMs === 0) return read(ownerId, load);
      sweep();
      const entry = cached.get(ownerId);
      return entry ? Promise.resolve(entry.value) : inFlight.get(ownerId) ?? read(ownerId, load);
    },
    refresh(ownerId: string, load: () => Promise<T>) { cached.delete(ownerId); inFlight.delete(ownerId); return read(ownerId, load); },
  };
}
