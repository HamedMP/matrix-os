import { z } from "zod/v4";
import { ChatAgentIdSchema } from "#chat-agent-context";
import { CanonicalChatIdSchema } from "#canonical-chat";

export const SLACK_OAUTH_COMPLETION_PATH = '/slack/oauth/complete';
export const SlackOAuthCallbackQuerySchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(2_048).regex(/^[A-Za-z0-9._-]+$/),
}).strict();
export type SlackOAuthCallbackQuery = z.infer<typeof SlackOAuthCallbackQuerySchema>;

const Actor = z.string().regex(/^user_[A-Za-z0-9_-]{1,123}$/);
const Organization = z.string().regex(/^org_[A-Za-z0-9_-]{1,124}$/);
const Timestamp = z.string().regex(/^\d{1,16}\.\d{1,8}$/);
export const SlackBridgeEnvelopeSchema = z.object({
  ownerId: Actor, organizationId: Organization, actorId: Actor, channelScopeId: z.uuid().optional(),
  companyPublicationApproved:z.literal(true).optional(),
  event: z.object({eventId:z.string().regex(/^Ev[A-Za-z0-9]{1,126}$/),appId:z.string().regex(/^A[A-Z0-9]{2,63}$/),
    teamId:z.string().regex(/^T[A-Z0-9]{2,63}$/),userId:z.string().regex(/^[UW][A-Z0-9]{2,63}$/),
    channelId:z.string().regex(/^[CDG][A-Z0-9]{2,63}$/),ts:Timestamp,threadTs:Timestamp.optional(),
    text:z.string().min(1).max(40_000),kind:z.enum(["mention","direct_message"])}).strict(),
}).strict();
export type SlackBridgeEnvelope = z.infer<typeof SlackBridgeEnvelopeSchema>;

const Provenance = SlackBridgeEnvelopeSchema.shape.event.pick({ appId: true, teamId: true, eventId: true, userId: true, ts: true });
const PrivateThread = z.object({
  ownerId: Actor, botId: ChatAgentIdSchema, chatId: CanonicalChatIdSchema,
  runtimeId: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),
}).strict();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const SlackThreadContextAccessSchema = PrivateThread.extend({ grantId: Digest }).strict();
export type SlackThreadContextAccess = z.infer<typeof SlackThreadContextAccessSchema>;
export const SlackChannelMetadataSchema = z.object({
  id: z.string().regex(/^C[A-Z0-9]{2,63}$/),
  name: z.string().min(1).max(80).regex(/^[^\s\p{C}#<>&]+$/u),
}).strict();
export type SlackChannelMetadata = z.infer<typeof SlackChannelMetadataSchema>;
export const SlackThreadContextAccessRequestSchema = SlackThreadContextAccessSchema.extend({
  includeChannelMetadata: z.literal(true).optional(),
}).strict();
export const SlackThreadContextAccessResponseSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(false) }).strict(),
  z.object({ allowed: z.literal(true), channel: SlackChannelMetadataSchema.optional() }).strict(),
]);
export type SlackThreadContextAccessResponse = z.infer<typeof SlackThreadContextAccessResponseSchema>;

export const SlackThreadContextEnvelopeSchema = SlackThreadContextAccessSchema.extend({
  event: Provenance.extend({
    channelId: z.string().regex(/^C[A-Z0-9]{2,63}$/), threadTs: Timestamp, text: z.string().min(1).max(40_000),
  }).strict().refine(event => Boolean(event.text.trim())),
}).strict();
export type SlackThreadContextEnvelope = z.infer<typeof SlackThreadContextEnvelopeSchema>;

const AuthorizationIdentity = { ownerId: Actor, organizationId: Organization, actorId: Actor, scopeId: z.uuid() };
export const SlackBridgePublicationSchema = z.object({ ...AuthorizationIdentity, action: z.literal("publish_reply"),
  appId: SlackBridgeEnvelopeSchema.shape.event.shape.appId, teamId: SlackBridgeEnvelopeSchema.shape.event.shape.teamId,
  eventId: SlackBridgeEnvelopeSchema.shape.event.shape.eventId, textDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SlackPublicationIdentity = Omit<z.infer<typeof SlackBridgePublicationSchema>, "ownerId" | "action">;
export const SlackBridgeAuthorizationSchema = z.discriminatedUnion("action", [
  z.object({ ...AuthorizationIdentity, action: z.literal("manage_members") }).strict(),
  z.object({ ...AuthorizationIdentity, action: z.literal("discuss") }).strict(),
  SlackBridgePublicationSchema,
]);
const encoder = new TextEncoder();
async function key(token:string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Slack bridge unavailable");
  return crypto.subtle.importKey("raw",encoder.encode(token),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
}
function message(path:string,body:string,timestamp:string) { return encoder.encode(`matrix-slack-v1\nPOST\n${path}\n${timestamp}\n${body}`); }
export async function signSlackBridgeRequest(input:{token:string;path:string;body:string;now?:Date}) {
  const timestamp=String(Math.floor((input.now??new Date()).getTime()/1000));
  const bytes=new Uint8Array(await crypto.subtle.sign("HMAC",await key(input.token),message(input.path,input.body,timestamp)));
  return {"x-matrix-slack-timestamp":timestamp,"x-matrix-slack-signature":Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("")};
}
/** The runtime credential signs an exact POST path/body; it never becomes an employee bearer token. */
export async function verifySlackBridgeRequest(input:{token:string;path:string;body:string;timestamp?:string;signature?:string;now?:Date}) {
  if (!input.timestamp || !/^\d{1,12}$/.test(input.timestamp) || !input.signature || !/^[a-f0-9]{64}$/.test(input.signature)) return false;
  const age=(input.now??new Date()).getTime()-Number(input.timestamp)*1000;
  if(age < -5000 || age > 30_000) return false;
  const bytes=Uint8Array.from(input.signature.match(/../g)!,pair=>Number.parseInt(pair,16));
  return crypto.subtle.verify("HMAC",await key(input.token),bytes,message(input.path,input.body,input.timestamp));
}

/** Authenticated callback attestation for an opt-in Dev lane. The gateway selects the recipient. */
export const SlackAgentChannelSchema = z.strictObject({
  ownerId: Actor, runtimeId: PrivateThread.shape.runtimeId, appId: Provenance.shape.appId,
  teamId: Provenance.shape.teamId, channelId: SlackChannelMetadataSchema.shape.id,
  name: SlackChannelMetadataSchema.shape.name.refine(name => name.toLowerCase() !== "tech"),
  installationGeneration: z.number().int().positive(), senderId: Provenance.shape.userId, sourceId: Digest,
});
export type SlackAgentChannel = z.infer<typeof SlackAgentChannelSchema>;
export const RoutedSlackEventSchema = SlackAgentChannelSchema.omit({name:true,senderId:true}).extend({
  eventId: Provenance.shape.eventId, ts: Timestamp, threadTs: Timestamp, userId: Provenance.shape.userId,
  text: z.string().trim().min(1).max(12_000),
});
export type RoutedSlackEvent = z.infer<typeof RoutedSlackEventSchema>;
