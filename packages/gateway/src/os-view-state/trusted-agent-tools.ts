import type { ServerMessage } from "../server/types.js";
import { createOsViewAgentTools, type OsViewAgentRepository, type OsViewAgentTools } from "./agent-tools.js";
import type { AppEntry } from "../apps.js";

const MAX_TRUSTED_OWNER_ID_LENGTH = 160;

/**
 * OS-view agent tools bound to the gateway's trusted owner (from the runtime
 * environment, never from a request). Without a repository or a usable owner
 * ID the agent gets no OS-view tools.
 */
export function createTrustedOsViewAgentTools(deps: {
  repository: OsViewAgentRepository | null;
  ownerId: string | undefined;
  homePath: string;
  broadcastToOwner: (ownerId: string, message: ServerMessage) => void;
  listCatalog?: () => Promise<AppEntry[]>;
}): OsViewAgentTools | undefined {
  const ownerId = deps.ownerId?.trim();
  if (!deps.repository || !ownerId || ownerId.length > MAX_TRUSTED_OWNER_ID_LENGTH) return undefined;
  return createOsViewAgentTools({
    repository: deps.repository,
    ownerId,
    homePath: deps.homePath,
    ...(deps.listCatalog ? { listCatalog: deps.listCatalog } : {}),
    onChanged: (state) => deps.broadcastToOwner(ownerId, {
      type: "os-view:changed",
      revision: state.revision,
      updatedAt: state.updatedAt,
    }),
  });
}
