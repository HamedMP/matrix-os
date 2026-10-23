import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import * as helpers from '../../scripts/ci/dedicated-admission.mjs';
const canonical=(value:unknown):string=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.entries(value).sort().map(([k,v])=>[k,JSON.parse(canonical(v))])):value);
const request={repository:'HamedMP/matrix-os',prNumber:2454,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),baseRef:'stack/parent',mergeSha:'c'.repeat(40),mergeParents:['b'.repeat(40),'a'.repeat(40)],requestingRunId:321,requestingRunAttempt:1,controllerRunId:123,controllerRunAttempt:1,controllerSha:'d'.repeat(40),controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',imageDigest:'sha256:'+'e'.repeat(64),harnessDigest:'f'.repeat(64),mode:'shadow',suite:'qualification',limits:{unitWorkers:16,cpu:30,memoryMiB:114688,workMiB:65536,tmpMiB:8192,homeMiB:1024,pids:4096,shmMiB:2048}};
const leaseId='1'.repeat(32),capability='2'.repeat(64),digest=createHash('sha256').update(canonical(request)).digest('hex');
const files=['account-organization-picker','file-download','canonical-input','provider-auth-terminal','agents-providers-figma','agents-providers-button-contrast','provider-settings-idle','project-folder-picker-layout','project-deletion','terminal-file-drop','terminal-snapshot','release-alignment','chat-title-layout','terminal-clipboard'].map(x=>`tests/e2e/desktop/${x}.e2e.test.ts`).concat('tests/e2e/provider-authorization-electron.e2e.test.ts').sort();
function receipt(){return{schemaVersion:1,leaseId,requestDigest:digest,request,qualified:true,exitCode:0,sourceSha:request.mergeSha,parents:request.mergeParents,imageDigest:request.imageDigest,harnessDigest:request.harnessDigest,lockSha256:'3'.repeat(64),inventorySha256:'4'.repeat(64),startedUtc:'2026-10-11T01:00:00Z',finishedUtc:'2026-10-11T01:01:00Z',queueSeconds:1,wallSeconds:60,phaseCount:56,guardCount:14,independentHostSourceChecks:4,allPhasesPassed:true,allGuardsClean:true,containerGone:true,reports:Object.fromEntries(['unit','general','grid','electron-download','electron-input','electron-providers','electron-folder','electron-deletion','electron-clipboard','electron-drop','electron-snapshot','electron-release','electron-title'].map(name=>[name,{files:name==='electron-providers'?5:name==='electron-input'?2:1,total:2,passed:1,skipped:1,failed:0,inventoryComplete:true}])),requiredElectronFiles:files,smoke:{comparedExports:264,svgRenderComparisons:264,distinctIconModules:216,missingExportControl:'rejected',negativeAliasControl:'rejected'}};}
function fake(){const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});return child;}
async function run(child:ReturnType<typeof fake>,revalidate=vi.fn(async(_request:unknown,_cycle:unknown)=>{})){const fn=(helpers as Record<string,unknown>).runDedicatedLeaseSession as Function;expect(fn).toBeTypeOf('function');return fn(child,{protocolVersion:1,leaseId,capability,request},{revalidate,maxMilliseconds:1000});}
function emit(child:ReturnType<typeof fake>,type:string,extra:Record<string,unknown>={}){child.stdout.write(JSON.stringify({protocolVersion:1,type,leaseId,requestDigest:digest,...extra})+'\n');}
async function admitted(child:ReturnType<typeof fake>){emit(child,'queued');emit(child,'locked',{challenge:'5'.repeat(64),deadlineUnixMs:Date.now()+30000});await new Promise(r=>setImmediate(r));emit(child,'running');}
describe('bounded authenticated SSH lease state machine',()=>{
 it('rechecks after lock and renewal then validates full cleanup receipt before accepting completion',async()=>{const c=fake();const verify=vi.fn(async()=>{});const pending=run(c,verify);pending.catch(()=>{});let written='';c.stdin.on('data',x=>written+=x);await admitted(c);emit(c,'renewal-required',{challenge:'6'.repeat(64),deadlineUnixMs:Date.now()+30000});await new Promise(r=>setImmediate(r));emit(c,'completed',{status:0,receipt:receipt()});c.emit('close',0);await expect(pending).resolves.toMatchObject({qualified:true});expect(verify).toHaveBeenCalledTimes(3);expect(written).toContain('"type":"grant"');expect(written).toContain('"type":"renew"');});
 it('never grants stale after-lock source and closes SSH stdin to revoke owned CPU',async()=>{const c=fake();const pending=run(c,vi.fn(async()=>{throw new Error('stale');}));pending.catch(()=>{});await admitted(c);c.emit('close',1);await expect(pending).rejects.toThrow(/stale/);expect(c.stdin.writableEnded).toBe(true);});
 it.each(['containerGone','allPhasesPassed','allGuardsClean','independentHostSourceChecks','request','imageDigest','inventory','scope','reports'])('rejects incomplete or mismatched %s evidence despite exit zero',async field=>{const c=fake();const pending=run(c);pending.catch(()=>{});await admitted(c);const r=receipt() as Record<string,unknown>;if(['containerGone','allPhasesPassed','allGuardsClean'].includes(field))r[field]=false;if(field==='independentHostSourceChecks')r.independentHostSourceChecks=0;if(field==='request')r.request={...request,requestingRunAttempt:2};if(field==='imageDigest')r.imageDigest='sha256:'+'0'.repeat(64);if(field==='inventory')r.inventorySha256='';if(field==='scope')r.requiredElectronFiles=files.slice(1);if(field==='reports')r.reports={unit:{files:1,total:0,passed:0,skipped:0,failed:0,inventoryComplete:true}};emit(c,'completed',{status:0,receipt:r});c.emit('close',0);await expect(pending).rejects.toThrow(/receipt|evidence/);});
 it.each(['lease','digest','replay','oversize','capability'])('rejects unbound/malformed control %s without acknowledging it',async kind=>{const c=fake();const pending=run(c);pending.catch(()=>{});await admitted(c);if(kind==='oversize')c.stdout.write('x'.repeat(32769));else if(kind==='capability')emit(c,'running',{capability});else emit(c,'renewal-required',{leaseId:kind==='lease'?'0'.repeat(32):leaseId,requestDigest:kind==='digest'?'0'.repeat(64):digest,challenge:'5'.repeat(64),deadlineUnixMs:Date.now()+30000});c.emit('close',1);await expect(pending).rejects.toThrow();});
 it('rejects disconnect without a trusted terminal receipt and caps overall session time',async()=>{const c=fake();const pending=run(c);pending.catch(()=>{});c.emit('close',0);await expect(pending).rejects.toThrow(/receipt|disconnect/);});
});
it('preserves split UTF-8 in a valid Unicode parent-ref receipt',async()=>{
 const c=fake(),value={...request,baseRef:'stack/父分支'},envelope={protocolVersion:1,leaseId,capability,request:value};
 const bound=createHash('sha256').update(canonical(value)).digest('hex');
 const fn=(helpers as Record<string,unknown>).runDedicatedLeaseSession as Function;
 const pending=fn(c,envelope,{revalidate:vi.fn(async()=>{}),maxMilliseconds:1000});pending.catch(()=>{});
 const output=(type:string,extra:Record<string,unknown>={})=>c.stdout.write(JSON.stringify({protocolVersion:1,type,leaseId,requestDigest:bound,...extra})+'\n');
 output('queued');output('locked',{challenge:'5'.repeat(64),deadlineUnixMs:Date.now()+30000});await new Promise(r=>setImmediate(r));output('running');
 const r={...receipt(),request:value,requestDigest:bound};const bytes=Buffer.from(JSON.stringify({protocolVersion:1,type:'completed',leaseId,requestDigest:bound,status:0,receipt:r})+'\n');
 const split=bytes.indexOf(Buffer.from('父'))+1;c.stdout.write(bytes.subarray(0,split));c.stdout.write(bytes.subarray(split));c.emit('close',0);
 await expect(pending).resolves.toMatchObject({qualified:true});
});
it('escalates only its own stuck SSH process after cancellation',async()=>{
 vi.useFakeTimers();try{
  const c=fake(),aborter=new AbortController(),fn=(helpers as Record<string,unknown>).runDedicatedLeaseSession as Function;
  const pending=fn(c,{protocolVersion:1,leaseId,capability,request},{signal:aborter.signal,revalidate:vi.fn(async()=>{}),maxMilliseconds:1000});pending.catch(()=>{});aborter.abort();
  await expect(pending).rejects.toThrow(/cancelled/);expect(c.kill).toHaveBeenCalledWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(5000);expect(c.kill).toHaveBeenCalledWith('SIGKILL');c.emit('close',1);
 }finally{vi.useRealTimers();}
});
it('accepts the reviewed 120-second renewal challenge while first and final checks are unconditional',async()=>{
 const c=fake(),verify=vi.fn(async(_request:unknown,_cycle:unknown)=>{}),pending=run(c,verify);pending.catch(()=>{});await admitted(c);
 emit(c,'renewal-required',{challenge:'6'.repeat(64),deadlineUnixMs:Date.now()+120000});await new Promise(r=>setImmediate(r));emit(c,'completed',{status:0,receipt:receipt()});c.emit('close',0);
 await expect(pending).resolves.toMatchObject({qualified:true});
 expect(verify.mock.calls[0]?.[1]).toEqual({unconditional:true});expect(verify.mock.calls[1]?.[1]).toEqual({unconditional:false});expect(verify.mock.calls[2]?.[1]).toEqual({unconditional:true});
});
it('revokes a lease when its authenticated API cycle stalls before a grant',async()=>{
 vi.useFakeTimers();try{const c=fake(),fn=(helpers as Record<string,unknown>).runDedicatedLeaseSession as Function;
 const pending=fn(c,{protocolVersion:1,leaseId,capability,request},{maxMilliseconds:100000,maxCycleMilliseconds:10,revalidate:()=>new Promise(()=>{})});pending.catch(()=>{});
 emit(c,'queued');emit(c,'locked',{challenge:'5'.repeat(64),deadlineUnixMs:Date.now()+30000});await vi.advanceTimersByTimeAsync(11);await expect(pending).rejects.toThrow(/API cycle/);expect(c.stdin.writableEnded).toBe(true);expect(c.kill).toHaveBeenCalledWith('SIGTERM');c.emit('close',1);
 }finally{vi.useRealTimers();}
});

