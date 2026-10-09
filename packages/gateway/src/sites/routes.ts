import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { join } from 'node:path';
import { SiteMetadataSchema, SitePublishRequestSchema, SiteSubmissionsQuerySchema, SiteRollbackSchema, SitePublishingSchema, type SiteRecord } from '@matrix-os/contracts';
import { requireRequestPrincipal, isRequestPrincipalError } from '../request-principal.js';
import { resolveAppBySlug } from '../app-runtime/app-index.js';
import { BuildOrchestrator } from '../app-runtime/build-orchestrator.js';
import { collectSiteFiles } from './bundle.js';
import { SitePlatformError, type SitePlatformClient } from './platform-client.js';
import type { SiteSubmissionRepository } from './submission-repository.js';
const Slug=z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const Paging=SiteSubmissionsQuerySchema;
export interface SiteRouteOptions {homePath:string;ownerIds:readonly string[];platform:SitePlatformClient|null;submissions:SiteSubmissionRepository|null;build?:Pick<BuildOrchestrator,'build'>}
export function createSiteRoutes(options:SiteRouteOptions):Hono {
 const app=new Hono(),build=options.build??new BuildOrchestrator({concurrency:1});let activeBuilds=0;
 const base='/api/apps/:slug/site',limit=bodyLimit({maxSize:16*1024,onError:c=>c.json({error:'Too many requests'},413)});
 async function owner(c:Context):Promise<Response|undefined>{
  const slug=Slug.safeParse(c.req.param('slug'));if(!slug.success)return c.json({error:'Invalid request'},400);
  try{const principal=requireRequestPrincipal(c);if(!options.ownerIds.length)return c.json({error:'Site unavailable'},503);if(!options.ownerIds.includes(principal.userId))return c.json({error:'Forbidden'},403);}
  catch(error){if(isRequestPrincipalError(error))return c.json({error:'Unauthorized'},401);throw error;}
  if(!options.platform)return c.json({error:'Site unavailable'},503);
 }
 app.use(base,async(c,next)=>{const error=await owner(c);if(error)return error;await next();});
 app.use(base+'/*',async(c,next)=>{const error=await owner(c);if(error)return error;await next();});
 app.onError((error,c)=>{console.warn('[sites] Owner request failed',error.name);return c.json({error:'Site unavailable'},503);});
 async function call(c:Context,method:string,body?:unknown,child=''):Promise<Response>{
  try{const site=await options.platform!.request(c.req.param('slug')!,method,body,child);return site?c.json(site):c.json({error:'Site not found'},404);}
  catch(error){if(error instanceof SitePlatformError)return c.json({error:error.status===409?'Site changed; reload and try again':error.status===400?'Invalid request':'Site unavailable'},error.status);throw error;}
 }
 async function body(c:Context,schema:z.ZodType){try{return schema.safeParse(await c.req.json());}catch(error){if(error instanceof SyntaxError)return {success:false as const};throw error;}}
 app.get(base,c=>call(c,'GET'));
 app.post(base,bodyLimit({maxSize:80*1024,onError:c=>c.json({error:'Too many requests'},413)}),async c=>{
  const parsed=await body(c,SitePublishRequestSchema);if(!parsed.success)return c.json({error:'Invalid request'},400);
  if(!options.submissions)return c.json({error:'Site unavailable'},503);
  if(activeBuilds>=4)return c.json({error:'Too many requests'},429);
  activeBuilds++;
  try{
   const resolved=await resolveAppBySlug(join(options.homePath,'apps'),c.req.param('slug'));if(!resolved.ok)return c.json({error:'App not found'},404);
   const {manifest,appDir}=resolved.entry;if(manifest.runtime!=='vite'||manifest.scope!=='personal'||!manifest.build)return c.json({error:'App needs a public build'},400);
   const config=SitePublishingSchema.parse(manifest.publishing??{});
   const {reviewedConfig,...metadata}=parsed.data as z.infer<typeof SitePublishRequestSchema>;
   if(JSON.stringify(config)!==JSON.stringify(reviewedConfig))return c.json({error:'Site changed; reload and try again'},409);
   const result=await build.build(manifest.slug,appDir,{timeoutMs:120000});if(!result.ok)return c.json({error:'App needs a public build'},400);
   let files;
   try{files=await collectSiteFiles(appDir,manifest.build.output);}catch(error){console.warn('[sites] Production artifact rejected',error instanceof Error?error.name:'UnknownError');return c.json({error:'App needs a public build'},400);}
   return await call(c,'POST',{title:manifest.name,description:manifest.description??'',...metadata,config,files});
  }finally{activeBuilds--;}
 });
 app.patch(base,limit,async c=>{const parsed=await body(c,SiteMetadataSchema);return parsed.success?call(c,'PATCH',parsed.data):c.json({error:'Invalid request'},400);});
 app.delete(base,limit,async c=>{const parsed=await body(c,z.object({baseRevision:z.number().int().min(0)}));return parsed.success?call(c,'DELETE',parsed.data):c.json({error:'Invalid request'},400);});
 app.post(base+'/rollback',limit,async c=>{const parsed=await body(c,SiteRollbackSchema);return parsed.success?call(c,'POST',parsed.data,'/rollback'):c.json({error:'Invalid request'},400);});
 async function publication(c:Context):Promise<SiteRecord|null>{return options.platform!.request(c.req.param('slug')!,'GET');}
 app.get(base+'/submissions',async c=>{
  const parsed=Paging.safeParse(c.req.query());if(!parsed.success)return c.json({error:'Invalid request'},400);
  if(!options.submissions)return c.json({error:'Submission unavailable'},503);const site=await publication(c);if(!site)return c.json({error:'Site not found'},404);
  const result=await options.submissions.list(site.id,c.req.param('slug')!,parsed.data.limit,parsed.data.cursor??null);return c.json({submissions:result.items,nextCursor:result.nextCursor});
 });
 app.get(base+'/submissions/export',async c=>{
  const parsed=Paging.safeParse(c.req.query());if(!parsed.success)return c.json({error:'Invalid request'},400);
  if(!options.submissions)return c.json({error:'Submission unavailable'},503);const site=await publication(c);if(!site)return c.json({error:'Site not found'},404);
  const result=await options.submissions.list(site.id,c.req.param('slug')!,parsed.data.limit,parsed.data.cursor??null);c.header('Content-Disposition','attachment; filename="submissions.json"');return c.json({submissions:result.items,nextCursor:result.nextCursor});
 });
 app.delete(base+'/submissions/:id',limit,async c=>{
  const parsed=z.uuid().safeParse(c.req.param('id'));if(!parsed.success)return c.json({error:'Invalid request'},400);
  if(!options.submissions)return c.json({error:'Submission unavailable'},503);const site=await publication(c);if(!site)return c.json({error:'Site not found'},404);
  const deleted=await options.submissions.delete(site.id,c.req.param('slug')!,parsed.data);return deleted?c.json({ok:true}):c.json({error:'Submission not found'},404);
 });
 return app;
}
