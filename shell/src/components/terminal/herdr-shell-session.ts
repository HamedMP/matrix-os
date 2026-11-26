import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { DESKTOP_LINK_WORKSPACE_PREFIX, desktopLinkWorkspaceId } from "@matrix-os/contracts/desktop-link";
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

/** A terminal on a linked desktop (spec 2716) as a sidebar row, opened through the same path as every Matrix tab. */
export function desktopShellSession(deviceId: string, session: Pick<HerdrSession, "tabId" | "title">): ShellSessionSummary {
  const workspaceId = desktopLinkWorkspaceId(deviceId);
  return {
    name: `${workspaceId}:${session.tabId}`,
    workspaceId,
    tabId: session.tabId,
    revision: 0,
    workspaceRevision: 0,
    subtitle: session.title,
    status: "active",
    placement: "active",
  };
}

/** Whether a terminal ref key names a terminal on a linked desktop. */
export function isDesktopRefKey(sessionId: string): boolean {
  return sessionId.startsWith(DESKTOP_LINK_WORKSPACE_PREFIX);
}

/**
 * Whether a terminal ref key names a terminal held by a herdr-core rather than
 * a Matrix workspace: the owner's Herdr, or a linked desktop's. Neither is ever
 * listed under Matrix workspaces, and Matrix cannot recreate either.
 */
export function isHerdrRefKey(sessionId: string): boolean {
  return sessionId.startsWith(`${HERDR_TERMINAL_WORKSPACE_ID}:`) || isDesktopRefKey(sessionId);
}

/**
 * Saved Herdr refs whose terminal has ended, judged against the Herdr list. When
 * the list cannot be read, none are reported: the pane's own connection state
 * shows an unreachable core, and a Herdr terminal cannot be recreated anyway.
 */
export async function findEndedHerdrRefs(sessionIds: readonly string[]): Promise<string[]> {
  // Only the owner's own Herdr: a desktop's terminals are not in that list, and an
  // offline desktop says nothing about whether its terminal still runs.
  const herdrIds = sessionIds.filter((id) => id.startsWith(`${HERDR_TERMINAL_WORKSPACE_ID}:`));
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
