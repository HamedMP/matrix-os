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

  const hasTerminalElement = Boolean((cached.terminal as { element?: HTMLElement }).element);
  const reuseSocket = cached.ws.readyState === WebSocket.OPEN || cached.ws.readyState === WebSocket.CONNECTING;
  const socketWasIntentionallyDetached = cached.socketRetained === false;
  const reuseTerminal = hasTerminalElement && (reuseSocket || socketWasIntentionallyDetached);

  return {
    cached,
    reuseTerminal,
    reuseSocket,
    sessionId: cached.sessionId || null,
    lastSeq: reuseTerminal ? cached.lastSeq : 0,
  };
}

export function closeStaleCachedSocket(cached: CachedTerminal | null): void {
  if (!cached || cached.ws.readyState === WebSocket.CLOSED) {
    return;
  }

  cached.ws.close();
}

export function discardStaleCachedTerminal(cached: CachedTerminal | null): void {
  if (!cached) {
    return;
  }

  closeStaleCachedSocket(cached);
  try {
    cached.terminal.dispose();
  } catch (err: unknown) {
    console.warn("Stale terminal dispose:", err instanceof Error ? err.message : err);
  }
}
