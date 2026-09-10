const LEGACY_PTY_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Existing server-created sessions (including provider login sessions) may be
// 64 characters. The 31-character limit only applies to user-created names.
// Keep opaque underscore IDs out of this public named-session discriminator.
const CANONICAL_SHELL_SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isLegacyPtySessionId(sessionId: string): boolean {
  return LEGACY_PTY_SESSION_ID_PATTERN.test(sessionId);
}

export function isCanonicalShellSessionId(sessionId: string): boolean {
  // UUID PTY IDs also fit the longer name pattern, but must keep their legacy
  // attach transport rather than being looked up as named shell sessions.
  return !isLegacyPtySessionId(sessionId) && CANONICAL_SHELL_SESSION_NAME_PATTERN.test(sessionId);
}

export function terminalWebSocketPathForSession(sessionId: string | null): "/ws/terminal" | "/ws/terminal/session" {
  return sessionId && isCanonicalShellSessionId(sessionId) ? "/ws/terminal/session" : "/ws/terminal";
}
