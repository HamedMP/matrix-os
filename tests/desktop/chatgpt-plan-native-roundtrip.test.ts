import { describe, expect, it, vi } from 'vitest';
import { fixture, request, session } from './chatgpt-plan-roundtrip-support';
describe('native subscription authorization to signed peer transport (explicit mocked issuer)',()=>{
 it('pins nonprimary native bridge traffic to the selected Computer runtime',async()=>{
  const x=await fixture('preview');try{
   await x.signedIn();const status=await x.service.setGrant({runtimeSlot:'preview',authGeneration:1,enabled:true,background:false});
   x.queue([request('00000000-0000-4000-8000-000000000009',status.account!.id,status.grant.revision)]);
   await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(true);
  }finally{await x.cleanup();}
 });
 it('connect authorizes interactive Bots and completes local OAuth-only inference by default',async()=>{
  const x=await fixture();try{
   await x.signedIn();const status=await x.service.status(session);expect(status.grant).toMatchObject({enabled:true,background:false});expect(status.models.map(x=>x.id)).toEqual(['fixture-visible']);
   expect(status.bridgeConnected).toBe(true);
   x.queue([request('00000000-0000-4000-8000-000000000002',status.account!.id,status.grant.revision)]);
   await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(true);expect(x.providerBodies).toHaveLength(1);expect(x.providerBodies[0]).toMatchObject({store:false,stream:true});
   expect(x.snapshots[0]).toMatchObject({enabled:true,background:false});
  }finally{await x.cleanup();}
 });
 it('reuses only the active account on explicit reconnect, leaving reads and other Computer grants unchanged',async()=>{
  const x=await fixture();try{
   await x.signedIn();const before=await x.service.setGrant({...session,enabled:false,background:false});
   let stored=await x.vault.load('owner');stored.grants.push({computerId:'other-computer',revision:7,enabled:false,background:false});await x.vault.save('owner',stored);
   // Reload the persisted account/grants under the same owner and Computer.
   x.authState.authGeneration=2;x.service.cancelAll();const next={...session,authGeneration:2};
   expect((await x.service.status(next)).grant.enabled).toBe(false);
   await x.service.refreshModels(next);expect((await x.service.status(next)).grant.enabled).toBe(false);
   const browserCount=x.browserOpens;
   const after=await x.service.connect({...next,purpose:'personal_local'});
   expect(after).toMatchObject({state:'connected',account:{id:before.account!.id},grant:{enabled:true,background:false,revision:before.grant.revision+1},bridgeConnected:true});
   expect(x.browserOpens).toBe(browserCount);
   stored=await x.vault.load('owner');expect(stored.grants.find(g=>g.computerId==='other-computer')).toEqual({computerId:'other-computer',revision:7,enabled:false,background:false});
   x.queue([request('00000000-0000-4000-8000-000000000010',after.account!.id,before.grant.revision)]);
   await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(false);expect(x.providerBodies).toHaveLength(0);
  }finally{await x.cleanup();}
 });
 it('keeps the old disabled grant when explicit reconnect cannot verify the catalog',async()=>{
  const x=await fixture();try{
   await x.signedIn();const before=await x.service.setGrant({...session,enabled:false,background:false});x.rejectCatalog();
   await expect(x.service.connect({...session,purpose:'personal_local'})).rejects.toThrow('network_error');
   const stored=await x.vault.load('owner');expect(stored.activeAccountId).toBe(before.account!.id);
   expect(stored.grants.find(g=>g.computerId==='computer')).toMatchObject({revision:before.grant.revision,enabled:false,background:false});
   expect(x.providerBodies).toHaveLength(0);
  }finally{await x.cleanup();}
 });
 it('fences reconnect catalog completion after owner or Computer changes',async()=>{
  const x=await fixture();let release=()=>{};try{
   await x.signedIn();await x.service.setGrant({...session,enabled:false,background:false});release=x.holdCatalog();
   const reconnect=x.service.connect({...session,purpose:'personal_local'});const rejected=expect(reconnect).rejects.toThrow();
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(1));
   x.authState.handle='other-computer';x.authState.authGeneration=2;x.service.cancelAll();release();await rejected;
   expect((await x.vault.load('owner')).grants.find(g=>g.computerId==='computer')?.enabled).toBe(false);
  }finally{release();await x.cleanup();}
 });
 it('cancellation fences a late reconnect without enabling a deliberately disabled grant',async()=>{
  const x=await fixture();let release=()=>{};try{
   await x.signedIn();const before=await x.service.setGrant({...session,enabled:false,background:false});release=x.holdCatalog();
   const reconnect=x.service.connect({...session,purpose:'personal_local'});const rejected=expect(reconnect).rejects.toThrow();
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(1));
   await x.service.cancel(session);release();await rejected;
   const stored=await x.vault.load('owner');expect(stored.accounts[0]?.tokens).not.toBeNull();
   expect(stored.grants.find(g=>g.computerId==='computer')).toMatchObject({revision:before.grant.revision,enabled:false,background:false});
   expect((await x.service.status(session)).grant.enabled).toBe(false);expect(x.providerBodies).toHaveLength(0);
  }finally{release();await x.cleanup();}
 });
 it('explicit disconnect wins over a late reconnect and subsequent status reads',async()=>{
  const x=await fixture();let release=()=>{};try{
   await x.signedIn();await x.service.setGrant({...session,enabled:false,background:false});release=x.holdCatalog();
   const reconnect=x.service.connect({...session,purpose:'personal_local'});const rejected=expect(reconnect).rejects.toThrow();
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(1));
   expect(await x.service.disconnect(session)).toMatchObject({state:'disconnected',grant:{enabled:false,background:false},bridgeConnected:false});
   release();await rejected;const stored=await x.vault.load('owner');expect(stored.accounts[0]?.tokens).toBeNull();
   expect(stored.grants.every(g=>!g.enabled&&!g.background)).toBe(true);
   expect(await x.service.status(session)).toMatchObject({state:'disconnected',grant:{enabled:false},models:[],bridgeConnected:false});
   expect(x.providerBodies).toHaveLength(0);
  }finally{release();await x.cleanup();}
 });
 it('rejects background, account replacement and Stop without fallback or poisoning next interactive run',async()=>{
  const x=await fixture();try{
   await x.signedIn();const status=await x.service.setGrant({...session,enabled:true,background:false});
   const blocked=request('00000000-0000-4000-8000-000000000002',status.account!.id,status.grant.revision);blocked.requestClass='background';
   x.queue([blocked]);await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(false);expect(x.providerBodies).toHaveLength(0);
   const stopped=request('00000000-0000-4000-8000-000000000003',status.account!.id,status.grant.revision);
   x.queue([stopped,{version:1,action:'cancel',id:stopped.id}]);await vi.waitFor(()=>expect(x.polls).toBeGreaterThan(3));
   expect((await x.service.status(session)).bridgeConnected).toBe(true);
   x.queue([request('00000000-0000-4000-8000-000000000004',status.account!.id,status.grant.revision)]);await vi.waitFor(()=>expect(x.replies).toHaveLength(2));expect(x.replies[1]?.ok).toBe(true);expect(x.providerBodies).toHaveLength(1);
  }finally{await x.cleanup();}
 });
 it('serializes rotating refresh before concurrent model readers and persists the replacement together',async()=>{
  const x=await fixture();try{
   x.expireSoon();await x.service.connect({...session,purpose:'personal_local'});await x.finish();
   await vi.waitFor(async()=>expect((await x.service.status(session)).bridgeConnected).toBe(true));
   await Promise.all([x.service.refreshModels(session),x.service.status(session),x.service.status(session)]);
   expect(x.refreshes).toBe(1);const stored=(await x.vault.load('owner')).accounts[0]!.tokens!;
   expect(stored.expiresAt).toBeGreaterThan(Date.now()+60000);expect(stored.refreshToken).toBe('fixture-refresh');
  }finally{await x.cleanup();}
 });
 it('publishes changed catalogs but retains an unchanged connected peer and rejects removed models',async()=>{
  const x=await fixture();try{
   await x.signedIn();const status=await x.service.setGrant({...session,enabled:true,background:false});const count=x.snapshots.length;
   await Promise.all([x.service.refreshModels(session),x.service.refreshModels(session)]);expect(x.snapshots).toHaveLength(count);
   x.changeModel('fixture-new');await x.service.refreshModels(session);expect(x.snapshots).toHaveLength(count+1);
   expect((x.snapshots.at(-1) as {models:Array<{id:string}>}).models[0]?.id).toBe('fixture-new');
   x.queue([request('00000000-0000-4000-8000-000000000009',status.account!.id,status.grant.revision)]);
   await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(false);expect(x.providerBodies).toHaveLength(0);
  }finally{await x.cleanup();}
 });
 it('a stale old-owner catalog failure cannot overwrite the new owner status',async()=>{
  const x=await fixture();let dateSpy:ReturnType<typeof vi.spyOn>|undefined;try{
   await x.signedIn();const release=x.holdCatalog();const now=Date.now();dateSpy=vi.spyOn(Date,'now').mockReturnValue(now+6*60000);
   const previous=x.service.status(session);const rejected=expect(previous).rejects.toThrow();
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(1));
   x.authState.userId='other-owner';x.authState.authGeneration=2;x.service.cancelAll();dateSpy.mockRestore();dateSpy=undefined;
   const nextSession={...session,authGeneration:2};expect((await x.service.status(nextSession)).state).toBe('disconnected');
   release();await rejected;expect((await x.service.status(nextSession)).state).toBe('disconnected');
  }finally{dateSpy?.mockRestore();await x.cleanup();}
 });
 it('a cancelled late authorization cannot disconnect the replacement runtime peer',async()=>{
  const x=await fixture();let release:()=>void=()=>{};
  try{
   await x.signedIn();await x.service.setGrant({...session,enabled:true,background:false});
   x.catalogStatus(401);await expect(x.service.refreshModels(session)).rejects.toThrow();release=x.holdJwks();await x.service.connect({...session,purpose:'personal_local'});x.catalogStatus(null);await x.finish();
   await vi.waitFor(()=>expect(x.jwksHeld).toBe(true));
   x.authState.authGeneration=2;x.service.cancelAll();
   const replacement={...session,authGeneration:2};
   expect((await x.service.status(replacement)).bridgeConnected).toBe(true);
   const before=x.snapshots.length;release();
   await new Promise(resolve=>setTimeout(resolve,50));
   expect((await x.service.status(replacement)).bridgeConnected).toBe(true);
   expect(x.snapshots).toHaveLength(before);
  }finally{release();await x.cleanup();}
 });
 it('grant revocation racing rotating refresh drains without mutation-lock deadlock',async()=>{
  const x=await fixture();let dateSpy:ReturnType<typeof vi.spyOn>|undefined;let release=()=>{};try{
   await x.signedIn();const status=await x.service.setGrant({...session,enabled:true,background:false});release=x.holdRefresh();
   const now=Date.now();dateSpy=vi.spyOn(Date,'now').mockReturnValue(now+4*60000+1000);
   x.queue([request('00000000-0000-4000-8000-000000000008',status.account!.id,status.grant.revision)]);
   await vi.waitFor(()=>expect(x.refreshes).toBe(1));const revoked=x.service.setGrant({...session,enabled:false,background:false});
   release();dateSpy.mockRestore();dateSpy=undefined;
   await expect(Promise.race([revoked,new Promise((_,reject)=>setTimeout(()=>reject(new Error('deadlock')),1000))])).resolves.toMatchObject({grant:{enabled:false}});
   expect(x.providerBodies).toHaveLength(0);
  }finally{release();dateSpy?.mockRestore();await x.cleanup();}
 });
 it('late provider failure discards partial output and cannot masquerade as a completed reply',async()=>{
  const x=await fixture();try{await x.signedIn();const status=await x.service.setGrant({...session,enabled:true,background:false});x.lateFailure();x.queue([request('00000000-0000-4000-8000-000000000007',status.account!.id,status.grant.revision)]);await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(false);expect(x.replies[0]).not.toHaveProperty('body');}finally{await x.cleanup();}
 });
 it('keeps validated active account on failed reauthorization and revokes/clears tokens on sign out',async()=>{
  const x=await fixture();try{
   await x.signedIn();const before=await x.service.status(session);x.catalogStatus(401);await expect(x.service.refreshModels(session)).rejects.toThrow();x.rejectNonce();await x.service.connect({...session,purpose:'personal_local'});x.catalogStatus(null);await x.finish();
   await vi.waitFor(async()=>expect((await x.service.status(session)).state).toBe('connected'));
   expect((await x.service.status(session)).account?.id).toBe(before.account?.id);
   const out=await x.service.disconnect(session);expect(out.state).toBe('disconnected');expect(out.revocation).toBe('confirmed');expect(x.revoked).toBe(true);expect((await x.vault.load('owner')).accounts[0]?.tokens).toBeNull();
  }finally{await x.cleanup();}
 });
});


