import { z } from "zod/v4";

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
export const SlackBridgeAuthorizationSchema = z.object({ownerId:Actor,organizationId:Organization,actorId:Actor,
  scopeId:z.uuid(),action:z.enum(["manage_members","discuss"])}).strict();
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
