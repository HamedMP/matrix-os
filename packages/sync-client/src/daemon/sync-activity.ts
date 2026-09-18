/** Process-local activity. Forgotten failures keep a conservative warning until restart. */
export function createSyncActivity() {
  let active = 0;
  let overflow = false;
  const failures = new Set<string>();
  const recent: Array<{ path: string; action: string; peerId: string; timestamp: number }> = [];
  return {
    recent: () => recent.slice(),
    record(path: string, action: string, peerId: string) {
      recent.unshift({ path: path.slice(0, 1024), action, peerId: peerId.slice(0, 128), timestamp: Date.now() });
      recent.length = Math.min(recent.length, 100);
    },
    async run(key: string, task: () => Promise<void>) {
      const end = this.begin();
      try { await task(); this.succeeded(key); }
      catch (err: unknown) { this.failed(key); throw err; }
      finally { end(); }
    },
    activeTransferCount: () => active,
    pendingFailureCount: () => failures.size + Number(overflow),
    begin() {
      active++;
      let ended = false;
      return () => { if (!ended) { ended = true; active--; } };
    },
    failed(key: string) {
      // Refresh insertion order, evict oldest at capacity, and retain evidence
      // of forgotten failures rather than treating eviction as successful work.
      failures.delete(key);
      if (failures.size >= 1000) {
        const oldest = failures.values().next().value;
        if (oldest !== undefined) failures.delete(oldest);
        overflow = true;
      }
      failures.add(key);
    },
    succeeded(key: string) { failures.delete(key); },
  };
}
