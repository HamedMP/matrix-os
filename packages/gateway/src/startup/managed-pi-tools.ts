/** Production composition only: no user-supplied URL/owner, and no Preview policy override. */
import { resolveCustomMcpRuntimeRouting } from "../integrations/custom-mcp/preview-routing.js";
import { createManagedPiMcpClient } from "../chat/managed-pi-mcp-client.js";
import { createCustomMcpApprovalClient } from "../chat/custom-mcp-approval-client.js";
export function managedPiMcpDependencies(options: {
  env?: NodeJS.ProcessEnv; platformUrl?: string; token?: string; handle?: string; clerkOwnerId?: string; ownerId?: string;
}) {
  const ownerId = options.ownerId ?? options.clerkOwnerId;
  if (!options.platformUrl || !options.token || !options.handle || !ownerId || ownerId !== options.clerkOwnerId) return undefined;
  const routing = resolveCustomMcpRuntimeRouting(options.env ?? {}, { internalPlatformUrl: options.platformUrl,
    internalPlatformToken: options.token, clerkUserId: options.clerkOwnerId, projectionToken: undefined });
  return {
    client: createManagedPiMcpClient({ platformUrl: routing.internalPlatformUrl!, token: routing.internalPlatformToken!, handle: options.handle, ownerId }),
    approvals: createCustomMcpApprovalClient({ platformUrl: routing.internalPlatformUrl!, token: routing.internalPlatformToken!, handle: options.handle }),
  };
}
