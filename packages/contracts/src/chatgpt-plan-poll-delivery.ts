import { z } from 'zod/v4';
import { CHATGPT_PLAN_PEER_MAX_SEQUENCE, ChatGptPlanPeerRequestSchema, ChatGptPlanPeerSessionSchema } from '#chatgpt-plan-peer';

export const ChatGptPlanPeerCapabilitiesSchema = ChatGptPlanPeerSessionSchema.extend({
  pollDeliveryVersion: z.literal(2),
  replyDeliveryVersion: z.literal(2).optional(),
  inferenceStream: z.literal(true).optional(),
  approvedRoutines: z.literal(true).optional(),
}).strict();

const cursor = z.number().int().min(0).max(CHATGPT_PLAN_PEER_MAX_SEQUENCE);
export const ChatGptPlanPeerPollV2RequestSchema = z.object({
  version: z.literal(2), sessionId: z.uuid(), ackThrough: cursor,
}).strict();
export const ChatGptPlanPeerPollV2Schema = z.object({
  version: z.literal(2), sessionId: z.uuid(), acknowledgedThrough: cursor,
  deliveries: z.array(z.object({ deliverySequence: cursor.refine(value => value > 0),
    request: ChatGptPlanPeerRequestSchema }).strict()).max(32),
}).strict().refine(batch => batch.deliveries.every((entry, i) => entry.deliverySequence === batch.acknowledgedThrough + i + 1));
export type ChatGptPlanPeerPollV2 = z.infer<typeof ChatGptPlanPeerPollV2Schema>;
