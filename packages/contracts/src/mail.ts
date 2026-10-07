import { z } from "zod/v4";

export const MAIL_CONSUMERS = ["edition", "folio", "atlas"] as const;
export const MailId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const selection = z.array(MailId).min(1).max(100).refine(ids => new Set(ids).size === ids.length);
const empty = z.strictObject({});
const appId = z.enum(MAIL_CONSUMERS);
export const MailReadRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ appId, action: z.literal("sources"), payload: empty }),
  z.strictObject({ appId, action: z.literal("messages"), payload: z.strictObject({
    view: z.enum(["latest", "unread", "saved", "review", "library"]).optional(),
    query: z.string().max(200).optional(), scope: z.enum(["all", "work", "personal"]).optional(),
    sourceId: MailId.optional(), cursor: z.string().max(256).optional(),
    limit:z.number().int().min(1).max(100).optional(),
  }) }),
  z.strictObject({ appId, action: z.literal("message"), payload: z.strictObject({ id: MailId,contentOffset:z.number().int().min(0).max(3_000_000).optional(),contentLimit:z.number().int().min(1).max(24_000).optional() }) }),
]);
export type MailReadRequest = z.infer<typeof MailReadRequestSchema>;
export function withMailReadDefaults(input:MailReadRequest,chunked=false):MailReadRequest {
  if(input.action==='messages')return{...input,payload:{...input.payload,limit:input.payload.limit??20}};
  if(input.action==='message'&&chunked)return{...input,payload:{...input.payload,contentOffset:input.payload.contentOffset??0,contentLimit:Math.min(input.payload.contentLimit??16_000,16_000)}};
  return input;
}
const actions = z.discriminatedUnion("action", [
  ...MailReadRequestSchema.options,
  z.strictObject({appId:z.literal("edition"),action:z.literal("retention"),payload:z.strictObject({sourceId:MailId,mode:z.enum(["keep","purge"])})}),
  z.strictObject({ appId: z.literal("edition"), action: z.literal("cleanup-recovery"), payload: empty }),
  z.strictObject({ appId, action: z.literal("connect"), payload: z.strictObject({
    connectionId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
    expectedEmail: z.email().max(320), scope: z.enum(["personal", "work"]), historyMonths: z.number().int().min(1).max(24),
    shareWith: z.array(z.enum(["folio", "atlas"])).max(2).refine(ids => new Set(ids).size === ids.length).optional(),
  }) }),
  z.strictObject({ appId, action: z.literal("sync"), payload: z.strictObject({ sourceId: MailId }) }),
  z.strictObject({ appId, action: z.literal("reading"), payload: z.strictObject({
    id: MailId, baseRevision: revision, saved: z.boolean().optional(), read: z.boolean().optional(), progress: z.number().min(0).max(1).optional(),
  }).refine(p => p.saved !== undefined || p.read !== undefined || p.progress !== undefined) }),
  z.strictObject({ appId, action: z.literal("correct"), payload: z.strictObject({ id: MailId, classification: z.enum(["newsletter", "other"]), baseRevision: revision }) }),
  z.strictObject({ appId, action: z.literal("cleanup-preview"), payload: z.strictObject({ messageIds: selection }) }),
  z.strictObject({ appId, action: z.literal("cleanup-commit"), payload: z.strictObject({ planId: MailId, revision }) }),
  z.strictObject({ appId, action: z.literal("cleanup-undo"), payload: z.strictObject({ operationId: MailId }) }),
  z.strictObject({ appId, action: z.literal("export"), payload: z.strictObject({ messageIds: selection }) }),
  z.strictObject({ appId, action: z.literal("delete"), payload: z.strictObject({ messageId: MailId, baseRevision: revision }) }),
]);
export const MailActionRequestSchema = actions;
export type MailActionRequest = z.infer<typeof MailActionRequestSchema>;
export function isAllowedMailBridgeBody(identity: string, body: string): boolean {
  if (body.length > 16_384) return false;
  let value: unknown;
  try { value = JSON.parse(body); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; return false; }
  const parsed = MailActionRequestSchema.safeParse(value);
  if (!parsed.success || parsed.data.appId !== identity) return false;
  return identity === "edition" || ["sources", "messages", "message"].includes(parsed.data.action);
}
export function isMailConsumer(identity: string): boolean {
  return MAIL_CONSUMERS.some(appId => appId === identity);
}
