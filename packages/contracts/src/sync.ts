import { z } from "zod/v4";

/**
 * Owner identifiers come from the verified platform principal. Restricting
 * the alphabet here also makes the value safe to use as one segment in an
 * object-store key; callers must never substitute an unverified client value.
 */
export const SyncOwnerIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid sync owner id");

export const SyncRuntimeSlotSchema = z.string()
  .min(1)
  .max(32)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Invalid sync runtime slot",
  );

export const SyncScopeSchema = z.object({
  ownerId: SyncOwnerIdSchema,
  runtimeSlot: SyncRuntimeSlotSchema,
}).strict();

export type SyncScope = z.infer<typeof SyncScopeSchema>;

export function buildSyncStoragePrefix(scope: SyncScope): string {
  const parsed = SyncScopeSchema.parse(scope);
  return parsed.runtimeSlot === "primary"
    ? `matrixos-sync/${parsed.ownerId}`
    : `matrixos-sync/v2/owners/${parsed.ownerId}/runtimes/${parsed.runtimeSlot}`;
}
