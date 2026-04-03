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
      try { evicted.ws.send(JSON.stringify({ type: "detach" })); } catch { /* ws closed */ }
      try { evicted.ws.close(); } catch { /* already closed */ }
      try { evicted.terminal.dispose(); } catch { /* already disposed */ }
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