describe('native catalog failure immediately fences the current inference source',()=>{
 it('failed explicit refresh clears models, disconnects old peer and recovers without another OAuth or grant change',async()=>{
  const x=await fixture();try{
   await x.signedIn();const before=await x.service.status(session);const browsers=x.browserOpens;
   x.rejectCatalog();await expect(x.service.refreshModels(session)).rejects.toThrow();
   expect(await x.service.status(session)).toMatchObject({state:'error',models:[],bridgeConnected:false,grant:before.grant,account:before.account});
   x.queue([request('00000000-0000-4000-8000-000000000020',before.account!.id,before.grant.revision)]);
   await new Promise(resolve=>setTimeout(resolve,40));expect(x.providerBodies).toHaveLength(0);x.clearRequests();
   const stored=await x.vault.load('owner');expect(stored.accounts[0]?.tokens).not.toBeNull();expect(stored.grants[0]).toMatchObject(before.grant);
   x.allowCatalog();const after=await x.service.connect({...session,purpose:'personal_local'});
   expect(after).toMatchObject({state:'connected',models:[{id:'fixture-visible'}],bridgeConnected:true,grant:before.grant,account:before.account});expect(x.browserOpens).toBe(browsers);
   x.queue([request('00000000-0000-4000-8000-000000000021',after.account!.id,after.grant.revision)]);
   await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(true);
  }finally{await x.cleanup();}
 });
 it('failed periodic refresh immediately stops the peer before the five-minute inference window elapses',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});const x=await fixture();let dateSpy:ReturnType<typeof vi.spyOn>|undefined;try{
   await x.signedIn();const before=await x.service.status(session);x.rejectCatalog();dateSpy=vi.spyOn(Date,'now').mockReturnValue(Date.now()+4*60000+1000);
   vi.advanceTimersByTime(10000);
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.some(call=>String(call[0]).endsWith('/api/chatgpt-plan/device/disconnect'))).toBe(true));
   expect(await x.service.status(session)).toMatchObject({state:'error',models:[],bridgeConnected:false,grant:before.grant});
   dateSpy.mockRestore();dateSpy=undefined;x.allowCatalog();expect(await x.service.refreshModels(session)).toMatchObject({state:'connected',models:[{id:'fixture-visible'}],bridgeConnected:true,grant:before.grant});
  }finally{dateSpy?.mockRestore();await x.cleanup();vi.useRealTimers();}
 });
 it.each([true,false])('a delayed old catalog read (failure=%s) cannot override a newer successful qualified catalog',async(fail)=>{
  const x=await fixture();let release=()=>{};try{
   await x.signedIn();release=x.holdOneCatalog(fail,'fixture-old');
   const older=x.service.refreshModels(session);const outcome=older.then(()=>undefined,()=>undefined);
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(1));
   x.changeModel('fixture-new');expect((await x.service.refreshModels(session)).models[0]?.id).toBe('fixture-new');const connections=x.snapshots.length;
   release();await outcome;
   expect(await x.service.status(session)).toMatchObject({state:'connected',models:[{id:'fixture-new'}],bridgeConnected:true});expect(x.snapshots).toHaveLength(connections);
  }finally{release();await x.cleanup();}
 });
 it('catalog invalidation cancels an in-flight native SSE body after response headers and cannot publish its late completion',async()=>{
  const x=await fixture();let release=()=>{};try{
   await x.signedIn();const before=await x.service.status(session);release=x.holdResponse();
   x.queue([request('00000000-0000-4000-8000-000000000030',before.account!.id,before.grant.revision)]);
   await vi.waitFor(()=>expect(x.providerBodies).toHaveLength(1));x.rejectCatalog();await expect(x.service.refreshModels(session)).rejects.toThrow();
   expect(x.responseAborted).toBe(true);release();await new Promise(resolve=>setTimeout(resolve,30));expect(x.replies.some(reply=>reply.ok===true)).toBe(false);
   expect(await x.service.status(session)).toMatchObject({state:'error',models:[],bridgeConnected:false,grant:before.grant});
  }finally{release();await x.cleanup();}
 });
});


