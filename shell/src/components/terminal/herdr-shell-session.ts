import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { herdrSessionRefKey, loadHerdrSessions, type HerdrSession, type HerdrSessionsRequest } from "@matrix-os/ui/herdr-sessions";
import { getGatewayUrl } from "@/lib/gateway";
import type { ShellSessionSummary } from "./terminal-session-state";

/** The gateway transport for `/api/terminal/herdr`, bounded like every shell request. */
export const shellHerdrRequest: HerdrSessionsRequest = (path, init) => fetch(`${getGatewayUrl()}${path}`, {
  ...init,
  signal: init.signal ?? AbortSignal.timeout(10_000),
});

/** A Herdr session as a sidebar row, so it opens through the same path as every Matrix tab. */
export function herdrShellSession(session: HerdrSession): ShellSessionSummary {
  return {
    name: herdrSessionRefKey(session),
    workspaceId: HERDR_TERMINAL_WORKSPACE_ID,
    tabId: session.tabId,
    revision: 0,
    workspaceRevision: 0,
    subtitle: session.title,
    status: "active",
    placement: "active",
  };
}

/** Whether a terminal ref key names a Herdr terminal (never listed under Matrix workspaces). */
export function isHerdrRefKey(sessionId: string): boolean {
  return sessionId.startsWith(`${HERDR_TERMINAL_WORKSPACE_ID}:`);
}

/**
 * Saved Herdr refs whose terminal has ended, judged against the Herdr list. When
 * the list cannot be read, none are reported: the pane's own connection state
 * shows an unreachable core, and a Herdr terminal cannot be recreated anyway.
 */
export async function findEndedHerdrRefs(sessionIds: readonly string[]): Promise<string[]> {
  const herdrIds = sessionIds.filter(isHerdrRefKey);
  if (herdrIds.length === 0) return [];
  try {
    const list = await loadHerdrSessions(shellHerdrRequest);
    if (!list.available) return [];
    const live = new Set(list.sessions.map(herdrSessionRefKey));
    return herdrIds.filter((id) => !live.has(id));
  } catch (error: unknown) {
    console.warn("[herdr-sessions] restore check failed", error instanceof Error ? error.name : "unknown_error");
    return [];
  }
}
