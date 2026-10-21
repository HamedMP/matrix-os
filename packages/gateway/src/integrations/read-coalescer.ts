/** Share only active reads. Completed results are never cached or reused. */
export function createReadCoalescer(maxEntries = 128, ttlMs = 30_000) {
  const active = new Map<string, { started: number; promise: Promise<unknown> }>();
  return function coalesce<T>(key: string, read: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [id, entry] of active) if (now - entry.started >= ttlMs) active.delete(id);
    const existing = active.get(key);
    if (existing) return existing.promise as Promise<T>;
    if (active.size >= maxEntries) active.delete(active.keys().next().value!);
    const promise = Promise.resolve().then(read).finally(() => {
      if (active.get(key)?.promise === promise) active.delete(key);
    });
    active.set(key, { started: now, promise });
    return promise;
  };
}

export function proxyReadKey(input: { externalUserId: string; accountId: string; url: string; params?: Record<string, string>; headers?: Record<string, string> }): string {
  const sorted = (record?: Record<string, string>) => Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([input.externalUserId, input.accountId, input.url, sorted(input.params), sorted(input.headers)]);
}
