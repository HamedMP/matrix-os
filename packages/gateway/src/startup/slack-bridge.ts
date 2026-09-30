import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { SlackBridgeEnvelopeSchema, SlackBridgeAuthorizationSchema, verifySlackBridgeRequest,
  type SlackBridgeEnvelope, type SlackPublicationIdentity } from "@matrix-os/contracts/slack-bridge";
import { CollaborationAuthorizationError, type CollaborationAuthority } from "../collaboration/authority.js";

export function createSlackBridgeRoutes(options:{ownerId:string;token:string;authority:Pick<CollaborationAuthority,"authorize">;
  receive(envelope:SlackBridgeEnvelope):Promise<unknown>;authorizePublication?(input:SlackPublicationIdentity):Promise<boolean>;now?:()=>Date}) {
  const app=new Hono();
  app.onError((error,c)=>{
    if(error instanceof z.ZodError || error instanceof SyntaxError) return c.json({error:"Invalid request"},400);
    if(error instanceof CollaborationAuthorizationError) return c.json({error:"Slack unavailable"},403);
    console.warn("[slack-bridge] request failed",error.name);
    return c.json({error:"Slack unavailable"},503);
  });
  app.use("*",bodyLimit({maxSize:256*1024,onError:c=>c.json({error:"Request too large"},413)}));
  app.use("*",async(c,next)=>{
    const body=await c.req.text();
    if(c.req.method!=="POST" || !await verifySlackBridgeRequest({token:options.token,path:c.req.path,body,
      timestamp:c.req.header("x-matrix-slack-timestamp"),signature:c.req.header("x-matrix-slack-signature"),now:options.now?.()})) {
      return c.json({error:"Unauthorized"},401);
    }
    await next();
  });
  app.post("/api/internal/slack/events",async c=>{
    const envelope=SlackBridgeEnvelopeSchema.parse(await c.req.json());
    if(envelope.ownerId!==options.ownerId) return c.json({error:"Forbidden"},403);
    // The service verifies fresh collaboration authority and durably commits before acknowledging.
    await options.receive(envelope);
    return c.json({accepted:true},202);
  });
  app.post("/api/internal/slack/authorize",async c=>{
    const request=SlackBridgeAuthorizationSchema.parse(await c.req.json());
    if(request.ownerId!==options.ownerId) return c.json({allowed:false});
    const action=request.action==="publish_reply"?"discuss":request.action;
    const context=await options.authority.authorize({scopeId:request.scopeId,actorId:request.actorId,action});
    const allowed=context.ownerId===options.ownerId && context.actorId===request.actorId
      && context.organizationId===request.organizationId && context.scopeId===request.scopeId && context.resourceKind==="project"
      && context.capability===action && context.role!=="viewer"
      && (request.action!=="manage_members" || (context.role==="owner" && context.actorId===options.ownerId));
    if(!allowed || request.action!=="publish_reply") return c.json({allowed});
    if(!options.authorizePublication)return c.json({allowed:false});
    try {
      return c.json({allowed:await options.authorizePublication({organizationId:request.organizationId,actorId:request.actorId,
        scopeId:request.scopeId,appId:request.appId,teamId:request.teamId,eventId:request.eventId,textDigest:request.textDigest})===true});
    } catch(error:unknown) {
      if(error instanceof Error && "code" in error && ["forbidden","not_found","conflict"].includes(String(error.code)))return c.json({allowed:false});
      throw error;
    }
  });
  return app;
}
