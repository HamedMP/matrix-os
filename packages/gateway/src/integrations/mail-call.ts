import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { PlatformDb } from "../platform-db.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { IntegrationAccountBindingSchema } from "./read-call.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "./scope-provenance.js";
import { MailConnectorError, MailConnectorOperation } from "./mail-connector.js";

const Body=z.strictObject({binding:IntegrationAccountBindingSchema,operation:MailConnectorOperation});
/** Called only by the owning gateway's archive worker over signed machine delegation. */
export function createMailCallRoutes(options:{db:PlatformDb;pipedream:PipedreamConnectClient;resolveUserId:(c:Context)=>Promise<string|null>;authorizeInternal?:(c:Context)=>Promise<boolean>}) {
  const app=new Hono();
  app.post("/mail-call",bodyLimit({maxSize:16_384,onError:c=>c.json({error:"Request is too large"},413)}),async c=>{
    const owner=await options.resolveUserId(c);if(!owner)return c.json({error:"Unauthorized"},401);
    if(c.req.header(INTEGRATION_READ_SCOPE_HEADER)==="read"||!options.authorizeInternal||!await options.authorizeInternal(c))return c.json({error:"Forbidden"},403);
    let raw:unknown;try{raw=await c.req.json();}catch(error){if(!(error instanceof SyntaxError))console.warn("[mail] Invalid call body",error instanceof Error?error.name:"UnknownError");return c.json({error:"Invalid request"},400);}
    const parsed=Body.safeParse(raw);if(!parsed.success||parsed.data.binding.service!=="gmail")return c.json({error:"Invalid request"},400);
    const {binding,operation}=parsed.data;
    try {
      const connections=await options.db.listConnectedServices(owner);
      const matched=connections.filter(row=>row.id===binding.connectionId&&row.service==="gmail"&&row.user_id===owner&&row.status==="active"&&row.account_label===binding.accountLabel&&row.account_email===binding.expectedEmail);
      if(matched.length!==1)return c.json({error:"Forbidden"},403);
      const user=await options.db.getUserById(owner),call=options.pipedream.boundedMail;
      if(!user?.pipedream_external_id||!call)return c.json({error:"Email source is unavailable"},503);
      const identity={externalUserId:user.pipedream_external_id,accountId:matched[0]!.pipedream_account_id};
      if(operation.action==="modify_message") {
        const profile=z.object({emailAddress:z.email()}).parse(await call({...identity,action:"get_profile",params:{}},c.req.raw.signal));
        if(profile.emailAddress.toLowerCase()!==binding.expectedEmail?.toLowerCase())return c.json({error:"Forbidden"},403);
        // Recheck revocation after the live profile read and immediately before dispatch.
        const latest=(await options.db.listConnectedServices(owner)).find(row=>row.id===binding.connectionId);
        if(!latest||latest.service!=="gmail"||latest.account_label!==binding.accountLabel||latest.status!=="active"||latest.user_id!==owner||latest.account_email!==binding.expectedEmail||latest.pipedream_account_id!==identity.accountId)return c.json({error:"Forbidden"},403);
      }
      return c.json(await call({...identity,...operation},c.req.raw.signal));
    }catch(error){
      if(error instanceof MailConnectorError&&error.code==="content_limit")return c.json({error:"Email content exceeds the retention limit",code:"content_limit"},413);
      if(error instanceof MailConnectorError&&error.code==="history_expired")return c.json({error:"Email sync needs reconciliation",code:"history_expired"},409);
      console.warn("[mail] Source call failed",error instanceof Error?error.name:"UnknownError");return c.json({error:"Email source is unavailable"},503);
    }
  });
  return app;
}
