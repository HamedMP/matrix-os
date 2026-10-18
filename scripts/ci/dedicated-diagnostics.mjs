import {createHash} from 'node:crypto';

// Fixed reviewed labels mirror qualification/contract.py. No candidate-provided
// keys, paths, messages or tool output may become summary Markdown.
const lanes=['unit','mechanical','web','e2e'];
export const diagnosticPhases=Object.freeze({
 setup:Object.freeze(['checkout',...lanes.flatMap(lane=>['install','source'].map(p=>`${p}-${lane}`)),...lanes.flatMap(lane=>['prerequisites','brand-build','source-prerequisites'].map(p=>`${p}-${lane}`)),'unit-source-immutability','browsers','shell-browsers','postgres-start']),
 unit:Object.freeze(['unit','docs-parity-proof','source-coverage-proof','source-after-unit']),
 mechanical:Object.freeze(['typecheck','sync-build','sync-test','sync-publish','sdk-install','sdk','source-after-mechanical']),
 web:Object.freeze(['shell','source-after-web']),
 e2e:Object.freeze(['general','grid','source-before-desktop','desktop-build','electron-download','electron-input','electron-providers','electron-folder','electron-clipboard','electron-drop','electron-snapshot','source-before-release','electron-release','electron-title','source-after-e2e']),
 cleanup:Object.freeze(['postgres-stop']),smoke:Object.freeze(['icons']),
});
const phaseNames=Object.values(diagnosticPhases).flat();
const unavailableReasons=['unsupported_cgroup','unavailable','invalid_metrics','container_identity_mismatch'];
const canonical=value=>JSON.stringify(Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,JSON.parse(canonical(item))])):value);
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&canonical(Object.keys(value).sort())===canonical(keys.slice().sort());
const bounded=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const invalid=()=>{throw new Error('Invalid receipt-bound qualification diagnostics');};

export function verifyQualificationDiagnostics(value,receipt){
 const keys=['schemaVersion','kind','leaseId','requestDigest','sourceSha','imageDigest','harnessDigest','receiptSha256','queueSeconds','wallSeconds','phaseSeconds','phaseTimeline','memory'];
 if(!exact(value,keys)||value.schemaVersion!==1||value.kind!=='qualification-diagnostics')invalid();
 for(const key of ['leaseId','requestDigest','sourceSha','imageDigest','harnessDigest','queueSeconds','wallSeconds'])if(value[key]!==receipt[key])invalid();
 if(value.receiptSha256!==createHash('sha256').update(canonical(receipt)).digest('hex')||!bounded(value.queueSeconds,1800)||!bounded(value.wallSeconds,1900)||value.wallSeconds<1)invalid();
 if(!exact(value.phaseSeconds,phaseNames)||!Object.values(value.phaseSeconds).every(seconds=>bounded(seconds,1800)))invalid();
 if(value.phaseTimeline!==null){
  if(!exact(value.phaseTimeline,phaseNames))invalid();
  const started=Date.parse(receipt.startedUtc),finished=Date.parse(receipt.finishedUtc);
  if(!Number.isFinite(started)||!Number.isFinite(finished))invalid();
  for(const name of phaseNames){
   const span=value.phaseTimeline[name];
   if(!exact(span,['startedUnixMs','finishedUnixMs'])||![span.startedUnixMs,span.finishedUnixMs].every(ms=>bounded(ms,Number.MAX_SAFE_INTEGER))||span.startedUnixMs<started-5000||span.finishedUnixMs>finished+5000||span.finishedUnixMs<span.startedUnixMs||span.finishedUnixMs-span.startedUnixMs>1800000||Math.abs(value.phaseSeconds[name]-(Math.floor(span.finishedUnixMs/1000)-Math.floor(span.startedUnixMs/1000)))>1)invalid();
  }
 }
 const memory=value.memory;
 if(memory?.status==='unavailable'){
  if(!exact(memory,['status','reason'])||!unavailableReasons.includes(memory.reason))invalid();
 }else{
  const limit=receipt.request?.limits?.memoryMiB*1024*1024;
  if(!exact(memory,['status','measurement','peakBytes','limitBytes','swapPeakBytes','events'])||memory.status!=='available'||memory.measurement!=='cgroup-v2'||!bounded(limit,2**50)||limit<1||memory.limitBytes!==limit||!bounded(memory.peakBytes,2**50)||(memory.swapPeakBytes!==null&&!bounded(memory.swapPeakBytes,2**50))||!exact(memory.events,['oom','oomKill'])||![memory.events.oom,memory.events.oomKill].every(count=>bounded(count,2**50)))invalid();
 }
 return value;
}

// Called only with verified diagnostics; every rendered label comes from the
// fixed table above and every rendered value is a bounded number or fixed text.
export function qualificationDiagnosticsSummary(value){
 const rows=['### Qualification diagnostics','','Advisory metrics; qualification checks are unchanged.','',`Queue: **${value.queueSeconds}s** · Workload: **${value.wallSeconds}s**`,'','| Lane | Phase sum | Lane span |','| --- | ---: | ---: |'];
 const spans={};
 for(const [lane,names] of Object.entries(diagnosticPhases)){
  const sum=names.reduce((total,name)=>total+value.phaseSeconds[name],0);
  const span=value.phaseTimeline?Math.ceil((Math.max(...names.map(name=>value.phaseTimeline[name].finishedUnixMs))-Math.min(...names.map(name=>value.phaseTimeline[name].startedUnixMs)))/1000):null;
  if(lanes.includes(lane)&&span!==null)spans[lane]=span;
  rows.push(`| ${lane} | ${sum}s | ${span===null?'unavailable':`${span}s`} |`);
 }
 if(Object.keys(spans).length){const [lane,seconds]=Object.entries(spans).sort((a,b)=>b[1]-a[1])[0];rows.push('',`Longest concurrent lane (advisory): **${lane} (${seconds}s span)**. Spans include gaps and overlap across lanes.`);}
 else rows.push('','Longest concurrent lane: **timeline unavailable**. Phase sums cannot establish the critical path.');
 rows.push('','| Phase | Duration |','| --- | ---: |');
 for(const name of phaseNames)rows.push(`| ${name} | ${value.phaseSeconds[name]}s |`);
 if(value.memory.status==='available'){
  const memory=value.memory,gib=bytes=>(bytes/1024**3).toFixed(2);
  rows.push('',`Memory (cgroup-v2): **${gib(memory.peakBytes)} GiB / ${gib(memory.limitBytes)} GiB** peak / limit. Swap peak: ${memory.swapPeakBytes===null?'unavailable':`${gib(memory.swapPeakBytes)} GiB`}. OOM: ${memory.events.oom}; OOM kills: ${memory.events.oomKill}.`);
 }else rows.push('','Memory: **unavailable** (bounded host measurement unavailable).');
 rows.push('','Memory covers the qualification container cgroup, includes tmpfs and file cache, and excludes separate host helper processes.');
 return rows.join('\n')+'\n';
}
