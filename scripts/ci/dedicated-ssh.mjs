import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConditionalGithub} from './dedicated-api.mjs';
import {verifyDedicatedLeaseGrant} from './dedicated-lease.mjs';
const sha=/^[a-f0-9]{40}$/;
const hash=/^[a-f0-9]{64}$/;
const limits={unitWorkers:16,cpu:30,memoryMiB:114688,workMiB:65536,tmpMiB:8192,homeMiB:1024,pids:4096,shmMiB:2048};
const electronFiles=['file-download','canonical-input','provider-auth-terminal','agents-providers-figma','agents-providers-button-contrast','provider-settings-idle','project-folder-picker-layout','terminal-file-drop','terminal-snapshot','release-alignment','chat-title-layout','terminal-clipboard'].map(name=>`tests/e2e/desktop/${name}.e2e.test.ts`).concat('tests/e2e/provider-authorization-electron.e2e.test.ts').sort();
const reports=['unit','general','grid','electron-download','electron-input','electron-providers','electron-folder','electron-clipboard','electron-drop','electron-snapshot','electron-release','electron-title'];
const integer=value=>Number.isSafeInteger(value)&&value>=0;
export function canonicalRequest(value){
 if(Array.isArray(value))return JSON.stringify(value.map(item=>JSON.parse(canonicalRequest(item))));
 if(value&&typeof value==='object')return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,JSON.parse(canonicalRequest(item))])));
 return JSON.stringify(value);
}
export function validateLeaseRequest(value){
 const keys=['repository','prNumber','headSha','baseSha','baseRef','mergeSha','mergeParents','requestingRunId','requestingRunAttempt','controllerRunId','controllerRunAttempt','controllerSha','controllerRef','controllerWorkflow','imageDigest','harnessDigest','mode','suite','limits'];
 if(!value||canonicalRequest(Object.keys(value).sort())!==canonicalRequest(keys.sort())||value.repository!=='HamedMP/matrix-os'||value.suite!=='qualification'||!['shadow','delegated'].includes(value.mode)||value.controllerRef!=='refs/heads/main'||value.controllerWorkflow!=='.github/workflows/ci-dedicated.yml'||![value.headSha,value.baseSha,value.mergeSha,value.controllerSha].every(v=>sha.test(v||''))||![value.prNumber,value.requestingRunId,value.requestingRunAttempt,value.controllerRunId,value.controllerRunAttempt].every(v=>integer(v)&&v>0)||value.prNumber>1_000_000||typeof value.baseRef!=='string'||value.baseRef.length>1024||!value.baseRef||/[\x00-\x20\x7f~^:?*\[\\]/.test(value.baseRef)||value.baseRef.includes('..')||value.baseRef.includes('@{')||value.baseRef.endsWith('/')||value.baseRef.endsWith('.')||!/^sha256:[a-f0-9]{64}$/.test(value.imageDigest||'')||!hash.test(value.harnessDigest||'')||canonicalRequest(value.mergeParents)!==canonicalRequest([value.baseSha,value.headSha])||canonicalRequest(value.limits)!==canonicalRequest(limits))throw new Error('Invalid exact Linux lease request');
 return value;
}
export function verifyLeaseReceipt(receipt,envelope){
 const {request,leaseId}=envelope;const digest=createHash('sha256').update(canonicalRequest(request)).digest('hex');
 if(!receipt||receipt.schemaVersion!==1||receipt.leaseId!==leaseId||receipt.requestDigest!==digest||canonicalRequest(receipt.request)!==canonicalRequest(request)||receipt.qualified!==true||receipt.exitCode!==0||receipt.sourceSha!==request.mergeSha||canonicalRequest(receipt.parents)!==canonicalRequest(request.mergeParents)||receipt.imageDigest!==request.imageDigest||receipt.harnessDigest!==request.harnessDigest||![receipt.lockSha256,receipt.inventorySha256].every(v=>hash.test(v||''))||receipt.phaseCount!==55||receipt.guardCount!==14||receipt.independentHostSourceChecks!==4||receipt.allPhasesPassed!==true||receipt.allGuardsClean!==true||receipt.containerGone!==true||![receipt.queueSeconds,receipt.wallSeconds].every(integer)||receipt.wallSeconds<1||!Number.isFinite(Date.parse(receipt.startedUtc))||!Number.isFinite(Date.parse(receipt.finishedUtc))||Date.parse(receipt.finishedUtc)<Date.parse(receipt.startedUtc)||canonicalRequest(receipt.requiredElectronFiles)!==canonicalRequest(electronFiles))throw new Error('Invalid complete qualification receipt');
 if(canonicalRequest(Object.keys(receipt.reports??{}).sort())!==canonicalRequest(reports.slice().sort()))throw new Error('Incomplete qualification evidence reports');
 for(const [name,report] of Object.entries(receipt.reports)){
  if(![report.files,report.total,report.passed,report.skipped,report.failed].every(integer)||report.files<1||report.files>10000||report.total<1||report.total>1000000||report.passed<1||report.failed!==0||report.total!==report.passed+report.skipped||report.inventoryComplete!==true||(name.startsWith('electron-')&&report.files!==(name==='electron-providers'?5:1)))throw new Error('Invalid observed qualification evidence counts');
 }
 const smoke=receipt.smoke;
 if(!smoke||!integer(smoke.comparedExports)||smoke.comparedExports<1||smoke.svgRenderComparisons!==smoke.comparedExports||!integer(smoke.distinctIconModules)||smoke.distinctIconModules<1||smoke.missingExportControl!=='rejected'||smoke.negativeAliasControl!=='rejected')throw new Error('Incomplete real production icon evidence');
 return receipt;
}
export async function runDedicatedLeaseSession(child,envelope,options){
 validateLeaseRequest(envelope.request);
 if(envelope.protocolVersion!==1||!/^[a-f0-9]{32}$/.test(envelope.leaseId||'')||!hash.test(envelope.capability||''))throw new Error('Invalid Linux owner capability');
 const digest=createHash('sha256').update(canonicalRequest(envelope.request)).digest('hex');
 const timeout=options.maxMilliseconds??3_900_000;if(!integer(timeout)||timeout<1||timeout>3_900_000)throw new Error('Invalid lease session deadline');
 return new Promise((resolve,reject)=>{
  let buffer='',bytes=0,state='initial',terminal=null,ended=false,failed=false;
  const challenges=new Set();let chain=Promise.resolve(),killTimer;const decoder=new TextDecoder('utf-8',{fatal:true});
  const finish=error=>{if(failed)return;failed=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);child.stdin.end();child.kill('SIGTERM');if(!ended){killTimer=setTimeout(()=>child.kill('SIGKILL'),5000);killTimer.unref?.();}reject(error);};
  const abort=()=>finish(new Error('Controller cancelled its Linux lease'));
  const timer=setTimeout(()=>finish(new Error('Linux lease session deadline exceeded')),timeout);timer.unref?.();
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted){abort();return;}
  const revalidate=async(record,unconditional)=>{
   const maximum=record.type==='locked'?25000:90000;
   const cycle=options.maxCycleMilliseconds??maximum;
   if(!integer(cycle)||cycle<1||cycle>maximum)throw new Error('Invalid authenticated API cycle bound');
   let deadline;
   try{await Promise.race([options.revalidate(envelope.request,{unconditional}),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Authenticated API cycle deadline exceeded')),Math.min(cycle,record.deadlineUnixMs?record.deadlineUnixMs-Date.now():cycle));})]);}
   finally{clearTimeout(deadline);}
  };
  const processRecord=async record=>{
   if(failed)return;
   if(record.protocolVersion!==1||record.leaseId!==envelope.leaseId||record.requestDigest!==digest||JSON.stringify(record).includes(envelope.capability)||terminal)throw new Error('Unbound or replayed lease control record');
   if(record.type==='queued'&&state==='initial'){state='queued';return;}
   if((record.type==='locked'&&state==='queued')||(record.type==='renewal-required'&&state==='running')){
    if(!hash.test(record.challenge||'')||challenges.has(record.challenge)||challenges.size>=400||!integer(record.deadlineUnixMs)||record.deadlineUnixMs<=Date.now()||record.deadlineUnixMs>Date.now()+(record.type==='locked'?31000:121000))throw new Error('Expired or reused Linux lease challenge');
    challenges.add(record.challenge);
    await revalidate(record,record.type==='locked');
    if(failed||ended||record.deadlineUnixMs<=Date.now())throw new Error('Lease challenge expired before authenticated revalidation');
    child.stdin.write(JSON.stringify({protocolVersion:1,type:record.type==='locked'?'grant':'renew',leaseId:envelope.leaseId,requestDigest:digest,challenge:record.challenge,capability:envelope.capability})+'\n');
    if(record.type==='locked')state='granted';return;
   }
   if(record.type==='running'&&state==='granted'){state='running';return;}
   if(record.type==='completed'&&state==='running'&&record.status===0){terminal=verifyLeaseReceipt(record.receipt,envelope);await revalidate(record,true);return;}
   if(['failed','cancelled'].includes(record.type))throw new Error('Owned Linux qualification did not complete');
   throw new Error('Unexpected Linux lease control transition');
  };
  child.stdout.on('data',data=>{
   if(failed)return;bytes+=data.length;if(bytes>1024*1024){finish(new Error('Linux control stream exceeds bound'));return;}
   try{buffer+=decoder.decode(data,{stream:true});}catch(error){finish(new Error('Invalid UTF-8 Linux control stream'));return;}
   if(buffer.split('\n').some(line=>Buffer.byteLength(line)>32768)){finish(new Error('Linux control record exceeds bound'));return;}
   let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);chain=chain.then(()=>{let record;try{record=JSON.parse(line);}catch(error){if(error instanceof SyntaxError)throw new Error('Malformed Linux control record');throw error;}return processRecord(record);}).catch(finish);}
  });
  child.stderr.on('data',()=>{}); // Never expose raw SSH/provider output or capability material.
  child.on('error',()=>finish(new Error('Pinned SSH connection failed')));
  child.stdin.on('error',()=>finish(new Error('Linux lease control input closed')));
  child.on('close',code=>{
   ended=true;clearTimeout(killTimer);try{buffer+=decoder.decode();}catch(error){finish(new Error('Incomplete UTF-8 Linux control stream'));return;}chain.then(()=>{if(failed)return;if(code!==0||buffer||!terminal){finish(new Error('Linux disconnected without a complete trusted receipt'));return;}clearTimeout(timer);options.signal?.removeEventListener('abort',abort);child.stdin.end();resolve(terminal);}).catch(finish);
  });
  child.stdin.write(JSON.stringify(envelope)+'\n');
 });
}
export async function dispatchDedicatedLease(github,input,options={}){
 const value=validateLeaseRequest(input.request);
 const {host,key,knownHosts}=input.ssh;
 if(!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host||'')||typeof key!=='string'||!key||key.length>16384||typeof knownHosts!=='string'||!knownHosts||knownHosts.length>16384)throw new Error('Pinned SSH connection is not configured');
 const envelope={protocolVersion:1,leaseId:randomBytes(16).toString('hex'),capability:randomBytes(32).toString('hex'),request:value};
 const digest=createHash('sha256').update(canonicalRequest(value)).digest('hex');
 const directory=await mkdtemp(join(tmpdir(),'matrix-ci-lease-'));const aborter=new AbortController();
 const api=createConditionalGithub(github,{authenticationContext:`controller-${value.controllerRunId}-${value.controllerRunAttempt}`,signal:aborter.signal});
 const stop=()=>aborter.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{
  await writeFile(join(directory,'key'),key,{mode:0o600,flag:'wx'});await writeFile(join(directory,'hosts'),knownHosts,{mode:0o600,flag:'wx'});
  const args=['-i',join(directory,'key'),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${join(directory,'hosts')}`,'-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',`matrixci@${host}`];
  const child=spawn('ssh',[...args,`lease-v1 run ${envelope.leaseId}`],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});
  try{return await runDedicatedLeaseSession(child,envelope,{signal:aborter.signal,revalidate:(request,cycle)=>cycle.unconditional?api.runUnconditional(()=>verifyDedicatedLeaseGrant(api.github,input.repo,input.controller,request)):verifyDedicatedLeaseGrant(api.github,input.repo,input.controller,request)});}
  catch(error){
   aborter.abort();
   // EOF already revokes the streamed lease. Also authenticate exact-owner
   // cancellation over an independent bounded SSH session when available.
   await new Promise(resolve=>{const cancel=spawn('ssh',[...args,`lease-v1 cancel ${envelope.leaseId}`],{stdio:['pipe','ignore','ignore'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});const timer=setTimeout(()=>{cancel.kill('SIGKILL');resolve();},20000);cancel.on('error',()=>{clearTimeout(timer);resolve();});cancel.on('close',()=>{clearTimeout(timer);resolve();});cancel.stdin.on('error',()=>{});cancel.stdin.end(JSON.stringify({protocolVersion:1,leaseId:envelope.leaseId,requestDigest:digest,capability:envelope.capability})+'\n');});
   throw error;
  }
 }finally{options.metrics?.(api.metrics());process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await rm(directory,{recursive:true,force:true});}
}
