import { isCanonicalShellSessionId } from "@/components/terminal/terminal-session-id";

/**
 * Ask the current OS view to show an existing terminal tab in its durable
 * Terminal window. Unlike provider setup handoffs, the window that shows it
 * never owns the tab: closing that window leaves the program running.
 */
export const OPEN_TERMINAL_SESSION_EVENT = "matrix:open-terminal-session";

export function openTerminalSession(sessionId: string): void {
  if (!isCanonicalShellSessionId(sessionId)) return;
  window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_SESSION_EVENT, { detail: { sessionId } }));
}

export function terminalSessionFromOpenEvent(event: Event): string | null {
  if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== "object") return null;
  const sessionId = (event.detail as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && isCanonicalShellSessionId(sessionId) ? sessionId : null;
}
