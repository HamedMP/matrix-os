import { z } from "zod/v4";
import {
  MESSAGING_IDEMPOTENCY_RETENTION_MS,
  MESSAGING_MEDIA_CAPS,
  MESSAGING_QUEUE_CAPS,
  MESSAGING_RESOURCE_FLOOR,
  MESSAGING_RESTORE_RTO_MS,
  MESSAGING_BACKUP_RPO_MS,
  MESSAGING_SETUP_SESSION_TTL_MS,
  MESSAGING_SETUP_SWEEP_INTERVAL_MS,
  WHATSAPP_RELINK_AFTER_STALE_RESTORE_MS,
} from "./constants.js";

export const MessagingNetworkSlugSchema = z.enum(["telegram", "whatsapp"]);
export type MessagingNetworkSlug = z.infer<typeof MessagingNetworkSlugSchema>;

export const MessagingAccountIdSchema = z.string().trim().regex(/^acct_[A-Za-z0-9_-]{12,96}$/);
export const MessagingSetupIdSchema = z.string().trim().regex(/^setup_[A-Za-z0-9_-]{12,96}$/);
export const MessagingConversationIdSchema = z.string().trim().regex(/^conv_[A-Za-z0-9_-]{12,96}$/);
export const MessagingMappingIdSchema = z.string().trim().regex(/^map_[A-Za-z0-9_-]{12,96}$/);
export const MessagingEventIdSchema = z.string().trim().min(1).max(512);
export const MatrixRoomIdSchema = z.string().trim().regex(/^![A-Za-z0-9_-]+:[A-Za-z0-9.-]+$/);
export const MatrixEventIdSchema = z.string().trim().regex(/^\$[A-Za-z0-9_./=+-]+:[A-Za-z0-9.-]+$/);
export const MatrixUserIdSchema = z.string().trim().regex(/^@[A-Za-z0-9_.=/-]+:[A-Za-z0-9.-]+$/);
export const CursorSchema = z.string().trim().min(1).max(256);
export const ClientTxnIdSchema = z.string().trim().min(1).max(128);

export const MessagingSafeErrorCodeSchema = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "expired",
  "body_too_large",
  "provider_unavailable",
  "misconfigured",
  "internal_error",
]);
export type MessagingSafeErrorCode = z.infer<typeof MessagingSafeErrorCodeSchema>;

export const MessagingNetworkSchema = z.object({
  slug: MessagingNetworkSlugSchema,
  displayName: z.string().trim().min(1).max(80),
  setupKind: z.enum(["qr", "code", "api_credentials"]),
  enabled: z.boolean(),
  requiresExternalCredentials: z.boolean(),
});
export type MessagingNetwork = z.infer<typeof MessagingNetworkSchema>;

export const ConnectedAccountStatusSchema = z.enum([
  "setup_required",
  "connecting",
  "connected",
  "disconnected",
  "error",
]);
export type ConnectedAccountStatus = z.infer<typeof ConnectedAccountStatusSchema>;

