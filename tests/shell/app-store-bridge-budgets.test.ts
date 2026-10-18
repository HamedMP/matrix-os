import {expect,it,vi} from 'vitest';
import {readAppBridgeResponse,appBridgeTimeoutMs} from '../../shell/src/components/app-capability-request.js';
import {createNativeAppTrustResolver} from '../../desktop/src/main/embeds/native-app-trust.js';
import {createStoreClient} from '../../home/apps/app-gallery/src/store-model.js';
import {listing} from '../default-apps/app-store-fixtures.js';
const id='11111111-1111-4111-8111-111111111111';
it('reads a bounded 512KiB source preview including JSON escaping without widening ordinary bridges',async()=>{
 const value={path:'source.txt',content:'\u0001'.repeat(512*1024)};
 const bound={url:`/api/app-store/review/versions/${id}/file?path=source.txt`,init:{}};
 expect(await readAppBridgeResponse(Response.json(value),bound)).toEqual(value);
 await expect(readAppBridgeResponse(Response.json(value),{url:'/api/bridge/service',init:{}})).rejects.toThrow();
 await expect(readAppBridgeResponse(Response.json({text:'x'.repeat(4*1024*1024)}),bound)).rejects.toThrow();
});
it('uses the shared bounded store deadline on Web submit and install calls',()=>{
 expect(appBridgeTimeoutMs(`/api/app-store/drafts/${id}/submit`)).toBe(120000);
 expect(appBridgeTimeoutMs('/api/app-store/listings/sample-notes/install')).toBe(120000);
 expect(appBridgeTimeoutMs('/api/app-store/status')).toBe(15000);
 expect(appBridgeTimeoutMs('/api/other')).toBe(10000);
});
it('keeps Gallery waiting beyond the trusted host installation deadline',async()=>{
 const gatewayFetch=vi.fn(async(..._args:unknown[])=>({id:listing.id,status:'building'}));
 await createStoreClient({gatewayFetch}).install(listing.slug,listing.currentVersion.id,listing.capabilitiesDigest);
 expect(gatewayFetch.mock.calls[0][2]).toBe(125000);
});
it('resolves only supported migrated nested identities before reading Electron trust',async()=>{
 const fetchFn=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({distribution:{trust:'owner'}}));
 const resolver=createNativeAppTrustResolver({getGatewayOrigin:()=> 'https://gateway.test',getToken:()=> 'fixture',fetchFn});
 expect(await resolver('games/2048')).toBe(true);expect(fetchFn.mock.calls[0][0]).toBe('https://gateway.test/api/apps/2048/manifest');
 expect(await resolver('private/chess')).toBe(false);expect(await resolver('../chess')).toBe(false);expect(fetchFn).toHaveBeenCalledOnce();
});
