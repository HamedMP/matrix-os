import { z } from "zod/v4";

const Id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const SessionId = z.uuid();
export const AoedeStartRequestSchema = z.object({
  clientRequestId: SessionId,
  sdp: z.string().min(1).max(60_000),
}).strict();
export const AoedeCloseRequestSchema = z.object({ sessionId: SessionId }).strict();
export const AoedeSessionResponseSchema = z.object({
  sessionId: SessionId, providerSessionId: Id, sdp: z.string().min(1).max(60_000),
}).strict();
export const AoedeTranscriptSchema = z.object({
  role: z.enum(["user", "assistant"]), text: z.string().max(16_000), offset: z.number().nonnegative(),
}).strict();
export const AoedeApprovalSchema = z.object({
  approvalId: Id, title: z.string().max(512), description: z.string().max(2_000),
  risk: z.enum(["low", "medium", "high"]),
  allowedDecisions: z.array(z.enum(["approve_once", "approve_session", "deny"])).max(3),
}).strict();
export const AoedeCardSchema = z.object({
  id: Id, chatId: Id, runId: Id.optional(), queuedTurnId: Id.optional(), title: z.string().max(512),
  status: z.enum(["queued", "running", "approval", "done", "failed", "cancelled"]),
  approval: AoedeApprovalSchema.optional(),
}).strict();
const uiFields = {
  sessionId: SessionId, correlationId: SessionId, phase: z.enum(["resolve", "execute"]),
};
export const AoedeServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("aoede:state"), sessionId: SessionId,
    state: z.enum(["active", "closed", "interrupted", "superseded", "error"]) }).strict(),
  z.object({ type: z.literal("aoede:ui"), ...uiFields,
    action: z.enum(["open_app", "close_app"]), target: z.string().min(1).max(160) }).strict(),
  z.object({ type: z.literal("aoede:card"), sessionId: SessionId, card: AoedeCardSchema }).strict(),
  z.object({ type: z.literal("aoede:approval_decide"), sessionId: SessionId,
    chatId: Id, runId: Id, approvalId: Id, decision: z.enum(["approve_once", "deny"]),
    clientRequestId: SessionId }).strict(),
]);
export const AoedeClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("aoede:ready"), sessionId: SessionId }).strict(),
  z.object({ type: z.literal("aoede:ui_result"), ...uiFields,
    status: z.enum(["ok", "ambiguous", "not_found", "failed"]), slug: z.string().max(160).optional() }).strict(),
  z.object({ type: z.literal("aoede:approval_result"), sessionId: SessionId,
    approvalId: Id, clientRequestId: SessionId, accepted: z.boolean() }).strict(),
  z.object({ type: z.literal("aoede:cancel"), sessionId: SessionId, cardId: Id }).strict(),
]);
export type AoedeStartRequest = z.infer<typeof AoedeStartRequestSchema>;
export type AoedeSessionResponse = z.infer<typeof AoedeSessionResponseSchema>;
export type AoedeTranscript = z.infer<typeof AoedeTranscriptSchema>;
export type AoedeCard = z.infer<typeof AoedeCardSchema>;
export type AoedeServerMessage = z.infer<typeof AoedeServerMessageSchema>;
export type AoedeClientMessage = z.infer<typeof AoedeClientMessageSchema>;
