export interface ReconnectableAbortEntry {
  controller: { abort: () => void };
  sessionId?: string;
  abortTimer: ReturnType<typeof setTimeout> | null;
}

export function clearReconnectAbortTimersForSession(
  entries: Map<string, ReconnectableAbortEntry>,
  sessionId: string | undefined,
): void {
  if (!sessionId) return;
  for (const entry of entries.values()) {
    if (entry.sessionId === sessionId && entry.abortTimer) {
      clearTimeout(entry.abortTimer);
      entry.abortTimer = null;
    }
  }
}

export function scheduleReconnectAbortTimersForSession(
  entries: Map<string, ReconnectableAbortEntry>,
  sessionId: string | undefined,
  options: {
    graceMs: number;
    hasActiveSessionConnection: (sessionId: string) => boolean;
  },
): void {
  if (!sessionId) return;
  if (options.hasActiveSessionConnection(sessionId)) return;

  for (const [requestId, entry] of entries) {
    if (entry.sessionId !== sessionId || entry.abortTimer) {
      continue;
    }

    entry.abortTimer = setTimeout(() => {
      entry.controller.abort();
      entries.delete(requestId);
    }, options.graceMs);
  }
}
