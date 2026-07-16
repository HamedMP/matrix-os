import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";

export interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  webglAddon: unknown | null;
  searchAddon: unknown | null;
  ws: WebSocket;
  lastSeq: number;
  sessionId: string;
  socketRetained?: boolean;
}

interface CacheTerminalOptions {
  retainSocket?: boolean;
}

const MAX_CACHED = 20;
const cache = new Map<string, CachedTerminal>();

function terminalCacheDebug(event: string, details: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  console.info("[terminal-debug][cache]", event, details);
}

function detachAndCloseSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "detach" }));
    } catch (e: unknown) {
      console.warn("Cache detach:", e instanceof Error ? e.message : e);
    }
  }
  if (ws.readyState !== WebSocket.CLOSED) {
    try {
      ws.close();
    } catch (e: unknown) {
      console.warn("Cache ws.close:", e instanceof Error ? e.message : e);
    }
  }
}

function disposeCachedTerminal(entry: CachedTerminal): void {
  detachAndCloseSocket(entry.ws);
  try {
    entry.terminal.dispose();
  } catch (e: unknown) {
    console.warn("Cache terminal dispose:", e instanceof Error ? e.message : e);
  }
}

export function cacheTerminal(paneId: string, entry: CachedTerminal, options: CacheTerminalOptions = {}): void {
  terminalCacheDebug("cache-put", {
    paneId,
    sessionId: entry.sessionId,
    lastSeq: entry.lastSeq,
    cacheSizeBefore: cache.size,
    retainSocket: options.retainSocket !== false,
  });
  const existing = cache.get(paneId);
  cache.delete(paneId);
  if (existing && existing !== entry) {
    disposeCachedTerminal(existing);
  }
  if (options.retainSocket === false) {
    detachAndCloseSocket(entry.ws);
  }
  entry.socketRetained = options.retainSocket !== false;
  while (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value!;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    if (evicted) {
      terminalCacheDebug("cache-evict", {
        paneId: oldest,
        sessionId: evicted.sessionId,
      });
      disposeCachedTerminal(evicted);
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
