import { z } from "zod/v4";
import type { PlatformDb } from "../platform-db.js";
import type { PipedreamConnectClient } from "../integrations/pipedream.js";
import { createMailCallRoutes } from "../integrations/mail-call.js";
import { MailConnectorError, MailConnectorOperation } from "../integrations/mail-connector.js";
import { createPlatformIntegrationTransport } from "../bots/integration-client.js";

const Connection=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),service:z.string().max(64),
  account_label:z.string().min(1).max(100),account_email:z.email().max(320).nullable(),status:z.string().max(32)});
export type MailConnection=z.infer<typeof Connection>;
export interface MailBinding {service:"gmail";connectionId:string;accountLabel:string;expectedEmail:string}

async function json(response:Response,signal:AbortSignal,maxBytes:number):Promise<unknown> {
  const length=response.headers.get("content-length");
  if(!response.ok){await response.body?.cancel();throw new MailConnectorError(response.status===409?"history_expired":response.status===403?"denied":response.status===413?"content_limit":"unavailable");}
  if(!response.body||(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes))){await response.body?.cancel();throw new MailConnectorError("unavailable");}
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  const abort=()=>{void reader.cancel().catch(error=>console.warn("[mail] Body cleanup failed",error instanceof Error?error.name:"UnknownError"));};
  signal.addEventListener("abort",abort,{once:true});
  try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes||chunks.length>=4096)throw new MailConnectorError("unavailable");chunks.push(next.value);}signal.throwIfAborted();return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks,size))) as unknown;}
  catch(error){await reader.cancel();throw error;}finally{signal.removeEventListener("abort",abort);reader.releaseLock();}
}
export function createMailTransport(options:{internalBaseUrl:string|null;machineToken?:string;db?:PlatformDb|null;pipedream?:PipedreamConnectClient|null;fetcher?:typeof fetch}) {
  const remote=options.internalBaseUrl&&options.machineToken
    ?createPlatformIntegrationTransport({baseUrl:options.internalBaseUrl,machineToken:options.machineToken,fetchImpl:options.fetcher}):null;
  return {
    async inventory(ownerId:string,callerSignal?:AbortSignal):Promise<MailConnection[]> {
      const signal=AbortSignal.any([AbortSignal.timeout(10_000),...(callerSignal?[callerSignal]:[])]);
      let raw:unknown;
      if(remote)raw=await json(await remote(ownerId,{method:"GET",path:"/",signal}),signal,128*1024);
      else if(options.db)raw=await options.db.listConnectedServices(ownerId);
      else throw new MailConnectorError("unavailable");
      return z.array(Connection).max(256).parse(raw).filter(c=>c.service==="gmail"&&c.status==="active"&&c.account_email);
    },
    async call(ownerId:string,binding:MailBinding,action:string,params:Record<string,unknown>,callerSignal?:AbortSignal) {
      const operation=MailConnectorOperation.parse({action,params});
      const signal=AbortSignal.any([AbortSignal.timeout(15_000),...(callerSignal?[callerSignal]:[])]);
      let response:Response;
      if(remote) response=await remote(ownerId,{method:"POST",path:"/mail-call",body:{binding,operation},signal});
      else {
        if(!options.db||!options.pipedream)throw new MailConnectorError("unavailable");
        const app=createMailCallRoutes({db:options.db,pipedream:options.pipedream,resolveUserId:async()=>ownerId,authorizeInternal:async()=>true});
        response=await app.request("/mail-call",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({binding,operation}),signal});
      }
      return json(response,signal,action==="get_message"?3*1024*1024:512*1024);
    },
  };
}
export type MailTransport=ReturnType<typeof createMailTransport>;