it('a failed refresh withdraws the old inference source while a newer catalog is still unqualified',async()=>{
 const x=await fixture();let releaseOld=()=>{};let releaseNew=()=>{};try{
  await x.signedIn();const before=await x.service.status(session);releaseOld=x.holdOneCatalog(true);
  const old=x.service.refreshModels(session);const rejected=expect(old).rejects.toThrow();
  await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBe(2));
  releaseNew=x.holdOneCatalog(false,'fixture-new');const newer=x.service.refreshModels(session).then(value=>({value}),error=>({error}));
  await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBe(3));
  releaseOld();await rejected;x.queue([request('00000000-0000-4000-8000-000000000040',before.account!.id,before.grant.revision)]);
  await new Promise(resolve=>setTimeout(resolve,40));expect(x.providerBodies).toHaveLength(0);x.clearRequests();
  releaseNew();expect(await newer).toMatchObject({value:{state:'connected',models:[{id:'fixture-new'}],bridgeConnected:true,grant:before.grant}});
 }finally{releaseOld();releaseNew();await x.cleanup();}
});


it.each(['account','owner','computer_runtime'])('a delayed failure cannot disconnect the replacement %s source',async(kind)=>{
 const x=await fixture();let release=()=>{};try{
  await x.signedIn();release=x.holdOneCatalog(true);const older=x.service.refreshModels(session);const rejected=expect(older).rejects.toThrow();
  await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBe(2));
  const saved=await x.vault.load('owner');
  if(kind==='account'){
   const account={...saved.accounts[0]!,id:'00000000-0000-4000-8000-000000000002'};await x.vault.save('owner',{...saved,activeAccountId:account.id,accounts:[account]});
  }else if(kind==='owner'){
   x.authState.userId='other-owner';await x.vault.save('other-owner',{...saved,ownerId:'other-owner'});
  }else{
   x.authState.handle='other-computer';x.authState.runtimeSlot='preview';await x.vault.save('owner',{...saved,grants:[...saved.grants,{computerId:'other-computer',revision:4,enabled:true,background:false}]});
  }
  x.authState.authGeneration=2;x.service.cancelAll();const next={runtimeSlot:x.authState.runtimeSlot,authGeneration:2};x.changeModel('fixture-new');
  const replacement=await x.service.status(next);expect(replacement).toMatchObject({state:'connected',models:[{id:'fixture-new'}],bridgeConnected:true});const connections=x.snapshots.length;
  release();await rejected;expect(await x.service.status(next)).toEqual(replacement);expect(x.snapshots).toHaveLength(connections);expect(x.providerBodies).toHaveLength(0);
 }finally{release();await x.cleanup();}
});


