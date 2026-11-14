import { parseSupervisedBrowserDevScope } from "@matrix-os/contracts";
import { createBrowserApprovalControl } from "../chat/browser-approval-control.js";
import { createOwnedBrowserApprovalAuthority } from "../chat/browser-approval-owned-runtime.js";
import { createBrowserApprovalPlatformClient } from "../chat/browser-approval-platform-client.js";

/** Separate feature composition: no signing key or machine token enters a harness. */
export function createSupervisedBrowserRuntime(options: { env: NodeJS.ProcessEnv; ownerId?: string; clerkOwnerId?: string }) {
  const env = options.env;
  const global = env.MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED === "true";
  const configured = parseSupervisedBrowserDevScope(env.MATRIX_SUPERVISED_BROWSER_DEV_SCOPE);
  if (configured.kind === "invalid" || (configured.kind === "scoped" && global)) return undefined;
  if (configured.kind === "absent" && !global) return undefined;
  const scope = configured.kind === "scoped" ? configured.scope : undefined;
  if (scope && (scope.ownerId !== options.ownerId || scope.machineId !== env.MATRIX_MACHINE_ID
    || scope.handle !== env.MATRIX_HANDLE || scope.runtimeSlot !== env.MATRIX_RUNTIME_SLOT)) return undefined;
  if (!options.ownerId || options.ownerId !== options.clerkOwnerId || !env.DATABASE_URL || !env.PLATFORM_INTERNAL_URL
    || !env.UPGRADE_TOKEN || !env.MATRIX_HANDLE || !env.MATRIX_RUNTIME_SLOT) {
    console.warn("[browser-approval] Required runtime authority unavailable"); return undefined;
  }
  const platform = createBrowserApprovalPlatformClient({ platformUrl: env.PLATFORM_INTERNAL_URL, handle: env.MATRIX_HANDLE, token: env.UPGRADE_TOKEN });
  const owned = createOwnedBrowserApprovalAuthority({ databaseUrl: env.DATABASE_URL, ...platform });
  const control = createBrowserApprovalControl({ ownerId: options.ownerId, handle: env.MATRIX_HANDLE,
    runtimeSlot: env.MATRIX_RUNTIME_SLOT, authority: owned.repository, scope });
  owned.repository.startMaintenance();
  return { control, supervisedRunExpiresAt: scope
    ? (identity: { ownerId: string; chatId: string }) => identity.ownerId === scope.ownerId && identity.chatId === scope.chatId ? scope.expiresAt : 0
    : undefined, async close() { try { await control.close(); } finally { await owned.close(); } } };
}
