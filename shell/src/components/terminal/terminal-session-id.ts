const LEGACY_PTY_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_SHELL_SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function isLegacyPtySessionId(sessionId: string): boolean {
  return LEGACY_PTY_SESSION_ID_PATTERN.test(sessionId);
}

export function isCanonicalShellSessionId(sessionId: string): boolean {
  return CANONICAL_SHELL_SESSION_NAME_PATTERN.test(sessionId);
}

export function terminalWebSocketPathForSession(sessionId: string | null): "/ws/terminal" | "/ws/terminal/session" {
  return sessionId && isCanonicalShellSessionId(sessionId) ? "/ws/terminal/session" : "/ws/terminal";
}
