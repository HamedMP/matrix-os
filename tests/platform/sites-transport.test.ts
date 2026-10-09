import {createHmac} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createTestPlatformDb,destroyTestPlatformDb} from './platform-db-test-helper.js';
import {insertUserMachine,type PlatformDB} from '../../packages/platform/src/db.js';
import {buildPlatformSyncVerificationToken,buildPlatformVerificationToken} from '../../packages/platform/src/platform-token.js';
import {createSitesService} from '../../packages/platform/src/sites/service.js';
import {createSitePublicRoutes} from '../../packages/platform/src/sites/public-routes.js';
import {createSiteSubmissionTransport} from '../../packages/platform/src/sites/submission-transport.js';
let db:PlatformDB;
const identity={handle:'event-host',machineId:'b3346b7a-3c41-47d5-b0c1-4209aef7b00c',runtimeSlot:'secondary'};
const secret='sites-scoped-platform-secret-123456789';
beforeAll(async()=>{db=(await createTestPlatformDb()).db;await insertUserMachine(db,{...identity,clerkUserId:'user_event_host',runtimeTokenEpoch:3,status:'running',publicIPv4:'93.184.216.34',provisionedAt:new Date().toISOString()});});
afterAll(async()=>{await destroyTestPlatformDb(db);});
it('signs the full public submission capability with current machine/slot/epoch credential',async()=>{
 const service=createSitesService({db,storage:{async putObject(){return {};},async getObject(){return {body:null};}}});
 const site=await service.deploy({ownerId:'user_event_host',machineId:identity.machineId,appSlug:'event'},
  {title:'Event',config:{forms:[{id:'rsvp',title:'RSVP',fields:{email:{type:'email',required:true}}}]},files:[{path:'index.html',contentType:'text/html',body:Buffer.from('Event').toString('base64')}]});
 const forward=vi.fn(async()=>Response.json({accepted:true}));vi.stubGlobal('fetch',forward);
 try {
  const app=createSitePublicRoutes({service,edgeSecret:'verified-edge-proof-secret-1234567890',submit:createSiteSubmissionTransport({platformSecret:secret})});
  const result=await app.request(`/${site.id}/forms/rsvp`,{method:'POST',headers:{'x-matrix-sites-edge':'verified-edge-proof-secret-1234567890','content-type':'application/json'},body:JSON.stringify({fields:{email:'guest@example.com'},idempotencyKey:'stable-rsvp-request'})});
  expect(result.status).toBe(200);expect(forward).toHaveBeenCalledOnce();
  const [url,init]=forward.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe(`https://93.184.216.34:443/api/internal/sites/${site.id}/submit`);
  const headers=new Headers(init.headers);const body=init.body as string;const payload=`${headers.get('x-matrix-site-timestamp')}.${body}`;
  const actual=headers.get('x-matrix-site-signature');
  expect(actual).toBe(createHmac('sha256',buildPlatformSyncVerificationToken(identity,secret,3)).update(payload).digest('hex'));
  expect(actual).not.toBe(createHmac('sha256',buildPlatformVerificationToken(identity.handle,secret)).update(payload).digest('hex'));
  expect(JSON.parse(body)).toMatchObject({siteId:site.id,appSlug:'event',versionId:site.activeVersion,formId:'rsvp',fields:{email:'guest@example.com'},idempotencyKey:'stable-rsvp-request'});
  expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);
 }finally{vi.unstubAllGlobals();}
});