it('an old failed-catalog drain settles without waiting for or stopping the recovered live peer',async()=>{
 const x=await fixture();let release=()=>{};let settled=false;try{
  await x.signedIn();const before=await x.service.status(session);release=x.holdDisconnect();x.rejectCatalog();
  const older=x.service.refreshModels(session).then(()=>{settled=true;},()=>{settled=true;});
  await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/device/disconnect'))).toHaveLength(1));
  x.allowCatalog();x.changeModel('fixture-new');const recovered=await x.service.refreshModels(session);
  expect(recovered).toMatchObject({state:'connected',models:[{id:'fixture-new'}],bridgeConnected:true,grant:before.grant});
  release();await vi.waitFor(()=>expect(settled).toBe(true),{timeout:250});await older;
  expect(await x.service.status(session)).toEqual(recovered);
 }finally{release();await x.cleanup();}
});

it('a catalog invalidation fences a captured peer restart delayed by disconnect',async()=>{
 const x=await fixture();let release=()=>{};try{
  await x.signedIn();const connections=x.snapshots.length;release=x.holdDisconnect();x.changeModel('fixture-stale');
  const restarting=x.service.refreshModels(session).then(value=>({value}),error=>({error}));
  await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/device/disconnect'))).toHaveLength(1));
  x.rejectCatalog();await expect(x.service.refreshModels(session)).rejects.toThrow();release();const result=await restarting;
  expect(x.snapshots).toHaveLength(connections);expect(result).toHaveProperty('error');
  expect(await x.service.status(session)).toMatchObject({state:'error',models:[],bridgeConnected:false});
 }finally{release();await x.cleanup();}
});


