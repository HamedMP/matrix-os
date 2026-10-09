import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createSiteRoutes } from './routes.js';
import { createSiteSubmitRoutes } from './submit-routes.js';
import { SiteSubmissionRepository } from './submission-repository.js';
import { createSitePlatformClient } from './platform-client.js';
export async function registerSiteRuntime(app:Hono,options:{homePath:string;db:Kysely<any>|null;platformUrl?:string;handle?:string;env?:NodeJS.ProcessEnv}):Promise<void>{
 const env=options.env??process.env;let submissions:SiteSubmissionRepository|null=null;
 if(options.db){const repository=new SiteSubmissionRepository(options.db);try{await repository.bootstrap();submissions=repository;}catch(error){console.warn('[sites] Submission database unavailable',error instanceof Error?error.name:'UnknownError');}}
 // Already provisioned runtime credential binds machine, slot and rotation epoch.
 const token=env.MATRIX_SYNC_RUNTIME_TOKEN;
 const platform=options.platformUrl&&token&&options.handle?createSitePlatformClient({url:options.platformUrl,token,handle:options.handle,runtimeSlot:env.MATRIX_RUNTIME_SLOT}):null;
 const ownerIds=[env.MATRIX_USER_ID,env.MATRIX_CLERK_USER_ID].filter((id):id is string=>Boolean(id));
 app.route('/',createSiteRoutes({homePath:options.homePath,ownerIds,platform,submissions}));
 app.route('/',createSiteSubmitRoutes({serviceSecret:token,submissions}));
}
