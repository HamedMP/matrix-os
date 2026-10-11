import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import * as helpers from '../../scripts/ci/dedicated-admission.mjs';
const canonical=(value:unknown):string=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.entries(value).sort().map(([k,v])=>[k,JSON.parse(canonical(v))])):value);
const request={repository:'HamedMP/matrix-os',prNumber:2454,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),baseRef:'stack/parent',mergeSha:'c'.repeat(40),mergeParents:['b'.repeat(40),'a'.repeat(40)],requestingRunId:321,requestingRunAttempt:1,controllerRunId:123,controllerRunAttempt:1,controllerSha:'d'.repeat(40),controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',imageDigest:'sha256:'+'e'.repeat(64),harnessDigest:'f'.repeat(64),mode:'shadow',suite:'qualification',limits:{unitWorkers:16,cpu:30,memoryMiB:114688,workMiB:65536,tmpMiB:8192,homeMiB:1024,pids:4096,shmMiB:2048}};
const leaseId='1'.repeat(32),capability='2'.repeat(64),digest=createHash('sha256').update(canonical(request)).digest('hex');
const files=['file-download','canonical-input','provider-auth-terminal','agents-providers-figma','agents-providers-button-contrast','provider-settings-idle','project-folder-picker-layout','terminal-file-drop','terminal-snapshot','release-alignment','chat-title-layout','terminal-clipboard'].map(x=>`tests/e2e/desktop/${x}.e2e.test.ts`).concat('tests/e2e/provider-authorization-electron.e2e.test.ts').sort();
function receipt(){return{schemaVersion:1,leaseId,requestDigest:digest,request,qualified:true,exitCode:0,sourceSha:request.mergeSha,parents:request.mergeParents,imageDigest:request.imageDigest,harnessDigest:request.harnessDigest,lockSha256:'3'.repeat(64),inventorySha256:'4'.repeat(64),startedUtc:'2026-10-11T01:00:00Z',finishedUtc:'2026-10-11T01:01:00Z',queueSeconds:1,wallSeconds:60,phaseCount:55,guardCount:14,independentHostSourceChecks:4,allPhasesPassed:true,allGuardsClean:true,containerGone:true,reports:Object.fromEntries(['unit','general','grid','electron-download','electron-input','electron-providers','electron-folder','electron-clipboard','electron-drop','electron-snapshot','electron-release','electron-title'].map(name=>[name,{files:name==='electron-providers'?5:1,total:2,passed:1,skipped:1,failed:0,inventoryComplete:true}])),requiredElectronFiles:files,smoke:{comparedExports:264,svgRenderComparisons:264,distinctIconModules:216,missingExportControl:'rejected',negativeAliasControl:'rejected'}};}
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
