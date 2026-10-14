import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonicalRequest,LEASE_FAILURE_REASONS,runDedicatedLeaseSession} from '../../scripts/ci/dedicated-ssh.mjs';
import {validInfrastructureProof} from '../../scripts/ci/dedicated-outcome.mjs';
const request={repository:'HamedMP/matrix-os',prNumber:2454,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),baseRef:'main',mergeSha:'c'.repeat(40),mergeParents:['b'.repeat(40),'a'.repeat(40)],requestingRunId:321,requestingRunAttempt:1,controllerRunId:123,controllerRunAttempt:1,controllerSha:'d'.repeat(40),controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',imageDigest:'sha256:'+'e'.repeat(64),harnessDigest:'f'.repeat(64),mode:'delegated',suite:'qualification',limits:{unitWorkers:16,cpu:30,memoryMiB:114688,workMiB:65536,tmpMiB:8192,homeMiB:1024,pids:4096,shmMiB:2048}};
const envelope={protocolVersion:1,leaseId:'1'.repeat(32),capability:'2'.repeat(64),request};
const proof={protocolVersion:1,type:'infrastructure-unavailable',leaseId:envelope.leaseId,requestDigest:createHash('sha256').update(canonicalRequest(request)).digest('hex'),status:76,reason:'queue_timeout',stage:'admission',workloadStarted:false,containerGone:true};
function client(){return Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});}
describe('infrastructure-only exact-source hosted fallback',()=>{
 it('requires authenticated owned proof and fresh default-controller API validation',async()=>{
  const c=client(),revalidate=vi.fn(async()=>{}),pending=runDedicatedLeaseSession(c,envelope,{revalidate,maxMilliseconds:1000});pending.catch(()=>{});
  c.stdout.write(JSON.stringify(proof)+'\n');c.emit('close',76);
  await expect(pending).resolves.toMatchObject({outcome:'infrastructure-unavailable',reason:'queue_timeout',workloadStarted:false,containerGone:true});
  expect(revalidate).toHaveBeenCalledWith(request,{unconditional:true});
 });
 it('accepts exactly the infrastructure outcomes the host can sign, at their stages',()=>{
  const printed=spawnSync('python3',['-I','-B','-c',`import json,sys\nsys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../../scripts/ci/runner',import.meta.url)))})\nfrom lease_outcome import STAGES\nprint(json.dumps(STAGES))`],{encoding:'utf8',timeout:10000});
  expect(printed.status,printed.stderr).toBe(0);
  const host=JSON.parse(printed.stdout) as Record<string,string>;
  expect(Object.keys(host).length).toBeGreaterThan(4);
  const signed=(reason:string,stage:string)=>validInfrastructureProof({outcome:'infrastructure-unavailable',status:76,workloadStarted:false,containerGone:true,reason,stage});
  for(const [reason,stage] of Object.entries(host)){
   expect(signed(reason,stage),reason).toBe(true);
   expect(signed(reason,stage==='admission'?'preflight':'admission'),reason).toBe(false);
  }
  // A full result directory stays red: it must never become a hosted fallback.
  expect(signed('result_cap','preflight')).toBe(false);
  expect(signed('test_failed','preflight')).toBe(false);
 });
 it.each([['execution_failed','failed'],['cleanup_failed','failed'],['evidence_failed','failed'],['result_cap','failed'],['lease_revoked','cancelled']])('names the host reason %s when a lease ends %s',async(reason,type)=>{
  const c=client(),pending=runDedicatedLeaseSession(c,envelope,{revalidate:vi.fn(async()=>{}),maxMilliseconds:1000});pending.catch(()=>{});
  c.stdout.write(JSON.stringify({protocolVersion:1,type,leaseId:envelope.leaseId,requestDigest:proof.requestDigest,status:type==='failed'?70:75,reason})+'\n');c.emit('close',70);
  await expect(pending).rejects.toThrow(`Owned Linux qualification did not complete (${reason})`);
 });
 it('repeats exactly the host reasons lease_outcome.py declares, per record type',()=>{
  const printed=spawnSync('python3',['-I','-B','-c',`import json,sys\nsys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../../scripts/ci/runner',import.meta.url)))})\nfrom lease_outcome import FAILURE_REASONS\nprint(json.dumps({k:sorted(v) for k,v in FAILURE_REASONS.items()}))`],{encoding:'utf8',timeout:10000});
  expect(printed.status,printed.stderr).toBe(0);
  expect(Object.fromEntries(Object.entries(LEASE_FAILURE_REASONS).map(([k,v])=>[k,[...v].sort()]))).toEqual(JSON.parse(printed.stdout));
 });
 it.each([['cancelled','result_cap',75],['failed','lease_revoked',70]])('does not repeat a %s record carrying %s',async(type,reason,status)=>{
  const c=client(),pending=runDedicatedLeaseSession(c,envelope,{revalidate:vi.fn(async()=>{}),maxMilliseconds:1000});pending.catch(()=>{});
  c.stdout.write(JSON.stringify({protocolVersion:1,type,leaseId:envelope.leaseId,requestDigest:proof.requestDigest,status,reason})+'\n');c.emit('close',status);
  await expect(pending).rejects.toThrow(/^Owned Linux qualification did not complete$/);
 });
 it('never repeats an unknown host reason',async()=>{
  const c=client(),pending=runDedicatedLeaseSession(c,envelope,{revalidate:vi.fn(async()=>{}),maxMilliseconds:1000});pending.catch(()=>{});
  c.stdout.write(JSON.stringify({protocolVersion:1,type:'failed',leaseId:envelope.leaseId,requestDigest:proof.requestDigest,status:70,reason:'see https://example.test/x'})+'\n');c.emit('close',70);
  await expect(pending).rejects.toThrow(/^Owned Linux qualification did not complete$/);
 });
 it.each(['started','cleanup','reason','stage','digest','status','unknownKey','auth'])('does not allow %s failure to become hosted success',async kind=>{
  const c=client(),revalidate=vi.fn(async()=>{if(kind==='auth')throw new Error('source stale');}),pending=runDedicatedLeaseSession(c,envelope,{revalidate,maxMilliseconds:1000});pending.catch(()=>{});
  const bad:any={...proof};if(kind==='started')bad.workloadStarted=true;if(kind==='cleanup')bad.containerGone=false;if(kind==='reason')bad.reason='test_failed';if(kind==='stage')bad.stage='unit';if(kind==='digest')bad.requestDigest='0'.repeat(64);if(kind==='status')bad.status=0;if(kind==='unknownKey')bad.ignoredTestFailure=true;
  c.stdout.write(JSON.stringify(bad)+'\n');c.emit('close',76);await expect(pending).rejects.toThrow();
 });
 it('never infers infrastructure from a generic SSH255 or missing receipt',async()=>{
  const c=client(),pending=runDedicatedLeaseSession(c,envelope,{revalidate:vi.fn(async()=>{}),maxMilliseconds:1000});pending.catch(()=>{});c.emit('close',255);await expect(pending).rejects.toThrow();
 });
});

