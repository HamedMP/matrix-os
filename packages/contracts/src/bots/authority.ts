import { z } from "zod/v4";
import { CanonicalChatIdSchema } from "#canonical-chat";
import { canonicalBoundedText } from "#canonical-chat-primitives";
import { IsoTimestampSchema } from "#contract-primitives";
import { BotGrantSchema } from "#bots/grants";
import { BotIdSchema, BotIntegrationServiceSchema, BotInteractionIdSchema, BotRevisionSchema, BotRoutineIdSchema } from "#bots/ids";
import { BotInteractionKindSchema } from "#bots/interactions";
import { BotMemoryItemSchema } from "#bots/memory";

export const BotConnectionStateSchema = z.object({
  service: BotIntegrationServiceSchema,
  state: z.enum(["not_connected", "connected_not_granted", "granted"]),
}).strict();

export const BotRoutineSummarySchema = z.object({
  routineId: BotRoutineIdSchema,
  summary: canonicalBoundedText(200, 800),
  status: z.enum(["active", "paused"]),
  nextFireAt: IsoTimestampSchema.nullable(),
}).strict();

export const BotPendingInteractionSummarySchema = z.object({
  interactionId: BotInteractionIdSchema,
  kind: BotInteractionKindSchema,
  chatId: CanonicalChatIdSchema,
  expiresAt: IsoTimestampSchema,
}).strict();

/**
 * Authoritative, read-only projection of what a bot may do, rendered from
 * server state. A bot's own description of its access is never a substitute.
 */
export const BotAuthorityViewSchema = z.object({
  agentId: BotIdSchema,
  revision: BotRevisionSchema,
  grants: z.array(BotGrantSchema).max(100),
  connections: z.array(BotConnectionStateSchema).max(64),
  routines: z.array(BotRoutineSummarySchema).max(32),
  pendingInteractions: z.array(BotPendingInteractionSummarySchema).max(32),
  memory: z.object({
    items: z.array(BotMemoryItemSchema).max(100),
    nextCursor: z.string().min(1).max(512).optional(),
  }).strict(),
}).strict();

export type BotConnectionState = z.infer<typeof BotConnectionStateSchema>;
export type BotRoutineSummary = z.infer<typeof BotRoutineSummarySchema>;
export type BotAuthorityView = z.infer<typeof BotAuthorityViewSchema>;
