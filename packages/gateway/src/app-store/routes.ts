import {Hono,type Context} from 'hono';import {bodyLimit} from 'hono/body-limit';import {z} from 'zod/v4';
import * as C from '@matrix-os/contracts/app-store';import * as G from '@matrix-os/contracts/app-store-gateway';
import {validateBundlePath} from '@matrix-os/contracts/app-store-bundle';
import {requireRequestPrincipal,isRequestPrincipalError,mapRequestPrincipalError} from '../request-principal.js';
import {isFsError} from '../app-gallery/pinned-directory.js';
import {StoreError,type AppStorePlatformClient} from './platform-client.js';import type {StorePublishService} from './publish-service.js';
import type {StoreInstallService} from './install-service.js';
function query(c:Context):Record<string,string>{const params=new URL(c.req.url).searchParams;if([...params.keys()].length!==new Set(params.keys()).size)throw new StoreError('invalid');return Object.fromEntries(params);}
export function registerAppStoreRoutes(app:Hono,options:{homePath:string;ownerIds:readonly string[];platform?:AppStorePlatformClient;publish?:StorePublishService;install?:StoreInstallService}):void{
 const routes=new Hono();
 routes.use('*',async(c,next)=>{try{const principal=requireRequestPrincipal(c,{isLocalDevelopment:false});if(!options.ownerIds.includes(principal.userId))throw new StoreError('forbidden');await next();}catch(error:unknown){return failed(c,error);}});
 const failed=(c:Context,error:unknown)=>{
  if(isRequestPrincipalError(error)){const mapped=mapRequestPrincipalError(error);return c.json({error:mapped.status===401?'unauthorized':mapped.status>=500?'unavailable':'forbidden'},mapped.status);}
  if(error instanceof z.ZodError||error instanceof SyntaxError)return c.json({error:'invalid'},400);
  if(isFsError(error,'ENOENT'))return c.json({error:'not_found'},404);
  const code=error instanceof StoreError?error.code:'unavailable';const status={invalid:400,unauthorized:401,forbidden:403,not_found:404,conflict:409,limit:429,unavailable:503}[code];
  if(code==='unavailable')console.warn('[app-store] Request failed',error instanceof Error?error.name:'UnknownError');return c.json({error:code},status as 400|401|403|404|409|429|503);
 };
 const platform=()=>{if(!options.platform)throw new StoreError();return options.platform;};
 const publish=()=>{if(!options.publish)throw new StoreError();return options.publish;};
 const install=()=>{if(!options.install)throw new StoreError();return options.install;};
 const id=(c:Context,key='id')=>C.AppStoreIdSchema.parse(c.req.param(key));const slug=(c:Context)=>C.AppStoreSlugSchema.parse(c.req.param('slug'));
 const get=(path:string,handle:(c:Context)=>Promise<unknown>)=>routes.get(path,async c=>{try{return c.json(await handle(c));}catch(error:unknown){return failed(c,error);}});
 const post=<T>(path:string,schema:z.ZodType<T>,handle:(c:Context,input:T)=>Promise<unknown>,status:200|201|202=200)=>routes.post(path,bodyLimit({maxSize:16_384,onError:c=>c.json({error:'limit'},413)}),async c=>{try{return c.json(await handle(c,schema.parse(await c.req.json())),status);}catch(error:unknown){return failed(c,error);}});
 const Empty=z.strictObject({});const Cursor=z.strictObject({cursor:z.string().max(200).optional()});
 get('/status',async()=>({...await platform().status(),...(options.publish?{generalizer:await publish().generalizerStatus()}: {})}));
 get('/publishable-apps',async()=>({apps:await publish().publishableApps()}));get('/drafts',async()=>({drafts:await publish().list()}));
 post('/drafts',G.AppStoreCreateDraftSchema,(_c,input)=>publish().create(input),201);
 get('/drafts/:id',c=>publish().detail(id(c)));
 get('/drafts/:id/diff',c=>{const input=G.AppStoreDraftDiffQuerySchema.parse(query(c));validateBundlePath(input.path,'source');return publish().diff(id(c),input.path);});
 post('/drafts/:id/revise',G.AppStoreReviseDraftSchema,(c,input)=>publish().revise(id(c),input),202);
 post('/drafts/:id/listing',G.AppStoreListingDraftPatchSchema,(c,input)=>publish().listing(id(c),input));
 post('/drafts/:id/submit',G.AppStoreSubmitDraftSchema,(c,input)=>publish().submit(id(c),input));
 post('/drafts/:id/delete',Empty,c=>publish().delete(id(c)));
 get('/submissions',c=>{const parsed=Cursor.parse(query(c));return platform().request('submissions',C.AppStoreSubmissionsPageSchema,{query:parsed});});
 post('/submissions/:id/withdraw',Empty,c=>platform().withdraw(id(c)));
 get('/listings',c=>install().catalog(C.AppStoreCatalogQuerySchema.parse(query(c))));
 get('/listings/:slug',c=>install().detail(slug(c)));
 routes.get('/listings/:slug/icon',async c=>{try{const icon=await platform().icon(slug(c));return new Response(new Uint8Array(icon.bytes),{headers:{'content-type':icon.type,'content-security-policy':"default-src 'none'",'x-content-type-options':'nosniff','cache-control':'private, max-age=300'}});}catch(error:unknown){return failed(c,error);}});
 post('/listings/:slug/install',G.AppStoreInstallRequestSchema,(c,input)=>install().start(slug(c),input),202);
 get('/installs/:id',c=>install().job(id(c)));
 post('/listings/:slug/rating',G.AppStoreGatewayRatingInputSchema,(c,input)=>platform().rate(slug(c),input.stars));
 get('/review/queue',c=>platform().reviewQueue(C.AppStoreReviewQueueQuerySchema.parse(query(c))));
 get('/review/versions/:id',c=>platform().reviewDetail(id(c)));
 get('/review/versions/:id/file',c=>platform().reviewFile(id(c),C.AppStoreReviewFileQuerySchema.parse(query(c))));
 post('/review/versions/:id/decision',C.AppStoreReviewDecisionSchema,(c,input)=>platform().reviewDecision(id(c),input));
 post('/review/listings/:id/action',C.AppStoreListingActionSchema,(c,input)=>platform().listingAction(id(c),input));
 app.route('/api/app-store',routes);
}