it.each(['catalog401','refresh_invalid_grant'])('explicit Connect recovers rejected %s credentials with fresh OAuth without erasing the saved account',async(kind)=>{
 const x=await fixture();try{
  await x.signedIn();let next=session;
  if(kind==='catalog401'){x.catalogStatus(401);await expect(x.service.refreshModels(session)).rejects.toThrow();}
  else{const saved=await x.vault.load('owner');saved.accounts[0]!.tokens!.expiresAt=1;await x.vault.save('owner',saved);x.refreshError('invalid_grant');x.authState.authGeneration=2;x.service.cancelAll();next={...session,authGeneration:2};}
  const before=await x.vault.load('owner');expect(await x.service.status(next)).toMatchObject({state:'error',models:[],bridgeConnected:false});expect(x.browserOpens).toBe(1);
  const connecting=await x.service.connect({...next,purpose:'personal_local'});expect(connecting).toMatchObject({state:'connecting',models:[],bridgeConnected:false});expect(x.browserOpens).toBe(2);
  expect(await x.vault.load('owner')).toEqual(before);expect(await x.service.status(next)).toMatchObject({state:'connecting',models:[],bridgeConnected:false});expect(x.browserOpens).toBe(2);expect(await x.service.cancel(next)).toMatchObject({state:'error',models:[],bridgeConnected:false});expect(await x.vault.load('owner')).toEqual(before);
  await x.service.connect({...next,purpose:'personal_local'});expect(x.browserOpens).toBe(3);x.catalogStatus(null);x.refreshError(null);await x.finish();
  await vi.waitFor(async()=>expect(await x.service.status(next)).toMatchObject({state:'connected',models:[{id:'fixture-visible'}],bridgeConnected:true,account:{id:before.activeAccountId},grant:{enabled:true,background:false,revision:before.grants[0]!.revision+1}}));
  const recovered=await x.service.status(next);x.queue([request('00000000-0000-4000-8000-000000000060',recovered.account!.id,recovered.grant.revision)]);await vi.waitFor(()=>expect(x.replies.at(-1)?.ok).toBe(true));expect(x.providerBodies).toHaveLength(1);
 }finally{await x.cleanup();}
});

