import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { herdrSessionRefKey, type HerdrSession } from "@matrix-os/ui/herdr-sessions";
import type { ShellSessionSummary } from "./terminal-session-state";

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
