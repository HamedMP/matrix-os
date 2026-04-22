import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

export interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  webglAddon: unknown | null;
  searchAddon: unknown | null;
  ws: WebSocket;
  lastSeq: number;
  sessionId: string;
}

const MAX_CACHED = 20;
const cache = new Map<string, CachedTerminal>();

function isTerminalDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.localStorage.getItem("matrix-terminal-debug") === "1") {
      return true;
    }
  } catch (_err: unknown) {
    // Ignore storage access failures.
  }

  try {
    return new URLSearchParams(window.location.search).get("terminalDebug") === "1";
  } catch (_err: unknown) {
    return false;
  }
}

function terminalCacheDebug(event: string, details: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  console.info("[terminal-debug][cache]", event, details);
}

export function cacheTerminal(paneId: string, entry: CachedTerminal): void {
  terminalCacheDebug("cache-put", {
    paneId,
    sessionId: entry.sessionId,
    lastSeq: entry.lastSeq,
    cacheSizeBefore: cache.size,
  });
  cache.delete(paneId);
  while (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value!;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    if (evicted) {
      terminalCacheDebug("cache-evict", {
        paneId: oldest,
        sessionId: evicted.sessionId,
      });
      try { evicted.ws.send(JSON.stringify({ type: "detach" })); } catch (e: unknown) { console.warn("Cache eviction detach:", e instanceof Error ? e.message : e); }
      try { evicted.ws.close(); } catch (e: unknown) { console.warn("Cache eviction ws.close:", e instanceof Error ? e.message : e); }
      try { evicted.terminal.dispose(); } catch (e: unknown) { console.warn("Cache eviction dispose:", e instanceof Error ? e.message : e); }
    }
  }
  cache.set(paneId, entry);
}

export function getCached(paneId: string): CachedTerminal | null {
  const entry = cache.get(paneId);
  terminalCacheDebug("cache-get", {
    paneId,
    hit: !!entry,
    sessionId: entry?.sessionId ?? null,
  });
  if (entry) {
    cache.delete(paneId);
    cache.set(paneId, entry);
  }
  return entry ?? null;
}

export function removeCached(paneId: string): void {
  terminalCacheDebug("cache-remove", { paneId, hadEntry: cache.has(paneId) });
  cache.delete(paneId);
}

export function hasCached(paneId: string): boolean {
  return cache.has(paneId);
}
