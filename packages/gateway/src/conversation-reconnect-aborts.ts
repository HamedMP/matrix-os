export interface ReconnectableAbortEntry {
  controller: { abort: () => void };
  sessionId?: string;
  abortTimer: ReturnType<typeof setTimeout> | null;
}

interface ScheduleReconnectAbortOptions {
  graceMs: number;
  hasActiveSessionConnection: (sessionId: string) => boolean;
}

function scheduleReconnectAbortTimer(
  entries: Map<string, ReconnectableAbortEntry>,
  requestId: string,
  entry: ReconnectableAbortEntry,
  graceMs: number,
): void {
  entry.abortTimer = setTimeout(() => {
    entry.controller.abort();
    entries.delete(requestId);
  }, graceMs);
}

export function replaceReconnectableAbortEntry(
  entries: Map<string, ReconnectableAbortEntry>,
  requestId: string,
  entry: ReconnectableAbortEntry,
): void {
  const existing = entries.get(requestId);
  if (existing?.abortTimer) {
    clearTimeout(existing.abortTimer);
    existing.abortTimer = null;
  }
  entries.set(requestId, entry);
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
  options: ScheduleReconnectAbortOptions,
): void {
  if (!sessionId) return;
  if (options.hasActiveSessionConnection(sessionId)) return;

  for (const [requestId, entry] of entries) {
    if (entry.sessionId !== sessionId || entry.abortTimer) {
      continue;
    }

    scheduleReconnectAbortTimer(entries, requestId, entry, options.graceMs);
  }
}

export function scheduleReconnectAbortTimersForDisconnectedClient(
  entries: Map<string, ReconnectableAbortEntry>,
  options: ScheduleReconnectAbortOptions,
): void {
  for (const [requestId, entry] of entries) {
    if (entry.abortTimer) {
      continue;
    }
    if (
      entry.sessionId
      && options.hasActiveSessionConnection(entry.sessionId)
    ) {
      continue;
    }

    scheduleReconnectAbortTimer(entries, requestId, entry, options.graceMs);
  }
}
