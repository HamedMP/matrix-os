import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { herdrSessionRefKey, type HerdrSession, type HerdrSessionsRequest } from "@matrix-os/ui/herdr-sessions";

import type { ApiClient } from "../../lib/api";
import type { ShellSessionSummary } from "../../stores/shell-sessions";

/** A Herdr session as a Terminal session row, so it opens through the same view as every Matrix tab. */
export function herdrDesktopSession(session: HerdrSession): ShellSessionSummary {
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

export function herdrSessionsRequest(api: ApiClient): HerdrSessionsRequest {
  return (path, init) => (init.method === "GET"
    ? api.getText(path, { signal: init.signal }).then((text) => new Response(text))
    : api.delete(path, {}, { signal: init.signal }).then(() => new Response("{}")));
}
