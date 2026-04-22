import type { CachedTerminal } from "./terminal-cache";

export interface CachedTerminalRestorePlan {
  cached: CachedTerminal | null;
  reuseTerminal: boolean;
  reuseSocket: boolean;
  sessionId: string | null;
  lastSeq: number;
}

export function getCachedTerminalRestorePlan(cached: CachedTerminal | null): CachedTerminalRestorePlan {
  if (!cached) {
    return {
      cached: null,
      reuseTerminal: false,
      reuseSocket: false,
      sessionId: null,
      lastSeq: 0,
    };
  }

  const reuseSocket = cached.ws.readyState === WebSocket.OPEN || cached.ws.readyState === WebSocket.CONNECTING;

  return {
    cached,
    reuseTerminal: true,
    reuseSocket,
    sessionId: cached.sessionId || null,
    lastSeq: cached.lastSeq,
  };
}
