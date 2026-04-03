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

export function cacheTerminal(paneId: string, entry: CachedTerminal): void {
  cache.delete(paneId);
  cache.set(paneId, entry);

  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value!;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    if (evicted) {
      try { evicted.ws.send(JSON.stringify({ type: "detach" })); } catch (e: unknown) { console.warn("Cache eviction detach:", e instanceof Error ? e.message : e); }
      try { evicted.ws.close(); } catch (e: unknown) { console.warn("Cache eviction ws.close:", e instanceof Error ? e.message : e); }
      try { evicted.terminal.dispose(); } catch (e: unknown) { console.warn("Cache eviction dispose:", e instanceof Error ? e.message : e); }
    }
  }
}

export function getCached(paneId: string): CachedTerminal | null {
  const entry = cache.get(paneId);
  if (entry) {
    cache.delete(paneId);
    cache.set(paneId, entry);
  }
  return entry ?? null;
}

export function removeCached(paneId: string): void {
  cache.delete(paneId);
}

export function hasCached(paneId: string): boolean {
  return cache.has(paneId);
}