export const MessagingAccountSchema = z.object({
  id: MessagingAccountIdSchema,
  ownerId: z.string().trim().min(1).max(256),
  networkSlug: MessagingNetworkSlugSchema,
  externalAccountId: z.string().trim().min(1).max(256).optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
  status: ConnectedAccountStatusSchema,
  statusReason: z.string().trim().min(1).max(240).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MessagingAccount = z.infer<typeof MessagingAccountSchema>;

export const SetupSessionStatusSchema = z.enum(["pending", "complete", "expired", "cancelled"]);
export type SetupSessionStatus = z.infer<typeof SetupSessionStatusSchema>;

export const SetupSessionSchema = z.object({
  id: MessagingSetupIdSchema,
  ownerId: z.string().trim().min(1).max(256),
  networkSlug: MessagingNetworkSlugSchema,
  accountId: MessagingAccountIdSchema.optional(),
  status: SetupSessionStatusSchema,
  setupUrl: z.string().url().optional(),
  qrCode: z.string().trim().min(1).max(8192).optional(),
  pairingCode: z.string().trim().min(1).max(128).optional(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SetupSession = z.infer<typeof SetupSessionSchema>;

export const MatrixConversationSchema = z.object({
  id: MessagingConversationIdSchema,
  ownerId: z.string().trim().min(1).max(256),
  roomId: MatrixRoomIdSchema,
  networkSlug: MessagingNetworkSlugSchema,
  accountId: MessagingAccountIdSchema,
  displayName: z.string().trim().min(1).max(160),
  avatarUrl: z.string().url().optional(),
  lastEventAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MatrixConversation = z.infer<typeof MatrixConversationSchema>;

export const ConversationMappingSchema = z.object({
  id: MessagingMappingIdSchema,
  ownerId: z.string().trim().min(1).max(256),
  networkSlug: MessagingNetworkSlugSchema,
  accountId: MessagingAccountIdSchema,
  roomId: MatrixRoomIdSchema,
  externalThreadId: z.string().trim().min(1).max(256),
  authoritative: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ConversationMapping = z.infer<typeof ConversationMappingSchema>;

export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: CursorSchema.optional(),
});

export const AccountSetupRequestSchema = z.object({
  networkSlug: MessagingNetworkSlugSchema,
});
export type AccountSetupRequest = z.infer<typeof AccountSetupRequestSchema>;

export const CompleteSetupRequestSchema = z.object({
  externalAccountId: z.string().trim().min(1).max(256).optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
});
export type CompleteSetupRequest = z.infer<typeof CompleteSetupRequestSchema>;

export const DisconnectAccountRequestSchema = z.object({
  retention: z.enum(["keep_history", "delete_local_mapping"]).default("keep_history"),
}).default({ retention: "keep_history" });
export type DisconnectAccountRequest = z.infer<typeof DisconnectAccountRequestSchema>;

export const MessagingLimitsSchema = z.object({
  setupSessionTtlMs: z.literal(MESSAGING_SETUP_SESSION_TTL_MS),
  setupSweepIntervalMs: z.literal(MESSAGING_SETUP_SWEEP_INTERVAL_MS),
  queueCaps: z.object({
    eventsPerOwner: z.literal(MESSAGING_QUEUE_CAPS.eventsPerOwner),
    eventsPerNetwork: z.literal(MESSAGING_QUEUE_CAPS.eventsPerNetwork),
    eventsPerRoom: z.literal(MESSAGING_QUEUE_CAPS.eventsPerRoom),
  }),
  mediaCaps: z.object({
    concurrentJobsPerOwner: z.literal(MESSAGING_MEDIA_CAPS.concurrentJobsPerOwner),
    concurrentJobsPerRoom: z.literal(MESSAGING_MEDIA_CAPS.concurrentJobsPerRoom),
    latestBackfillMessages: z.literal(MESSAGING_MEDIA_CAPS.latestBackfillMessages),
  }),
  idempotencyRetentionMs: z.literal(MESSAGING_IDEMPOTENCY_RETENTION_MS),
  backupRpoMs: z.literal(MESSAGING_BACKUP_RPO_MS),
  restoreRtoMs: z.literal(MESSAGING_RESTORE_RTO_MS),
  whatsappRelinkAfterStaleRestoreMs: z.literal(WHATSAPP_RELINK_AFTER_STALE_RESTORE_MS),
  resourceFloor: z.object({
    default: z.object({
      vcpu: z.literal(MESSAGING_RESOURCE_FLOOR.default.vcpu),
      memoryGiB: z.literal(MESSAGING_RESOURCE_FLOOR.default.memoryGiB),
      diskGiB: z.literal(MESSAGING_RESOURCE_FLOOR.default.diskGiB),
    }),
    synapse: z.object({
      vcpu: z.literal(MESSAGING_RESOURCE_FLOOR.synapse.vcpu),
      memoryGiB: z.literal(MESSAGING_RESOURCE_FLOOR.synapse.memoryGiB),
      diskGiB: z.literal(MESSAGING_RESOURCE_FLOOR.synapse.diskGiB),
    }),
  }),
});