it.each([403,429,503])('catalog HTTP%s does not initiate OAuth or discard credentials',async(status)=>{
 const x=await fixture();try{
  await x.signedIn();const before=await x.vault.load('owner');x.catalogStatus(status);await expect(x.service.refreshModels(session)).rejects.toThrow();
  await expect(x.service.connect({...session,purpose:'personal_local'})).rejects.toThrow();expect(x.browserOpens).toBe(1);expect(await x.vault.load('owner')).toEqual(before);
  x.catalogStatus(null);expect(await x.service.connect({...session,purpose:'personal_local'})).toMatchObject({state:'connected',bridgeConnected:true});expect(x.browserOpens).toBe(1);
 }finally{await x.cleanup();}
});

it('failed fresh authorization after definitive rejection retains the vault and unavailable inference state',async()=>{
 const x=await fixture();try{
  await x.signedIn();const before=await x.vault.load('owner');x.catalogStatus(401);await expect(x.service.refreshModels(session)).rejects.toThrow();
  await x.service.connect({...session,purpose:'personal_local'});x.rejectNonce();await x.finish();await vi.waitFor(async()=>expect((await x.service.status(session)).state).toBe('error'));
  expect(await x.vault.load('owner')).toEqual(before);expect(await x.service.status(session)).toMatchObject({models:[],bridgeConnected:false});expect(x.providerBodies).toHaveLength(0);
 }finally{await x.cleanup();}
});

it.each(['account','owner','computer_runtime'])('a delayed definitive rejection cannot start OAuth for a replacement %s source',async(kind)=>{
 const x=await fixture();let release=()=>{};try{
  await x.signedIn();x.catalogStatus(401);await expect(x.service.refreshModels(session)).rejects.toThrow();x.catalogStatus(null);release=x.holdOneCatalog(401);
  const connecting=x.service.connect({...session,purpose:'personal_local'});const rejected=expect(connecting).rejects.toThrow();await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models'))).toHaveLength(3));
  const saved=await x.vault.load('owner');
  if(kind==='account'){const account={...saved.accounts[0]!,id:'00000000-0000-4000-8000-000000000002'};await x.vault.save('owner',{...saved,activeAccountId:account.id,accounts:[account]});}
  else if(kind==='owner'){x.authState.userId='other-owner';await x.vault.save('other-owner',{...saved,ownerId:'other-owner'});}
  else{x.authState.handle='other-computer';x.authState.runtimeSlot='preview';await x.vault.save('owner',{...saved,grants:[...saved.grants,{computerId:'other-computer',revision:4,enabled:true,background:false}]});}
  x.authState.authGeneration=2;x.service.cancelAll();const next={runtimeSlot:x.authState.runtimeSlot,authGeneration:2};expect((await x.service.status(next)).bridgeConnected).toBe(true);release();await rejected;expect(x.browserOpens).toBe(1);expect((await x.service.status(next)).bridgeConnected).toBe(true);
 }finally{release();await x.cleanup();}
});


