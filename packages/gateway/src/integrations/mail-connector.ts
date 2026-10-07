import { z } from "zod/v4";
import { boundedOperation } from "../bounded-operation.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const page = { maxResults: z.number().int().min(1).max(100).optional(), pageToken: z.string().min(1).max(2048).optional() };
const inbox = z.tuple([z.literal("INBOX")]);
export const MailConnectorOperation = z.discriminatedUnion("action", [
  z.strictObject({action:z.literal("get_profile"),params:z.strictObject({})}),
  z.strictObject({action:z.literal("get_message"),params:z.strictObject({messageId:id})}),
  z.strictObject({action:z.literal("get_message_summary"),params:z.strictObject({messageId:id})}),
  z.strictObject({action:z.literal("get_metadata"),params:z.strictObject({messageId:id})}),
  z.strictObject({action:z.literal("search"),params:z.strictObject({query:z.string().min(1).max(256),...page})}),
  z.strictObject({action:z.literal("list_messages"),params:z.strictObject({query:z.string().min(1).max(256),...page})}),
  z.strictObject({action:z.literal("list_history"),params:z.strictObject({startHistoryId:z.string().regex(/^\d{1,20}$/),...page})}),
  z.strictObject({action:z.literal("modify_message"),params:z.union([
    z.strictObject({messageId:id,addLabelIds:inbox}),z.strictObject({messageId:id,removeLabelIds:inbox}),
  ])}),
]);
export class MailConnectorError extends Error {
  constructor(readonly code: "history_expired" | "unavailable" | "denied" | "content_limit") { super("Email source is unavailable"); }
}

/** Fixed OAuth proxy targets, bounded bodies and no automatic mutation retries. */
export function createBoundedMailConnector(options:{projectId:string;environment:"development"|"production";getAccessToken:()=>Promise<string>;fetcher?:typeof fetch}) {
  const project=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).parse(options.projectId);
  const environment=z.enum(["development","production"]).parse(options.environment);
  return async (raw:unknown,callerSignal?:AbortSignal):Promise<unknown> => {
    const input=z.strictObject({externalUserId:z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/),accountId:id,action:z.string(),params:z.unknown()}).parse(raw);
    const operation=MailConnectorOperation.parse({action:input.action,params:input.params});
    return boundedOperation(async signal => {
      const target=new URL("https://gmail.googleapis.com/gmail/v1/users/me/profile");
      let maxBytes=32*1024,body:string|undefined;
      if(operation.action==="get_message"||operation.action==="get_metadata"||operation.action==="get_message_summary"||operation.action==="modify_message") {
        target.pathname=`/gmail/v1/users/me/messages/${operation.params.messageId}`;
        if(operation.action==="modify_message") { target.pathname+="/modify"; body=JSON.stringify(operation.params); const parsed=JSON.parse(body); delete parsed.messageId; body=JSON.stringify(parsed); }
        else if(operation.action==="get_message") {target.searchParams.set("format","full");maxBytes=3*1024*1024;}
        else if(operation.action==="get_message_summary") {target.searchParams.set("format","metadata");target.searchParams.set("fields","id,threadId,internalDate,labelIds,payload(headers)");}
        else {target.searchParams.set("format","minimal");target.searchParams.set("fields","id,threadId,labelIds,historyId");}
      } else if(operation.action==="search"||operation.action==="list_messages") {
        target.pathname="/gmail/v1/users/me/messages"; target.searchParams.set("q",operation.params.query);
        target.searchParams.set("maxResults",String(operation.params.maxResults??100));
        if(operation.params.pageToken) target.searchParams.set("pageToken",operation.params.pageToken);
        maxBytes=128*1024;
      } else if(operation.action==="list_history") {
        target.pathname="/gmail/v1/users/me/history";target.searchParams.set("startHistoryId",operation.params.startHistoryId);
        target.searchParams.set("maxResults",String(operation.params.maxResults??100));
        if(operation.params.pageToken)target.searchParams.set("pageToken",operation.params.pageToken);
        maxBytes=512*1024;
      }
      const url=new URL(`https://api.pipedream.com/v1/connect/${project}/proxy/${Buffer.from(target.href).toString("base64url")}`);
      url.searchParams.set("external_user_id",input.externalUserId);url.searchParams.set("account_id",input.accountId);
      const token=await options.getAccessToken();signal.throwIfAborted();
      const response=await(options.fetcher??fetch)(url.href,{method:body?"POST":"GET",body,signal,redirect:"error",headers:{Authorization:`Bearer ${token}`,"x-pd-environment":environment,Accept:"application/json",...(body?{"content-type":"application/json"}:{})}});
      const declared=response.headers.get("content-length");
      if(!response.ok||!response.body||(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))) {
        await response.body?.cancel();
        throw new MailConnectorError(operation.action==="list_history"&&response.status===404?"history_expired":response.ok&&operation.action==="get_message"&&declared!==null&&/^\d+$/.test(declared)&&Number(declared)>maxBytes?"content_limit":"unavailable");
      }
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      const aborted=()=>{void reader.cancel().catch(error=>console.warn("[mail] Response cleanup failed",error instanceof Error?error.name:"UnknownError"));};
      signal.addEventListener("abort",aborted,{once:true});
      try {
        for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes)throw new MailConnectorError(operation.action==="get_message"?"content_limit":"unavailable");if(chunks.length>=4096)throw new MailConnectorError("unavailable");chunks.push(next.value);}
        signal.throwIfAborted();return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks,size))) as unknown;
      }catch(error){await reader.cancel();throw error;}finally{signal.removeEventListener("abort",aborted);reader.releaseLock();}
    },10_000,callerSignal);
  };
}
