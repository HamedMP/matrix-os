import { z } from "zod/v4";

/**
 * Shared messaging bridge contracts (spec 2701, ENG-535).
 *
 * Two boundaries share this file so the platform, gateway and renderers
 * cannot drift:
 *   1. gateway -> platform  (`MESSAGING_BRIDGE_PLATFORM_BASE_PATH`)
 *   2. renderer -> gateway  (`MESSAGING_BRIDGE_OWNER_BASE_PATH`)
 */

export const MESSAGING_BRIDGE_NETWORKS = ["whatsapp", "telegram", "linkedin"] as const;
export const MessagingBridgeNetworkSchema = z.enum(MESSAGING_BRIDGE_NETWORKS);
export type MessagingBridgeNetwork = z.infer<typeof MessagingBridgeNetworkSchema>;

export const MESSAGING_BRIDGE_NETWORK_LABELS: Record<MessagingBridgeNetwork, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  linkedin: "LinkedIn",
};

export const MESSAGING_BRIDGE_PLATFORM_BASE_PATH = "/internal/messaging-bridge";
export const MESSAGING_BRIDGE_OWNER_BASE_PATH = "/api/messages";
export const MESSAGING_BRIDGE_CHANGED_EVENT = "messages:changed";

/** Long-poll ceiling for a `display_and_wait` step; callers add their own margin. */
export const MESSAGING_BRIDGE_STEP_WAIT_MS = 25_000;
export const MESSAGING_BRIDGE_MESSAGE_BODY_MAX = 16_000;
/** Cookie-style login values (LinkedIn) can exceed 4 KB. */
export const MESSAGING_BRIDGE_FIELD_VALUE_MAX = 16_384;

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:=-]+$/);
const ShortText = z.string().max(280);
const LongText = z.string().max(2_000);

export const MatrixUserIdSchema = z.string().max(255).regex(/^@[a-z0-9._=\/+-]+:[A-Za-z0-9.-]+(:[0-9]{1,5})?$/);
export const MatrixRoomIdSchema = z.string().max(255).regex(/^![A-Za-z0-9._=\/+-]+(:[A-Za-z0-9.-]+(:[0-9]{1,5})?)?$/);
export const MatrixEventIdSchema = z.string().max(255).regex(/^\$[A-Za-z0-9._=\/+:-]+$/);

/* ------------------------------------------------------------------ */
/* Boundary 1: gateway -> platform                                     */
/* ------------------------------------------------------------------ */

/** POST {platform}/session — idempotently ensures the owner's bridge identity. */
export const MessagingBridgeSessionSchema = z
  .object({
    homeserverUrl: z.url().max(255).refine((value) => value.startsWith("https://")),
    userId: MatrixUserIdSchema,
    accessToken: z.string().min(16).max(1_024),
    deviceId: z.string().min(1).max(128),
    networks: z.array(MessagingBridgeNetworkSchema).max(MESSAGING_BRIDGE_NETWORKS.length),
  })
  .strict();
export type MessagingBridgeSession = z.infer<typeof MessagingBridgeSessionSchema>;

export const MessagingBridgeLoginFlowSchema = z
  .object({ id: Id, name: ShortText, description: LongText.optional() })
  .strict();
export type MessagingBridgeLoginFlow = z.infer<typeof MessagingBridgeLoginFlowSchema>;

export const MessagingBridgeLoginFieldSchema = z
  .object({
    id: Id,
    label: ShortText,
    description: LongText.optional(),
    /** `secret` fields are never echoed, logged or persisted by any layer. */
    kind: z.enum(["text", "phone", "email", "code", "secret", "choice"]),
    required: z.boolean(),
    /** Present only for `choice`; the submitted value must be one of these. */
    options: z.array(ShortText).min(1).max(50).optional(),
  })
  .strict()
  .refine((field) => (field.kind === "choice") === Boolean(field.options));
export type MessagingBridgeLoginField = z.infer<typeof MessagingBridgeLoginFieldSchema>;

/**
 * Normalized bridge login step. Bridge-specific step shapes (including
 * cookie-based logins) are projected onto these four variants by the platform.
 */
export const MessagingBridgeLoginStepSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("display_and_wait"),
      stepId: Id,
      instructions: LongText.optional(),
      display: z.object({ kind: z.enum(["qr", "code", "none"]), data: z.string().max(4_096).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("user_input"),
      stepId: Id,
      instructions: LongText.optional(),
      /** Present when the user must copy values from another site (cookie logins). */
      helpUrl: z.url().max(512).optional(),
      fields: z.array(MessagingBridgeLoginFieldSchema).min(1).max(12),
    })
    .strict(),
  z
    .object({
      type: z.literal("complete"),
      loginId: Id,
      displayName: ShortText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      reason: z.enum(["expired", "rejected", "bridge_unavailable", "unknown"]),
    })
    .strict(),
]);
export type MessagingBridgeLoginStep = z.infer<typeof MessagingBridgeLoginStepSchema>;

/** GET {platform}/:network/login/flows */
export const MessagingBridgeLoginFlowsResponseSchema = z
  .object({ flows: z.array(MessagingBridgeLoginFlowSchema).max(12) })
  .strict();

/** POST {platform}/:network/login/start  body */
export const MessagingBridgeLoginStartRequestSchema = z.object({ flowId: Id.optional() }).strict();

/** POST {platform}/:network/login/step  body */
export const MessagingBridgeLoginStepRequestSchema = z
  .object({
    loginProcessId: Id,
    stepId: Id,
    /** Omitted for `display_and_wait`, where the call long-polls for the scan. */
    fields: z.record(Id, z.string().max(MESSAGING_BRIDGE_FIELD_VALUE_MAX)).optional(),
  })
  .strict();

/** Response of both login/start and login/step. */
export const MessagingBridgeLoginProgressSchema = z
  .object({ loginProcessId: Id, step: MessagingBridgeLoginStepSchema })
  .strict();
export type MessagingBridgeLoginProgress = z.infer<typeof MessagingBridgeLoginProgressSchema>;

/** GET {platform}/:network/logins */
export const MessagingBridgeLoginsResponseSchema = z
  .object({
    logins: z
      .array(
        z
          .object({
            loginId: Id,
            displayName: ShortText.optional(),
            state: z.enum(["connected", "connecting", "needs_relink", "unknown"]),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type MessagingBridgeLogins = z.infer<typeof MessagingBridgeLoginsResponseSchema>;

/** POST {platform}/:network/login/cancel  body -> { ok: true }. Best-effort and idempotent. */
export const MessagingBridgeLoginCancelRequestSchema = z.object({ loginProcessId: Id }).strict();

/** POST {platform}/:network/logout  body */
export const MessagingBridgeLogoutRequestSchema = z.object({ loginId: Id }).strict();

/** Every platform and gateway error body. Never carries provider or bridge detail. */
export const MessagingBridgeErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "unauthorized",
          "forbidden",
          "not_enabled",
          "not_found",
          "invalid_request",
          "conflict",
          "rate_limited",
          "bridge_unavailable",
          "misconfigured",
          "internal",
        ]),
        message: ShortText,
      })
      .strict(),
  })
  .strict();
export type MessagingBridgeErrorCode = z.infer<typeof MessagingBridgeErrorSchema>["error"]["code"];

/* ------------------------------------------------------------------ */
/* Boundary 2: renderer -> gateway (under MESSAGING_BRIDGE_OWNER_BASE_PATH) */
/* ------------------------------------------------------------------ */

/** GET /bridge/status */
export const MessagingBridgeStatusSchema = z
  .object({
    availability: z.enum(["ready", "not_enabled", "unavailable"]),
    networks: z
      .array(
        z
          .object({
            network: MessagingBridgeNetworkSchema,
            accounts: z
              .array(
                z
                  .object({
                    accountId: Id,
                    displayName: ShortText.optional(),
                    state: z.enum(["connected", "connecting", "needs_relink", "unknown"]),
                  })
                  .strict(),
              )
              .max(16),
          })
          .strict(),
      )
      .max(MESSAGING_BRIDGE_NETWORKS.length),
  })
  .strict();