it('a delayed rejected credential read cannot open OAuth after a newer catalog has qualified',async()=>{
 const x=await fixture();let release=()=>{};try{
  await x.signedIn();x.catalogStatus(401);await expect(x.service.refreshModels(session)).rejects.toThrow();x.catalogStatus(null);release=x.holdOneCatalog(401);
  const older=x.service.connect({...session,purpose:'personal_local'});const rejected=expect(older).rejects.toThrow();await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models'))).toHaveLength(3));
  expect((await x.service.refreshModels(session)).bridgeConnected).toBe(true);release();await rejected;expect(x.browserOpens).toBe(1);expect((await x.service.status(session)).bridgeConnected).toBe(true);
 }finally{release();await x.cleanup();}
});

it('periodic credential rejection withdraws inference without automatically opening browser authorization',async()=>{
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});const x=await fixture();let dateSpy:ReturnType<typeof vi.spyOn>|undefined;try{
  await x.signedIn();x.catalogStatus(401);dateSpy=vi.spyOn(Date,'now').mockReturnValue(Date.now()+4*60000+1000);vi.advanceTimersByTime(10000);
  await vi.waitFor(()=>expect(x.fetchFn.mock.calls.some(call=>String(call[0]).endsWith('/device/disconnect'))).toBe(true));
  expect(await x.service.status(session)).toMatchObject({state:'error',models:[],bridgeConnected:false});expect(x.browserOpens).toBe(1);expect(x.providerBodies).toHaveLength(0);
 }finally{dateSpy?.mockRestore();await x.cleanup();vi.useRealTimers();}
});


it('explicit Connect for the current qualified enabled account reuses authorization without another browser or grant revision',async()=>{
 const x=await fixture();try{
  await x.signedIn();const before=await x.service.status(session);const vault=await x.vault.load('owner');const connections=x.snapshots.length;
  expect(await x.service.connect({...session,purpose:'personal_local'})).toEqual(before);expect(x.browserOpens).toBe(1);expect(await x.vault.load('owner')).toEqual(vault);expect(x.snapshots).toHaveLength(connections);
 }finally{await x.cleanup();}
});


it('a qualified saved-account read during fresh OAuth cannot pretend the pending authorization completed',async()=>{
 const x=await fixture();try{
  await x.signedIn();const before=await x.vault.load('owner');x.catalogStatus(401);await expect(x.service.refreshModels(session)).rejects.toThrow();await x.service.connect({...session,purpose:'personal_local'});
  x.catalogStatus(null);expect(await x.service.refreshModels(session)).toMatchObject({state:'connecting',models:[{id:'fixture-visible'}],bridgeConnected:true});expect(x.browserOpens).toBe(2);expect(await x.vault.load('owner')).toEqual(before);
  expect(await x.service.cancel(session)).toMatchObject({state:'connected',grant:{revision:before.grants[0]!.revision},bridgeConnected:false});expect(await x.vault.load('owner')).toEqual(before);
 }finally{await x.cleanup();}
});

it('explicit recovery signs replacement intent, preserves local account/grant and rejects concurrent or stale IPC', async()=>{
 const x=await fixture();try{
  await x.signedIn();const before=await x.service.status(session);x.conflict();x.service.cancelAll();
  const conflict=await x.service.refreshModels(session);
  expect(conflict).toMatchObject({state:'connected',bridgeConnected:false,bridgeFailure:'device_conflict'});
  await x.service.status(session);await x.service.refreshModels(session);expect(x.rebinds).toBe(0);
  await expect(x.service.rebind({...session,authGeneration:0,purpose:'replace_device'})).rejects.toThrow();
  const recovery=x.service.rebind({...session,purpose:'replace_device'});
  await expect(x.service.rebind({...session,purpose:'replace_device'})).rejects.toThrow('recovery in progress');
  const after=await recovery;
  expect(after).toMatchObject({state:'connected',bridgeConnected:true,account:before.account,grant:before.grant,models:before.models});
  expect(after.bridgeFailure).toBeUndefined();expect(x.rebinds).toBe(1);expect(x.browserOpens).toBe(1);
 }finally{await x.cleanup();}
});