it('binds actual native merge parent bytes separately from branch base in request shape',async()=>{
 const {nativePins}=await import('./helpers/native-stack-fixture');const value={...request,headSha:nativePins.head,baseSha:nativePins.base,mergeSha:nativePins.merge,mergeParents:[nativePins.parentMerge,nativePins.head]};
 expect((helpers as any).validateLeaseRequest(value)).toEqual(value);
 expect(canonical(value)).toContain(nativePins.base);expect(canonical(value)).toContain(nativePins.parentMerge);
});

function deferred(){
 let resolve!:()=>void,reject!:(error:Error)=>void;
 const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
 return{promise,resolve,reject};
}
async function heldRenewal(options:{signal?:AbortSignal;finalError?:Error}={}){
 const child=fake(),held=deferred(),entered=deferred();let written='';
 child.stdin.on('data',chunk=>{written+=chunk.toString();});
 const revalidate=vi.fn(async(_request:unknown,_cycle:unknown)=>{
  if(revalidate.mock.calls.length===2){entered.resolve();await held.promise;}
  if(revalidate.mock.calls.length===3&&options.finalError)throw options.finalError;
 });
 const fn=(helpers as Record<string,unknown>).runDedicatedLeaseSession as Function;
 const pending=fn(child,{protocolVersion:1,leaseId,capability,request},{revalidate,signal:options.signal,maxMilliseconds:1000});
 pending.catch(()=>{});await admitted(child);
 const deadlineUnixMs=Date.now()+30000;
 emit(child,'renewal-required',{challenge:'6'.repeat(64),deadlineUnixMs});
 await entered.promise;
 return{child,held,revalidate,pending,deadlineUnixMs,written:()=>written};
}
function completedBeforeClose(value:Awaited<ReturnType<typeof heldRenewal>>,status=0){
 emit(value.child,'completed',{status:0,receipt:receipt()});value.child.emit('close',status);
}
describe('SSH completion while authenticated renewal is pending',()=>{
 it('drains a buffered complete receipt after close without sending a renewal to a closed child',async()=>{
  const value=await heldRenewal();completedBeforeClose(value);value.held.resolve();
  await expect(value.pending).resolves.toEqual(receipt());
  expect(value.revalidate.mock.calls).toEqual([[request,{unconditional:true}],[request,{unconditional:false}],[request,{unconditional:true}]]);
  const sent=value.written().trim().split('\n').map(line=>JSON.parse(line));
  expect(sent.map(record=>record.type??'envelope')).toEqual(['envelope','grant']);
  expect(value.child.kill).not.toHaveBeenCalled();
 });
 it('still rejects exit zero when no terminal receipt was buffered',async()=>{
  const value=await heldRenewal();value.child.emit('close',0);value.held.resolve();
  await expect(value.pending).rejects.toThrow();expect(value.revalidate).toHaveBeenCalledTimes(2);
 });
 it('still rejects a nonzero SSH exit despite a valid buffered receipt',async()=>{
  const value=await heldRenewal();completedBeforeClose(value,1);value.held.resolve();
  await expect(value.pending).rejects.toThrow();
 });
 it.each(['malformed','truncated','replayed-renewal','trailing-after-terminal'])('rejects %s control data queued behind a held renewal',async kind=>{
  const value=await heldRenewal();
  if(kind==='malformed')value.child.stdout.write('{broken}\n');
  if(kind==='truncated')value.child.stdout.write('{"protocolVersion":1,"type":"completed"');
  if(kind==='replayed-renewal')emit(value.child,'renewal-required',{challenge:'6'.repeat(64),deadlineUnixMs:Date.now()+30000});
  if(kind==='trailing-after-terminal'){
   emit(value.child,'completed',{status:0,receipt:receipt()});emit(value.child,'running');
  }
  value.child.emit('close',0);value.held.resolve();await expect(value.pending).rejects.toThrow();
 });
 it.each(['source','digest','cleanup'])('rejects buffered %s receipt corruption after renewal and closure',async kind=>{
  const value=await heldRenewal(),invalid=receipt();
  if(kind==='source')invalid.sourceSha='0'.repeat(40);
  if(kind==='digest')invalid.requestDigest='0'.repeat(64);
  if(kind==='cleanup')invalid.containerGone=false;
  emit(value.child,'completed',{status:0,receipt:invalid});value.child.emit('close',0);value.held.resolve();
  await expect(value.pending).rejects.toThrow();
 });
 it('requires final unconditional source authentication after draining a valid receipt',async()=>{
  const value=await heldRenewal({finalError:new Error('final source changed')});completedBeforeClose(value);value.held.resolve();
  await expect(value.pending).rejects.toThrow('final source changed');
  expect(value.revalidate).toHaveBeenCalledTimes(3);
 });
 it('does not drain past a rejected renewal source authentication',async()=>{
  const value=await heldRenewal();completedBeforeClose(value);value.held.reject(new Error('renewal source changed'));
  await expect(value.pending).rejects.toThrow('renewal source changed');expect(value.revalidate).toHaveBeenCalledTimes(2);
 });
 it('does not grant an initial lock after the child closes while lock authentication is held',async()=>{
  const child=fake(),held=deferred(),entered=deferred();let written='';child.stdin.on('data',chunk=>{written+=chunk.toString();});
  const revalidate=vi.fn(async()=>{entered.resolve();await held.promise;});
  const pending=run(child,revalidate);pending.catch(()=>{});
  emit(child,'queued');emit(child,'locked',{challenge:'5'.repeat(64),deadlineUnixMs:Date.now()+30000});await entered.promise;
  emit(child,'running');emit(child,'completed',{status:0,receipt:receipt()});child.emit('close',0);held.resolve();
  await expect(pending).rejects.toThrow();expect(written).not.toContain('"type":"grant"');expect(revalidate).toHaveBeenCalledTimes(1);
 });
 it('preserves the absolute renewal deadline when a valid receipt and close are buffered',async()=>{
  let now=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
  try{
   const value=await heldRenewal();completedBeforeClose(value);now=value.deadlineUnixMs+1;value.held.resolve();
   await expect(value.pending).rejects.toThrow(/expired/);expect(value.revalidate).toHaveBeenCalledTimes(2);
  }finally{clock.mockRestore();}
 });
 it('preserves explicit cancellation while a valid receipt waits behind renewal authentication',async()=>{
  const aborter=new AbortController(),value=await heldRenewal({signal:aborter.signal});completedBeforeClose(value);aborter.abort();value.held.resolve();
  await expect(value.pending).rejects.toThrow(/cancelled/);expect(value.child.kill).toHaveBeenCalledWith('SIGTERM');
 });
});

it('rejects a receipt that omits the required account organization picker', async () => {
 const child = fake();
 const pending = run(child);
 const rejected = expect(pending).rejects.toThrow(/qualification receipt/);
 await admitted(child);
 const invalid = receipt();
 invalid.requiredElectronFiles = invalid.requiredElectronFiles.filter(file => !file.endsWith('/account-organization-picker.e2e.test.ts'));
 emit(child, 'completed', { status: 0, receipt: invalid });
 child.emit('close', 0);
 await rejected;
});
it('rejects a receipt that did not execute both required Electron input files', async () => {
 const child = fake();
 const pending = run(child);
 const rejected = expect(pending).rejects.toThrow(/evidence counts/);
 await admitted(child);
 const invalid = receipt();
 invalid.reports['electron-input'].files = 1;
 emit(child, 'completed', { status: 0, receipt: invalid });
 child.emit('close', 0);
 await rejected;
});
