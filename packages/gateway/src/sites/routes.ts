import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { join, sep } from 'node:path';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { SiteMetadataSchema, SitePublishRequestSchema, SiteSubmissionsQuerySchema, SiteRollbackSchema, SitePublishingSchema, type SiteRecord } from '@matrix-os/contracts';
import { requireRequestPrincipal, isRequestPrincipalError } from '../request-principal.js';
import { resolveAppBySlug } from '../app-runtime/app-index.js';
import { BuildOrchestrator } from '../app-runtime/build-orchestrator.js';
import { parseManifest, type AppManifest } from '../app-runtime/manifest-schema.js';
import { collectSiteFiles } from './bundle.js';
import { SitePlatformError, type SitePlatformClient } from './platform-client.js';
import type { SiteSubmissionRepository } from './submission-repository.js';
const Slug=z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const Paging=SiteSubmissionsQuerySchema;
const MAX_PUBLISH_MANIFEST_BYTES=1024*1024;
interface AppDirectoryBinding {path:string;dev:bigint;ino:bigint}
function publicationInputs(manifest:AppManifest){
 return {slug:manifest.slug,runtime:manifest.runtime,runtimeVersion:manifest.runtimeVersion,
  scope:manifest.scope,build:manifest.build,publishing:SitePublishingSchema.parse(manifest.publishing??{})};
}
async function sameAppDirectory(appDir:string,binding:AppDirectoryBinding):Promise<boolean>{
 if(await realpath(appDir)!==binding.path)return false;
 const current=await stat(binding.path,{bigint:true});
 return current.isDirectory()&&current.dev===binding.dev&&current.ino===binding.ino;
}
/** Read the actual file, never the app-index cache, at both asynchronous boundaries. */
async function livePublicationMatches(appDir:string,binding:AppDirectoryBinding,expected:AppManifest):Promise<boolean>{
 try{
  if(!await sameAppDirectory(appDir,binding))return false;
  // Nonblocking open lets the regular-file check reject FIFOs before any read can wait.
  const handle=await open(join(binding.path,'matrix.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let raw:string;
  try{
   const info=await handle.stat();if(!info.isFile()||info.size>MAX_PUBLISH_MANIFEST_BYTES)return false;
   const chunks:Buffer[]=[];let bytes=0;
   // The inclusive end also detects growth beyond the cap after stat().
   const stream=handle.createReadStream({start:0,end:MAX_PUBLISH_MANIFEST_BYTES,autoClose:false,signal:AbortSignal.timeout(5000)});
   for await(const chunk of stream){bytes+=chunk.length;if(bytes>MAX_PUBLISH_MANIFEST_BYTES)return false;chunks.push(chunk);}
   raw=Buffer.concat(chunks,bytes).toString('utf8');
  }finally{await handle.close();}
  const parsed=await parseManifest(JSON.parse(raw));
  return parsed.ok&&isDeepStrictEqual(publicationInputs(parsed.manifest),publicationInputs(expected))&&await sameAppDirectory(appDir,binding);
 }catch(error){console.warn('[sites] Manifest revalidation failed',error instanceof Error?error.name:'UnknownError');return false;}
}
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
  if(activeBuilds>=4)return c.json({error:'Too many requests'},429);
  activeBuilds++;
  try{
   const resolved=await resolveAppBySlug(join(options.homePath,'apps'),c.req.param('slug'));if(!resolved.ok)return c.json({error:'App not found'},404);
   const {manifest,appDir}=resolved.entry;
   const [appsReal,appReal]=await Promise.all([realpath(join(options.homePath,'apps')),realpath(appDir)]);
   if(!appReal.startsWith(appsReal+sep))return c.json({error:'Site changed; reload and try again'},409);
   const info=await stat(appReal,{bigint:true}),binding={path:appReal,dev:info.dev,ino:info.ino};
   if(manifest.runtime!=='vite'||manifest.scope!=='personal'||!manifest.build)return c.json({error:'App needs a public build'},400);
   const config=SitePublishingSchema.parse(manifest.publishing??{});
   if(config.forms.length&&!options.submissions)return c.json({error:'Site unavailable'},503);
   const {reviewedConfig,...metadata}=parsed.data as z.infer<typeof SitePublishRequestSchema>;
   if(!isDeepStrictEqual(config,reviewedConfig))return c.json({error:'Site changed; reload and try again'},409);
   const result=await build.build(manifest.slug,appDir,{timeoutMs:120000});if(!result.ok)return c.json({error:'App needs a public build'},400);
   if(!await livePublicationMatches(appDir,binding,manifest))return c.json({error:'Site changed; reload and try again'},409);
   let files;
   try{files=await collectSiteFiles(binding.path,manifest.build.output);}catch(error){console.warn('[sites] Production artifact rejected',error instanceof Error?error.name:'UnknownError');return c.json({error:'App needs a public build'},400);}
   if(!await livePublicationMatches(appDir,binding,manifest))return c.json({error:'Site changed; reload and try again'},409);
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