it('canceled or switched recovery cannot send replacement intent after delayed discovery',async()=>{
 const x=await fixture();let release=()=>{};try{
  await x.signedIn();x.conflict();x.service.cancelAll();await x.service.refreshModels(session);
  release=x.holdCatalog();const pending=x.service.rebind({...session,purpose:'replace_device'});
  const rejected=expect(pending).rejects.toThrow();
  await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(2));
  x.service.cancelAll();release();await rejected;expect(x.rebinds).toBe(0);
 }finally{release();await x.cleanup();}
});

it.each(['lost response','post-CAS read failure'] as const)('recovers %s through exactly one ordinary reconnect without repeating replacement',async mode=>{
 const x=await fixture();try{
  await x.signedIn();x.conflict();x.service.cancelAll();await x.service.refreshModels(session);
  const before=x.fetchFn.mock.calls.length;
  x.failReplacement({commit:true,lost:mode==='lost response'});
  expect(await x.service.rebind({...session,purpose:'replace_device'})).toMatchObject({bridgeConnected:true});
  const attempts=x.fetchFn.mock.calls.slice(before).filter(call=>String(call[0]).endsWith('/device/connect')).map(call=>JSON.parse(String(call[1]?.body)));
  expect(attempts).toHaveLength(2);expect(attempts[0].replacement).toBeDefined();expect(attempts[1].replacement).toBeUndefined();
  expect((await x.service.status(session)).bridgeFailure).toBeUndefined();expect(x.rebinds).toBe(1);
 }finally{await x.cleanup();}
});
it('retains truthful conflict when failed replacement did not change the pin',async()=>{
 const x=await fixture();try{
  await x.signedIn();x.conflict();x.service.cancelAll();await x.service.refreshModels(session);
  x.failReplacement({commit:false,lost:false});
  expect(await x.service.rebind({...session,purpose:'replace_device'})).toMatchObject({bridgeConnected:false,bridgeFailure:'device_conflict'});
  const attempts=x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/device/connect')).map(call=>JSON.parse(String(call[1]?.body)));
  expect(attempts.at(-1).replacement).toBeUndefined();expect(x.rebinds).toBe(1);
 }finally{await x.cleanup();}
});
it('a lost replacement response for an old owner cannot reconnect or change the new owner status',async()=>{
 const x=await fixture();let release=()=>{};try{
  await x.signedIn();x.conflict();x.service.cancelAll();await x.service.refreshModels(session);
  const gate=new Promise<void>(resolve=>{release=resolve;});x.failReplacement({commit:true,lost:true,gate});
  const pending=x.service.rebind({...session,purpose:'replace_device'});const rejected=expect(pending).rejects.toThrow();
  await vi.waitFor(()=>expect(x.rebinds).toBe(1));
  x.authState.userId='other-owner';x.authState.authGeneration=2;x.service.cancelAll();
  const next={...session,authGeneration:2};const current=await x.service.status(next);
  const calls=x.fetchFn.mock.calls.length;release();await rejected;
  expect(x.fetchFn.mock.calls).toHaveLength(calls);expect(await x.service.status(next)).toEqual(current);
 }finally{release();await x.cleanup();}
});

it('a transient ordinary probe failure permits background reconnect without repeating replacement',async()=>{
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});const x=await fixture();try{
  await x.signedIn();x.conflict();x.service.cancelAll();await x.service.refreshModels(session);
  x.failReplacement({commit:true,lost:true,failProbe:true});
  await expect(x.service.rebind({...session,purpose:'replace_device'})).rejects.toThrow();
  expect(await x.service.status(session)).toMatchObject({bridgeConnected:false});
  expect((await x.service.status(session)).bridgeFailure).toBeUndefined();
  vi.advanceTimersByTime(10000);
  await vi.waitFor(async()=>expect((await x.service.status(session)).bridgeConnected).toBe(true));
  expect(x.rebinds).toBe(1);
 }finally{await x.cleanup();vi.useRealTimers();}
});
