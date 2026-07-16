// In-memory scrollback cache so the terminal can paint its previous on-screen
// buffer instantly when the tab (and its WebView) remounts, instead of showing
// a blank surface until the gateway replays.
//
// Dedup story: the gateway sends a full authoritative `replay` on `attached`,
// and terminal.tsx clears the surface before writing it. So the cached preview
// is always superseded on attach and can never duplicate replayed output. We do
// not use the WS `fromSeq` incremental path here because the RN protocol carries
// no per-chunk sequence numbers to resume from; the clear-then-replay handshake
// is simpler and dedup-safe. The cache is purely a visual bridge across the
// reconnect gap.
//
// Both bounds are required by the repo rules: every in-memory Map needs a size
// cap and eviction policy, and every cached buffer needs a byte cap.

/** Max sessions retained; least-recently-used is evicted past this. */
export const MAX_SCROLLBACK_SESSIONS = 8;
/** Max characters kept per session (tail retained, older output dropped). */
export const MAX_SCROLLBACK_CHARS = 256 * 1024;

// Insertion order doubles as recency: the first key is the least-recently-used.
const cache = new Map<string, string>();

function tail(value: string): string {
  return value.length > MAX_SCROLLBACK_CHARS
    ? value.slice(value.length - MAX_SCROLLBACK_CHARS)
    : value;
}

function store(sessionId: string, value: string): void {
  // Re-insert to move this session to the most-recently-used end.
  cache.delete(sessionId);
  cache.set(sessionId, value);
  while (cache.size > MAX_SCROLLBACK_SESSIONS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Append a raw output chunk to a session's cached buffer. */
export function appendScrollback(sessionId: string, chunk: string): void {
  if (!sessionId || !chunk) return;
  store(sessionId, tail((cache.get(sessionId) ?? "") + chunk));
}

/** Replace a session's cached buffer (used for the authoritative attach replay). */
export function resetScrollback(sessionId: string, value: string): void {
  if (!sessionId) return;
  store(sessionId, tail(value));
}

/** Read a session's cached buffer, marking it most-recently-used. */
export function getScrollback(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const value = cache.get(sessionId);
  if (value === undefined) return undefined;
  store(sessionId, value);
  return value;
}

/** Drop one session's cached buffer (on delete/exit). */
export function clearScrollback(sessionId: string): void {
  if (!sessionId) return;
  cache.delete(sessionId);
}

/** Drop every cached buffer (on sign-out). */
export function clearAllScrollback(): void {
  cache.clear();
}
