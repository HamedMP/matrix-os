import { createBrowserApprovalControl } from "../chat/browser-approval-control.js";
import { createOwnedBrowserApprovalAuthority } from "../chat/browser-approval-owned-runtime.js";
import { createBrowserApprovalPlatformClient } from "../chat/browser-approval-platform-client.js";

/** Separate feature composition: no signing key or machine token enters a harness. */
export function createSupervisedBrowserRuntime(options: { env: NodeJS.ProcessEnv; ownerId?: string; clerkOwnerId?: string }) {
  const env = options.env;
  if (env.MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED !== "true") return undefined;
  if (!options.ownerId || options.ownerId !== options.clerkOwnerId || !env.DATABASE_URL || !env.PLATFORM_INTERNAL_URL
    || !env.UPGRADE_TOKEN || !env.MATRIX_HANDLE || !env.MATRIX_RUNTIME_SLOT) {
    console.warn("[browser-approval] Required runtime authority unavailable"); return undefined;
  }
  const platform = createBrowserApprovalPlatformClient({ platformUrl: env.PLATFORM_INTERNAL_URL, handle: env.MATRIX_HANDLE, token: env.UPGRADE_TOKEN });
  const owned = createOwnedBrowserApprovalAuthority({ databaseUrl: env.DATABASE_URL, ...platform });
  const control = createBrowserApprovalControl({ ownerId: options.ownerId, handle: env.MATRIX_HANDLE,
    runtimeSlot: env.MATRIX_RUNTIME_SLOT, authority: owned.repository });
  owned.repository.startMaintenance();
  return { control, async close() { try { await control.close(); } finally { await owned.close(); } } };
}
