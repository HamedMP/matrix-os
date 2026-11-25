import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createSiteRoutes } from './routes.js';
import { createSiteSubmitRoutes } from './submit-routes.js';
import { SiteSubmissionRepository } from './submission-repository.js';
import { createSitePlatformClient } from './platform-client.js';
import { bootstrapSiteDatabase, bootstrapSiteSubmissionDatabase } from './bootstrap.js';
import { SitePublicDataRepository, type SitePublicAppRecord } from './public-data-repository.js';
import { createSitePublicDataRoutes } from './public-data-routes.js';
export interface SitePublicDataWiring {
 resolveApp(appSlug:string):Promise<SitePublicAppRecord|null>;
 onChange(change:{app:string;key:string}):void;
}
async function optionalSetup(label:string,env:NodeJS.ProcessEnv,owned:(url:string)=>Promise<void>,injected:()=>Promise<void>):Promise<boolean>{
 try{
  // Production ownerDatabase is created from this same DATABASE_URL in startup/owner-database.
  // Keep optional DDL on an owned bounded connection, without changing shared query behavior.
  if(env.DATABASE_URL)await owned(env.DATABASE_URL);
  else{
   if(env.NODE_ENV==='production')throw new Error('Site setup database unavailable');
   // Injected development/test dialects own acquisition/read deadlines and resource cleanup.
   await injected();
  }
  return true;
 }catch(error){console.warn(`[sites] ${label} database unavailable`,error instanceof Error?error.name:'UnknownError');return false;}
}
export async function registerSiteRuntime(app:Hono,options:{homePath:string;db:Kysely<any>|null;platformUrl?:string;handle?:string;env?:NodeJS.ProcessEnv;publicData?:SitePublicDataWiring}):Promise<void>{
 const env=options.env??process.env;let submissions:SiteSubmissionRepository|null=null;let publicData:SitePublicDataRepository|null=null;
 if(options.db){
  const db=options.db;
  const repository=new SiteSubmissionRepository(db);
  if(await optionalSetup('Submission',env,bootstrapSiteSubmissionDatabase,()=>repository.bootstrap()))submissions=repository;
  if(options.publicData&&await optionalSetup('Public data',env,url=>bootstrapSiteDatabase(url,SitePublicDataRepository.bootstrap),()=>SitePublicDataRepository.bootstrap(db))){
   publicData=new SitePublicDataRepository(db,{resolveApp:options.publicData.resolveApp});
  }
 }
 // Already provisioned runtime credential binds machine, slot and rotation epoch.
 const token=env.MATRIX_SYNC_RUNTIME_TOKEN;
 const platform=options.platformUrl&&token&&options.handle?createSitePlatformClient({url:options.platformUrl,token,handle:options.handle,runtimeSlot:env.MATRIX_RUNTIME_SLOT}):null;
 const ownerIds=[env.MATRIX_USER_ID,env.MATRIX_CLERK_USER_ID].filter((id):id is string=>Boolean(id));
 app.route('/',createSiteRoutes({homePath:options.homePath,ownerIds,platform,submissions}));
 app.route('/',createSiteSubmitRoutes({serviceSecret:token,submissions}));
 app.route('/',createSitePublicDataRoutes({serviceSecret:token,repository:publicData,env,...(options.publicData?{onChange:options.publicData.onChange}:{})}));
}
