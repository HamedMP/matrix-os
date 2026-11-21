import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { herdrSessionRefKey, type HerdrSession, type HerdrSessionsRequest } from "@matrix-os/ui/herdr-sessions";

import type { ApiClient } from "../../lib/api";
import type { ShellSessionSummary } from "../../stores/shell-sessions";

/** A Herdr session as a Terminal session row, so it opens through the same view as every Matrix tab. */
export function herdrDesktopSession(session: Pick<HerdrSession, "tabId" | "title">): ShellSessionSummary {
  return {
    name: herdrSessionRefKey(session),
    workspaceId: HERDR_TERMINAL_WORKSPACE_ID,
    tabId: session.tabId,
    revision: 0,
    workspaceRevision: 0,
    cwd: "~",
    subtitle: session.title,
    status: "active",
    placement: "active",
  };
}

/**
 * A Herdr session named only by its terminal ref, as an attention alert's Open
 * asks for it. Its row in the Herdr group supplies the real title.
 */
export function herdrDesktopSessionFromRefKey(refKey: string | null): ShellSessionSummary | null {
  if (!refKey) return null;
  const [workspaceId, tabId, ...rest] = refKey.split(":");
  if (rest.length > 0 || workspaceId !== HERDR_TERMINAL_WORKSPACE_ID || !tabId || !/^tt_[0-9a-f]{32}$/.test(tabId)) return null;
  return herdrDesktopSession({ tabId, title: "Herdr session" });
}

export function herdrSessionsRequest(api: ApiClient): HerdrSessionsRequest {
  return (path, init) => (init.method === "GET"
    ? api.getText(path, { signal: init.signal }).then((text) => new Response(text))
    : api.delete(path, {}, { signal: init.signal }).then(() => new Response("{}")));
}
