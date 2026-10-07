import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,readdir,readFile,lstat,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeAppBridge} from '@desktop/main/embeds/native-app-bridge';
import {createMailDeviceStore,startMailDeviceStore} from '@desktop/main/persistence/mail-device-store';
const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});vi.restoreAllMocks();});
const raw=JSON.stringify({messages:[],sources:[],pending:[]});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'mail-device-'));dirs.push(dir);let status={signedIn:true,userId:'owner-a',runtimeSlot:'one',authGeneration:1};let origin='https://gateway-a.test';const auth={getStatus:()=>status,getGatewayOrigin:()=>origin};return{dir,auth,setStatus:(next:typeof status)=>{status=next;},setOrigin:(next:string)=>{origin=next;}};}
it('persists private validated atomic downloads and clears old owner/runtime scope',async()=>{
 const f=await fixture();const store=createMailDeviceStore({dir:f.dir,auth:f.auth});await store.initialize();
 await store.request({action:'save',raw},()=>true);const first=await store.request({action:'load'},()=>true) as {scope:string;raw:string|null};expect(first.raw).toBe(raw);expect(first.scope).not.toContain('owner-a');
 const folder=join(f.dir,'edition-downloads');expect((await lstat(folder)).mode&0o777).toBe(0o700);expect((await lstat(join(folder,'cache.json'))).mode&0o777).toBe(0o600);expect(await readdir(folder)).toEqual(['cache.json']);
 await expect(store.request({action:'save',raw:JSON.stringify({messages:[],sources:[],pending:Array.from({length:101},()=>({id:'one',baseRevision:0,read:true}))})},()=>true)).rejects.toThrow();
 f.setStatus({signedIn:true,userId:'owner-b',runtimeSlot:'one',authGeneration:2});await store.authChanged();const next=await store.request({action:'load'},()=>true) as typeof first;expect(next.scope).not.toBe(first.scope);expect(next.raw).toBeNull();
 await store.request({action:'save',raw},()=>true);f.setOrigin('https://gateway-b.test');await store.authChanged();expect((await store.request({action:'load'},()=>true) as typeof first).raw).toBeNull();await store.dispose();
});
it('drops queued old-generation writes before publication on logout and bounds pending work',async()=>{
 const f=await fixture();let resume!:()=>void;let entered!:()=>void;const start=new Promise<void>(resolve=>{entered=resolve;});const wait=new Promise<void>(resolve=>{resume=resolve;});
 const store=createMailDeviceStore({dir:f.dir,auth:f.auth,beforePublish:async()=>{entered();await wait;}});await store.initialize();
 const pending=store.request({action:'save',raw},()=>true);const refused=expect(pending).rejects.toThrow();await start;
 const queued=Array.from({length:7},()=>store.request({action:'save',raw},()=>true).catch(()=>undefined));await expect(store.request({action:'load'},()=>true)).rejects.toThrow();
 f.setStatus({signedIn:false,userId:'owner-a',runtimeSlot:'one',authGeneration:2});const cleaned=store.authChanged();resume();await refused;await Promise.all(queued);await cleaned;
 expect(await readdir(join(f.dir,'edition-downloads'))).toEqual([]);await expect(store.request({action:'load'},()=>true)).rejects.toThrow();await store.dispose();
});
it('rejects symbolic links and cleans interrupted atomic files without touching unrelated files',async()=>{
 const f=await fixture();const store=createMailDeviceStore({dir:f.dir,auth:f.auth});await store.initialize();const folder=join(f.dir,'edition-downloads');await writeFile(join(folder,'.cache-0123456789abcdef0123456789abcdef.tmp'),'old');await writeFile(join(folder,'keep.txt'),'keep');await store.dispose();
 const reopened=createMailDeviceStore({dir:f.dir,auth:f.auth});await reopened.initialize();expect(await readdir(folder)).toEqual(['keep.txt']);await reopened.dispose();
 await symlink(join(folder,'keep.txt'),join(folder,'cache.json'));const linked=createMailDeviceStore({dir:f.dir,auth:f.auth});await expect(linked.initialize()).rejects.toThrow();expect(await readFile(join(folder,'keep.txt'),'utf8')).toBe('keep');await linked.dispose();
});
it('authorizes only registered exact Edition route and rechecks sender after asynchronous writes',async()=>{
 let generation=1;const store={request:vi.fn(async(_request:unknown,allowed:()=>boolean)=>{expect(allowed()).toBe(true);generation++;if(!allowed())throw new Error('not authorized');})};
 const bridge=new NativeAppBridge({authGeneration:()=>generation,gatewayOrigin:()=> 'https://gateway.test',generate:vi.fn(),aiRequest:vi.fn(),gatewayRequest:vi.fn(),request:vi.fn(),deviceStore:store});
 bridge.register(42,'edition');const sender={id:42,url:'https://gateway.test/apps/edition/'};
 await expect(bridge.mailDownloads(sender,{action:'load',scope:'forged'})).rejects.toThrow();expect(store.request).not.toHaveBeenCalled();
 bridge.register(43,'folio');await expect(bridge.mailDownloads({id:43,url:'https://gateway.test/apps/folio/'},{action:'load'})).rejects.toThrow();
 bridge.register(44,'edition','pretend');await expect(bridge.mailDownloads({id:44,url:'https://gateway.test/apps/pretend/'},{action:'load'})).rejects.toThrow();
 await expect(bridge.mailDownloads({...sender,url:'https://other.test/apps/edition/'},{action:'load'})).rejects.toThrow();
 await expect(bridge.mailDownloads(sender,{action:'load'})).rejects.toThrow();expect(store.request).toHaveBeenCalledTimes(1);
});
it('IPC rejects subframes and unregistering a sender while an article load is pending',async()=>{
 let finish!:(value:unknown)=>void;let entered!:()=>void;const start=new Promise<void>(resolve=>{entered=resolve;});const result=new Promise(resolve=>{finish=resolve;});
 const store={request:vi.fn(async()=>{entered();return result;})};const bridge=new NativeAppBridge({authGeneration:()=>1,gatewayOrigin:()=> 'https://gateway.test',generate:vi.fn(),aiRequest:vi.fn(),gatewayRequest:vi.fn(),request:vi.fn(),deviceStore:store});bridge.register(42,'edition');
 const handlers=new Map<string,Function>();bridge.registerIpc({handle:(channel:string,handler:Function)=>{handlers.set(channel,handler);}} as never);
 const main={};const sender={id:42,mainFrame:main,isDestroyed:()=>false,getURL:()=> 'https://gateway.test/apps/edition/'};const handle=handlers.get('native-app:mail-downloads')!;
 await expect(handle({sender,senderFrame:{}},{action:'load'})).rejects.toThrow(/^Downloads unavailable$/);expect(store.request).not.toHaveBeenCalled();
 const pending=handle({sender,senderFrame:main},{action:'load'});const refused=expect(pending).rejects.toThrow(/^Downloads unavailable$/);await start;bridge.unregister(42);finish({scope:'a'.repeat(64),raw:'private'});await refused;
});
it('keeps downloads on same-owner restart but erases them when starting signed out',async()=>{
 const f=await fixture();const first=createMailDeviceStore({dir:f.dir,auth:f.auth});await first.initialize();await first.request({action:'save',raw},()=>true);await first.dispose();
 const second=createMailDeviceStore({dir:f.dir,auth:f.auth});await second.initialize();expect((await second.request({action:'load'},()=>true) as {raw:string}).raw).toBe(raw);await second.dispose();
 f.setStatus({signedIn:false,userId:'owner-a',runtimeSlot:'one',authGeneration:2});const third=createMailDeviceStore({dir:f.dir,auth:f.auth});await third.initialize();expect(await readdir(join(f.dir,'edition-downloads'))).toEqual([]);await third.dispose();
});
it('recovers only a malformed private cache file on startup',async()=>{
 const f=await fixture();const store=createMailDeviceStore({dir:f.dir,auth:f.auth});await store.initialize();await store.dispose();await writeFile(join(f.dir,'edition-downloads','cache.json'),'{broken');
 const reopened=createMailDeviceStore({dir:f.dir,auth:f.auth});await reopened.initialize();expect((await reopened.request({action:'load'},()=>true) as {raw:string|null}).raw).toBeNull();await reopened.dispose();
});

it('optional startup cache failure disposes downloads and preserves the core native app bridge',async()=>{
 const f=await fixture();await symlink(f.dir,join(f.dir,'edition-downloads'));const candidate=createMailDeviceStore({dir:f.dir,auth:f.auth});const dispose=vi.spyOn(candidate,'dispose');const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
 const store=await startMailDeviceStore(candidate);expect(store).toBeNull();expect(dispose).toHaveBeenCalledTimes(1);expect(JSON.stringify(warn.mock.calls)).not.toContain(f.dir);
 const query=vi.fn(async()=>[]);const bridge=new NativeAppBridge({authGeneration:()=>1,gatewayOrigin:()=> 'https://gateway.test',generate:vi.fn(),aiRequest:vi.fn(),gatewayRequest:vi.fn(),request:query,deviceStore:store??undefined});bridge.register(42,'edition');const sender={id:42,url:'https://gateway.test/apps/edition/'};
 await expect(bridge.query(sender,{action:'find',table:'records'})).resolves.toEqual([]);await expect(bridge.mailDownloads(sender,{action:'load'})).rejects.toThrow(/^Downloads unavailable$/);
});
