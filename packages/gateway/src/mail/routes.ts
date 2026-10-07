import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MailActionRequestSchema, type MailActionRequest } from "@matrix-os/contracts";
import { isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";
export class MailRequestError extends Error {constructor(readonly status:400|403|404|409|503){super('Email action unavailable');}}
export function createMailRoutes(options:{resolveOwner(c:Context):string|null;installed(appId:string):Promise<boolean>;handle(owner:string,request:MailActionRequest,signal:AbortSignal):Promise<unknown>}){
 const app=new Hono();
 app.on('POST',['/action','/read'],bodyLimit({maxSize:16384,onError:c=>c.json({error:'Request is too large'},413)}),async c=>{
  c.header('cache-control','no-store');
  const path=new URL(c.req.raw.url).pathname;if(path.includes('%')||path.endsWith('/'))return c.json({error:'Not found'},404);
  try{
   const owner=options.resolveOwner(c);if(!owner)return c.json({error:'Forbidden'},403);
   let raw:unknown;try{raw=await c.req.json();}catch(error){if(error instanceof SyntaxError)return c.json({error:'Invalid request'},400);throw error;}
   const parsed=MailActionRequestSchema.safeParse(raw);if(!parsed.success)return c.json({error:'Invalid request'},400);
   const request=parsed.data;
   if(c.req.path.endsWith("/read")&&!['sources','messages','message'].includes(request.action))return c.json({error:"Forbidden"},403);
   if((request.appId!=='edition'&&!['sources','messages','message'].includes(request.action))||!await options.installed(request.appId))return c.json({error:'Forbidden'},403);
   const signal=AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(request.action.startsWith('cleanup-')?30000:9000)]);
   return c.json(await options.handle(owner,request,signal) as Record<string,unknown>);
  }catch(error){
   if(error instanceof Error && error.name==='BodyLimitError')return c.json({error:'Request is too large'},413);
   if(isRequestPrincipalError(error)){const mapped=mapRequestPrincipalError(error);return c.json(mapped.body,mapped.status);}
   if(error instanceof MailRequestError)return c.json({error:error.status===409?'Email changed. Refresh and try again.':error.status===403?'Forbidden':'Email action unavailable'},error.status);
   console.error('[mail] Action failed',{errorName:error instanceof Error?error.name:'UnknownError'});return c.json({error:'Email is temporarily unavailable'},503);
  }
 });return app;
}