describe('pinned local SSH unavailable before any grant',()=>{
 const host='ci.example.invalid';
 it.each(['Connection refused','Connection timed out','Operation timed out'])('authorizes full hosted recovery only from exact %s within the handshake bound',async message=>{
  const c=client(),revalidate=vi.fn(async()=>{}),pending=runDedicatedLeaseSession(c,envelope,{revalidate,maxMilliseconds:1000,transportHost:host});pending.catch(()=>{});
  c.stderr.write(`ssh: connect to host ${host} port 22: ${message}\n`);c.emit('close',255);
  await expect(pending).resolves.toMatchObject({outcome:'transport-unavailable',proofOrigin:'controller-transport-v1',grantSent:false,controlBytes:0,handshakeBoundSeconds:20,workloadStarted:false,containerGone:true});
  expect(revalidate).toHaveBeenCalledWith(request,{unconditional:true});
 });
 it.each(['wronghost','auth','hostkey','banner','control','grant','api','late','unknown','overflow'])('keeps %s failure red',async kind=>{
  const c=client(),revalidate=vi.fn(async()=>{if(kind==='api')throw new Error('stale source');}),pending=runDedicatedLeaseSession(c,envelope,{revalidate,maxMilliseconds:1000,transportHost:host});pending.catch(()=>{});
  if(kind==='control')c.stdout.write(JSON.stringify({...proof,type:'queued'})+'\n');
  if(kind==='grant'){c.stdout.write(JSON.stringify({...proof,type:'queued'})+'\n');c.stdout.write(JSON.stringify({...proof,type:'locked',challenge:'3'.repeat(64),deadlineUnixMs:Date.now()+30000})+'\n');await new Promise(r=>setTimeout(r,0));}
  const diagnostic=kind==='wronghost'?`ssh: connect to host other.invalid port 22: Connection refused\n`:kind==='auth'?'Permission denied (publickey).\n':kind==='hostkey'?'Host key verification failed.\n':kind==='banner'?`remote banner\nssh: connect to host ${host} port 22: Connection refused\n`:kind==='unknown'?'Connection closed by remote host\n':kind==='overflow'?'x'.repeat(8193):`ssh: connect to host ${host} port 22: Connection refused\n`;
  if(kind==='late')vi.spyOn(Date,'now').mockReturnValue(Date.now()+21000);
  try{c.stderr.write(diagnostic);c.emit('close',255);await expect(pending).rejects.toThrow();}finally{vi.restoreAllMocks();}
 });
});
it('rejects remote attempts to claim the controller-only transport exception',async()=>{
 const c=client(),pending=runDedicatedLeaseSession(c,envelope,{revalidate:vi.fn(async()=>{}),maxMilliseconds:1000,transportHost:'ci.example.invalid'});pending.catch(()=>{});
 c.stdout.write(JSON.stringify({...proof,type:'transport-unavailable',proofOrigin:'controller-transport-v1',grantSent:false,controlBytes:0,handshakeBoundSeconds:20,reason:'connection_refused',stage:'handshake'})+'\n');c.emit('close',255);await expect(pending).rejects.toThrow();
});
it('bounds an unknown handshake at20seconds and never fabricates availability',async()=>{
 vi.useFakeTimers();try{const c=client(),pending=runDedicatedLeaseSession(c,envelope,{revalidate:vi.fn(async()=>{}),maxMilliseconds:30000,transportHost:'ci.example.invalid'});const rejection=expect(pending).rejects.toThrow(/handshake deadline/);await vi.advanceTimersByTimeAsync(20001);await rejection;}finally{vi.useRealTimers();}
});
