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
export const MessagingReplyIdSchema = z.string().trim().regex(/^reply_[A-Za-z0-9_-]{12,96}$/);
export const HermesWorkItemIdSchema = z.string().trim().regex(/^work_[A-Za-z0-9_-]{12,96}$/);
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

export const BridgeEventEffectSchema = z.enum([
  "stored_only",
  "sent_to_hermes",
  "automation_queued",
  "reply_sent",
  "ignored",
]);
export type BridgeEventEffect = z.infer<typeof BridgeEventEffectSchema>;

export const OutgoingReplyStatusSchema = z.enum([
  "draft",
  "approval_required",
  "sending",
  "sent",
  "failed",
  "cancelled",
]);
export type OutgoingReplyStatus = z.infer<typeof OutgoingReplyStatusSchema>;

export const OutgoingReplySourceSchema = z.enum(["user", "hermes", "automation"]);
export type OutgoingReplySource = z.infer<typeof OutgoingReplySourceSchema>;

export const HermesWorkItemStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "cancel_requested",
  "cancelled",
  "failed",
]);
export type HermesWorkItemStatus = z.infer<typeof HermesWorkItemStatusSchema>;

export const HermesWorkItemKindSchema = z.enum(["summarize", "classify", "draft_reply", "automation"]);
export type HermesWorkItemKind = z.infer<typeof HermesWorkItemKindSchema>;

export const AutomationRuleIdSchema = z.string().trim().regex(/^auto_[A-Za-z0-9_-]{12,96}$/);
export const AutomationRuleStatusSchema = z.enum(["enabled", "paused", "disabled"]);
export const AutomationRuleScopeSchema = z.enum(["room", "network", "account", "all_permitted"]);
export const AutomationTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text_contains"),
    value: z.string().trim().min(1).max(160),
  }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_task"),
    titleTemplate: z.string().trim().min(1).max(160),
  }),
  z.object({
    type: z.literal("draft_reply"),
    bodyTemplate: z.string().trim().min(1).max(1_000),
  }),
]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

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