export type MessagingBridgeStatus = z.infer<typeof MessagingBridgeStatusSchema>;

/** POST /bridge/:network/link  body -> MessagingBridgeLinkProgress */
export const MessagingBridgeLinkStartRequestSchema = MessagingBridgeLoginStartRequestSchema;

/** POST /bridge/:network/link/:linkId/step  body -> MessagingBridgeLinkProgress */
export const MessagingBridgeLinkStepRequestSchema = z
  .object({ stepId: Id, fields: z.record(Id, z.string().max(MESSAGING_BRIDGE_FIELD_VALUE_MAX)).optional() })
  .strict();

export const MessagingBridgeLinkProgressSchema = z
  .object({ linkId: Id, network: MessagingBridgeNetworkSchema, step: MessagingBridgeLoginStepSchema })
  .strict();
export type MessagingBridgeLinkProgress = z.infer<typeof MessagingBridgeLinkProgressSchema>;

/** POST /bridge/:network/link/:linkId/cancel  (no body) -> { ok: true }. Best-effort and idempotent. */

/** DELETE /bridge/:network/accounts/:accountId -> { ok: true } */

export const MessagingBridgeConversationSchema = z
  .object({
    roomId: MatrixRoomIdSchema,
    network: MessagingBridgeNetworkSchema,
    displayName: ShortText,
    lastMessagePreview: ShortText.optional(),
    lastEventAt: z.iso.datetime().optional(),
    unreadCount: z.number().int().min(0).max(9_999),
  })
  .strict();
export type MessagingBridgeConversation = z.infer<typeof MessagingBridgeConversationSchema>;

/** GET /bridge/conversations?network=&cursor=&limit= */
export const MessagingBridgeConversationsQuerySchema = z
  .object({
    network: MessagingBridgeNetworkSchema.optional(),
    cursor: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const MessagingBridgeConversationsResponseSchema = z
  .object({ items: z.array(MessagingBridgeConversationSchema).max(100), nextCursor: z.string().max(256).optional() })
  .strict();

export const MessagingBridgeClientTxnIdSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const MessagingBridgeMessageSchema = z
  .object({
    /** Absent only while an outgoing message is `sending` or `failed`. */
    eventId: MatrixEventIdSchema.optional(),
    /** Present on messages sent from Matrix; a retry must reuse it. */
    clientTxnId: MessagingBridgeClientTxnIdSchema.optional(),
    direction: z.enum(["incoming", "outgoing"]),
    senderName: ShortText,
    kind: z.enum(["text", "media", "other"]),
    /** Plain text only. Media and unsupported events carry a short placeholder. */
    body: z.string().max(MESSAGING_BRIDGE_MESSAGE_BODY_MAX),
    occurredAt: z.iso.datetime(),
    delivery: z.enum(["sending", "sent", "failed"]).optional(),
  })
  .strict()
  .refine((message) => Boolean(message.eventId ?? message.clientTxnId));
export type MessagingBridgeMessage = z.infer<typeof MessagingBridgeMessageSchema>;

/** GET /bridge/conversations/:roomId/messages?cursor=&limit=  (newest first) */
export const MessagingBridgeMessagesQuerySchema = z
  .object({ cursor: z.string().max(256).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
export const MessagingBridgeMessagesResponseSchema = z
  .object({ items: z.array(MessagingBridgeMessageSchema).max(100), nextCursor: z.string().max(256).optional() })
  .strict();

/** POST /bridge/conversations/:roomId/send  body -> MessagingBridgeMessage */
export const MessagingBridgeSendRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(MESSAGING_BRIDGE_MESSAGE_BODY_MAX),
    clientTxnId: MessagingBridgeClientTxnIdSchema,
  })
  .strict();

/** Owner WebSocket notification. Generic by design: clients refetch. */
export const MessagingBridgeChangedEventSchema = z
  .object({
    type: z.literal(MESSAGING_BRIDGE_CHANGED_EVENT),
    scope: z.enum(["accounts", "conversations", "messages"]),
    roomId: MatrixRoomIdSchema.optional(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type MessagingBridgeChangedEvent = z.infer<typeof MessagingBridgeChangedEventSchema>;
