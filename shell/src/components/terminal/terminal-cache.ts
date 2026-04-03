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

const cache = new Map<string, CachedTerminal>();

export function cacheTerminal(paneId: string, entry: CachedTerminal): void {
  cache.set(paneId, entry);
}

export function getCached(paneId: string): CachedTerminal | null {
  return cache.get(paneId) ?? null;
}

export function removeCached(paneId: string): void {
  cache.delete(paneId);
}

export function hasCached(paneId: string): boolean {
  return cache.has(paneId);
}