export const HermesPermissionSchema = z.object({
  ownerId: z.string().trim().min(1).max(256),
  roomId: MatrixRoomIdSchema,
  readEnabled: z.boolean(),
  replyEnabled: z.boolean(),
  automationEnabled: z.boolean(),
  mentionOnly: z.boolean(),
  revokedAt: z.string().datetime().optional(),
  revision: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type HermesPermission = z.infer<typeof HermesPermissionSchema>;

export const BridgeEventCursorSchema = z.object({
  ownerId: z.string().trim().min(1).max(256),
  networkSlug: MessagingNetworkSlugSchema,
  roomId: MatrixRoomIdSchema.optional(),
  eventId: MatrixEventIdSchema,
  externalEventId: z.string().trim().min(1).max(512).optional(),
  eventHash: z.string().trim().min(1).max(128).optional(),
  processedAt: z.string().datetime(),
  effect: BridgeEventEffectSchema,
});
export type BridgeEventCursor = z.infer<typeof BridgeEventCursorSchema>;

export const OutgoingReplySchema = z.object({
  id: MessagingReplyIdSchema,
  ownerId: z.string().trim().min(1).max(256),
  roomId: MatrixRoomIdSchema,
  source: OutgoingReplySourceSchema,
  status: OutgoingReplyStatusSchema,
  body: z.string().trim().min(1).max(32_000),
  permissionRevision: z.number().int().min(1),
  clientTxnId: ClientTxnIdSchema,
  matrixEventId: MatrixEventIdSchema.optional(),
  failureCode: z.enum(["permission_denied", "send_failed", "stale_room_mapping"]).optional(),
  cancelReason: z.enum(["user_cancelled", "permission_revoked", "send_failed", "stale_room_mapping"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OutgoingReply = z.infer<typeof OutgoingReplySchema>;

export const HermesWorkItemSchema = z.object({
  id: HermesWorkItemIdSchema,
  ownerId: z.string().trim().min(1).max(256),
  roomId: MatrixRoomIdSchema,
  sourceEventId: MatrixEventIdSchema,
  kind: HermesWorkItemKindSchema,
  status: HermesWorkItemStatusSchema,
  permissionRevision: z.number().int().min(1),
  abortTokenId: z.string().trim().min(1).max(160),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type HermesWorkItem = z.infer<typeof HermesWorkItemSchema>;

export const AutomationRuleSchema = z.object({
  id: AutomationRuleIdSchema,
  ownerId: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(120),
  scope: AutomationRuleScopeSchema,
  roomId: MatrixRoomIdSchema.optional(),
  trigger: AutomationTriggerSchema,
  action: AutomationActionSchema,
  status: AutomationRuleStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AutomationRule = z.infer<typeof AutomationRuleSchema>;

export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: CursorSchema.optional(),
});

export const PermissionUpdateRequestSchema = z.object({
  baseRevision: z.number().int().min(1),
  readEnabled: z.boolean(),
  replyEnabled: z.boolean(),
  automationEnabled: z.boolean(),
  mentionOnly: z.boolean(),
});
export type PermissionUpdateRequest = z.infer<typeof PermissionUpdateRequestSchema>;

export const AppserviceEventSchema = z.object({
  eventId: MatrixEventIdSchema,
  externalEventId: z.string().trim().min(1).max(512).optional(),
  roomId: MatrixRoomIdSchema,
  accountId: MessagingAccountIdSchema,
  type: z.literal("message"),
  sender: z.object({
    displayName: z.string().trim().min(1).max(160).optional(),
  }).default({}),
  content: z.object({
    kind: z.literal("text"),
    body: z.string().trim().min(1).max(32_000),
    mentionsOwner: z.boolean().optional(),
  }),
  occurredAt: z.string().datetime(),
});
export type AppserviceEvent = z.infer<typeof AppserviceEventSchema>;

export const AppserviceEventsRequestSchema = z.object({
  events: z.array(AppserviceEventSchema).max(100),
});

export const ReplyRequestSchema = z.object({
  source: OutgoingReplySourceSchema,
  body: z.string().trim().min(1).max(32_000),
  mode: z.enum(["send_if_allowed", "draft_if_not_allowed", "approval_required"]),
  clientTxnId: ClientTxnIdSchema.optional(),
});
export type ReplyRequest = z.infer<typeof ReplyRequestSchema>;

export const DraftsQuerySchema = z.object({
  roomId: MatrixRoomIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: CursorSchema.optional(),
});

export const ApproveDraftRequestSchema = z.object({
  baseStatus: z.literal("approval_required"),
});
export type ApproveDraftRequest = z.infer<typeof ApproveDraftRequestSchema>;

export const CancelDraftRequestSchema = z.object({
  reason: z.enum(["user_cancelled"]).default("user_cancelled"),
});
export type CancelDraftRequest = z.infer<typeof CancelDraftRequestSchema>;

export const AutomationRuleCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scope: AutomationRuleScopeSchema,
  roomId: MatrixRoomIdSchema.optional(),
  trigger: AutomationTriggerSchema,
  action: AutomationActionSchema,
}).refine((value) => value.scope !== "room" || Boolean(value.roomId), {
  message: "roomId is required for room automation",
  path: ["roomId"],
}).refine((value) => value.scope === "room" || value.scope === "all_permitted", {
  message: "network and account automation scopes are not available yet",
  path: ["scope"],
});
export type AutomationRuleCreateRequest = z.infer<typeof AutomationRuleCreateRequestSchema>;

export const RecoveryRequestSchema = z.object({
  action: z.enum(["recheck", "restart_bridge", "relink"]),
});
export type RecoveryRequest = z.infer<typeof RecoveryRequestSchema>;

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
