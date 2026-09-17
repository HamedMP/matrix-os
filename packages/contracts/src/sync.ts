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

export const SyncDeviceNameSchema = z.string().trim().min(1).max(120);
export const SyncDeviceRefreshTokenSchema = z.string()
  .max(256)
  .regex(/^sdr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);

export const SyncDeviceEnrollmentRequestSchema = z.object({
  deviceName: SyncDeviceNameSchema,
}).strict();

export const SyncDeviceRefreshRequestSchema = z.object({
  refreshToken: SyncDeviceRefreshTokenSchema,
}).strict();

export const SyncDeviceCredentialSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  refreshToken: SyncDeviceRefreshTokenSchema,
  expiresAt: z.int().positive(),
  userId: SyncOwnerIdSchema,
  handle: z.string().min(1).max(128),
  runtimeSlot: SyncRuntimeSlotSchema,
}).strict();
export type SyncDeviceCredential = z.infer<typeof SyncDeviceCredentialSchema>;

export const BackupAttemptSchema = z.object({
  attemptedAt: z.int().nonnegative(),
  outcome: z.enum(["running", "success", "failed"]),
  errorCode: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable(),
}).strict();

export const BackupReceiptSchema = z.object({
  snapshotKey: z.string().min(1).max(512),
  receiptKey: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.int().positive(),
  runtimeSlot: SyncRuntimeSlotSchema,
  completedAt: z.int().nonnegative(),
  restoreVerifiedAt: z.int().nonnegative().nullable(),
}).strict();

export const BackupStatusSchema = z.object({
  schemaVersion: z.literal(1),
  scheduler: z.object({
    enabled: z.boolean().nullable(),
    active: z.boolean().nullable(),
    nextDueAt: z.int().nonnegative().nullable(),
  }).strict(),
  lastAttempt: BackupAttemptSchema.nullable(),
  lastSuccess: BackupReceiptSchema.nullable(),
  storageReachability: z.enum(["reachable", "unreachable", "unknown"]),
  freshness: z.enum(["healthy", "stale", "critical", "unknown"]),
  observedAt: z.int().nonnegative(),
}).strict();
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export const SyncRemoteStatusResponseSchema = z.object({
  connectedPeers: z.array(z.object({
    peerId: z.string().min(1).max(128),
    hostname: z.string().min(1).max(255),
    platform: z.string().min(1).max(64),
    connectedAt: z.int().nonnegative(),
  }).strict()).max(128),
  manifestVersion: z.int().nonnegative(),
  fileCount: z.int().nonnegative(),
  totalSize: z.number().nonnegative(),
  lastSyncAt: z.int().nonnegative(),
  pendingConflicts: z.int().nonnegative(),
  protocolVersion: z.int().positive(),
  capabilities: z.object({
    stagedUploads: z.boolean(),
    immutableBlobs: z.boolean(),
    immutableManifestGenerations: z.boolean(),
  }).strict(),
}).strict();
export type SyncRemoteStatusResponse = z.infer<typeof SyncRemoteStatusResponseSchema>;

export const DesktopRemoteSyncStatusSchema = z.object({
  manifestVersion: z.int().nonnegative(),
  fileCount: z.int().nonnegative(),
  totalSize: z.number().nonnegative(),
  lastSyncAt: z.int().nonnegative().nullable(),
  pendingConflicts: z.int().nonnegative(),
  connectedPeerCount: z.int().nonnegative(),
}).strict();
export type DesktopRemoteSyncStatus = z.infer<typeof DesktopRemoteSyncStatusSchema>;

export const SyncMappingIssueSchema = z.enum([
  "permission",
  "disk_full",
  "oversized",
  "network",
  "unknown",
]);
export type SyncMappingIssue = z.infer<typeof SyncMappingIssueSchema>;

export const DesktopSyncMappingStatusSchema = SyncMappingSchema.extend({
  state: z.enum(["paused", "idle", "syncing", "conflict", "error", "offline"]),
  fileCount: z.int().nonnegative(),
  conflictCount: z.int().nonnegative(),
  lastSuccessfulReconcileAt: z.int().nonnegative().nullable(),
  lastIssue: SyncMappingIssueSchema.nullable().optional(),
}).strict();
export type DesktopSyncMappingStatus = z.infer<typeof DesktopSyncMappingStatusSchema>;

export const DesktopSyncSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capability: z.enum([
    "available",
    "unsupported_platform",
    "helper_missing",
    "helper_invalid",
    "helper_incompatible",
  ]),
  helperVersion: z.string().max(64).nullable(),
  service: z.enum(["not_configured", "stopped", "running"]),
  profile: z.string().max(31).nullable(),
  runtimeSlot: SyncRuntimeSlotSchema.nullable(),
  enabled: z.boolean(),
  paused: z.boolean(),
  auth: z.enum(["ready", "needs_sign_in", "signed_out", "unknown"]),
  connection: z.enum(["connecting", "online", "offline", "unknown"]),
  status: z.enum([
    "not_configured",
    "paused",
    "offline",
    "syncing",
    "synced",
    "conflict",
    "error",
    "unavailable",
  ]),
  activeTransferCount: z.int().nonnegative(),
  conflictCount: z.int().nonnegative(),
  lastSyncAt: z.int().nonnegative().nullable(),
  mappings: z.array(DesktopSyncMappingStatusSchema).max(32),
  backup: BackupStatusSchema.nullable(),
  backupState: z.enum(["available", "unavailable", "offline", "unknown"]),
  remoteStatus: DesktopRemoteSyncStatusSchema.nullable().optional(),
}).strict();
export type DesktopSyncSnapshot = z.infer<typeof DesktopSyncSnapshotSchema>;

export const DesktopSyncFolderSelectionSchema = z.object({
  selectionId: z.uuid(),
  displayPath: z.string().min(1).max(4096),
}).strict();

export const DesktopSyncMappingSetupRequestSchema = z.object({
  selectionId: z.uuid(),
  label: z.string().trim().min(1).max(120).optional(),
  remotePrefix: SyncRemotePrefixSchema,
  direction: SyncDirectionSchema,
  propagateDeletes: z.boolean().default(false),
  excludes: z.array(z.string().min(1).max(1024)).max(256).default([]),
  parentMappingId: z.uuid().optional(),
}).strict();

export const DesktopSyncMappingMutationRequestSchema = z.object({
  mappingId: z.uuid(),
}).strict();

export function deriveBackupFreshness(
  completedAt: number | null,
  now: number,
): BackupStatus["freshness"] {
  if (completedAt === null || completedAt > now) return "unknown";
  const age = now - completedAt;
  if (age <= 2 * 60 * 60 * 1000) return "healthy";
  if (age <= 24 * 60 * 60 * 1000) return "stale";
  return "critical";
}

export function buildSyncStoragePrefix(scope: SyncScope): string {
  const parsed = SyncScopeSchema.parse(scope);
  return parsed.runtimeSlot === "primary"
    ? `matrixos-sync/${parsed.ownerId}`
    : `matrixos-sync/v2/owners/${parsed.ownerId}/runtimes/${parsed.runtimeSlot}`;
}
