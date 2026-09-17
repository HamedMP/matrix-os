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

export const SyncDirectionSchema = z.enum(["two_way", "to_matrix", "to_local"]);
export type SyncDirection = z.infer<typeof SyncDirectionSchema>;

export const SyncRemotePrefixSchema = z.string()
  .max(1024)
  .refine((value) => {
    if (value === "") return true;
    if (
      value.startsWith("/")
      || value.endsWith("/")
      || value.includes("//")
      || value.includes("\\")
      || value.includes("\0")
    ) {
      return false;
    }
    return value.split("/").every((segment) => segment !== "." && segment !== "..");
  }, "Remote prefix must be a normalized home-relative path");

export const SyncMappingSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1).max(120),
  localRoot: z.string().min(1).max(4096),
  remotePrefix: SyncRemotePrefixSchema,
  direction: SyncDirectionSchema,
  enabled: z.boolean(),
  propagateDeletes: z.boolean(),
  excludes: z.array(z.string().min(1).max(1024)).max(256),
}).strict();
export type SyncMapping = z.infer<typeof SyncMappingSchema>;

export const SyncMappingConfigSchema = z.object({
  schemaVersion: z.literal(2),
  revision: z.int().nonnegative(),
  profile: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,30}$/),
  ownerId: SyncOwnerIdSchema,
  runtimeSlot: SyncRuntimeSlotSchema,
  deviceId: z.string().min(1).max(128),
  enabled: z.boolean(),
  mappings: z.array(SyncMappingSchema).max(32),
}).strict().superRefine((config, ctx) => {
  const mappingIds = new Set<string>();
  for (let index = 0; index < config.mappings.length; index++) {
    const id = config.mappings[index]!.id;
    if (mappingIds.has(id)) {
      ctx.addIssue({
        code: "custom",
        message: "Mapping ids must be unique",
        path: ["mappings", index, "id"],
      });
    }
    mappingIds.add(id);
  }
});
export type SyncMappingConfig = z.infer<typeof SyncMappingConfigSchema>;

export function buildSyncStoragePrefix(scope: SyncScope): string {
  const parsed = SyncScopeSchema.parse(scope);
  return parsed.runtimeSlot === "primary"
    ? `matrixos-sync/${parsed.ownerId}`
    : `matrixos-sync/v2/owners/${parsed.ownerId}/runtimes/${parsed.runtimeSlot}`;
}
