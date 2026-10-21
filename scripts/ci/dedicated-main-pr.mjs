import {isolatedRunPin,verifyRunExecution} from './dedicated-isolated.mjs';
// A PR targeting main qualifies its immutable tested merge, not every later
// main tip. Stack parents retain the stricter live-source policy.
import {logGateEvent} from './gate-log.mjs';
import {readCurrentBranchSha} from './dedicated-branch.mjs';
import {newestWorkflowRun} from './dedicated-history.mjs';
import {hasMainSourceProvenance,recordedMainSources,MAIN_SOURCE_BINDING_LIMIT,waitForMainSourceProvenance} from './dedicated-main-provenance.mjs';
const request={timeout:10_000};
const sha=/^[a-f0-9]{40}$/;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const id=value=>Number.isSafeInteger(value)&&value>0;
const paths=['.github/workflows/ci.yml','.github/workflows/ci.yml@main','.github/workflows/ci.yml@refs/heads/main'];

export function mainPrRequest(run,repo,snapshot,workflow,options={}){
 const fullName=`${repo.owner}/${repo.repo}`,headRepository=snapshot.headRepository??fullName;
 if(snapshot.baseRef!=='main'||!id(run?.id)||run.workflow_id!==workflow.id||!paths.includes(run.path)||!same(run.repository?.full_name,fullName)||!same(run.head_repository?.full_name,headRepository))return null;
 if(run.event==='pull_request'){
  if((options.executionMode==='hosted-only'&&!options.allModes)||run.head_sha!==snapshot.headSha||run.head_branch!==snapshot.headRef)return null;
  const association=run.pull_requests?.some(pull=>pull.number===snapshot.prNumber&&pull.head?.sha===snapshot.headSha&&pull.base?.ref==='main');
  const fork=!same(headRepository,fullName)&&Array.isArray(run.pull_requests)&&run.pull_requests.length===0;
  const title=run.display_title?.match(/^CI coverage-v1 · ([a-f0-9]{40})$/);
  return title&&(association||fork)?{...snapshot,sourceSha:title[1]}:null;
 }
 if(run.event!=='workflow_dispatch'||!same(headRepository,fullName)||(run.head_branch!=='main'&&!isolatedRunPin(run))||!sha.test(run.head_sha||''))return null;
 const title=run.display_title?.match(/^CI (hosted-refresh-v1|refresh-v1) pr=([1-9][0-9]{0,5}) head=([a-f0-9]{40}) base=([a-f0-9]{40}) merge=([a-f0-9]{40})$/);
 if(!title||Number(title[2])!==snapshot.prNumber||title[3]!==snapshot.headSha||(!options.allModes&&(title[1]==='hosted-refresh-v1')!==(options.executionMode==='hosted-only')))return null;
 return {...snapshot,baseSha:title[4],sourceSha:title[5],...(title[1]==='hosted-refresh-v1'?{executionMode:'hosted-only'}:{})};
}

export async function mainPrCoverage(github,repo,snapshot,options={}){
 const {data:workflow}=await github.rest.actions.getWorkflow({...repo,workflow_id:'ci.yml',request});
 if(!id(workflow.id)||workflow.path!=='.github/workflows/ci.yml')throw new Error('Unexpected main PR CI workflow');
 const run=await newestWorkflowRun(github,repo,workflow,async candidate=>{
  if(candidate.id===options.excludeRunId||!mainPrRequest(candidate,repo,snapshot,workflow,options))return false;
  await verifyRunExecution(github,repo,candidate,'.github/workflows/ci.yml');
  return options.afterId===undefined||(candidate.id>options.afterId&&Number.isFinite(Date.parse(candidate.created_at))&&Date.parse(candidate.created_at)>=Date.parse(options.notBefore));
 },{kind:'requester',headSha:snapshot.headSha,headRef:snapshot.headRef,controllerSha:options.controllerSha??snapshot.executionControllerSha});
 if(!run)return null;
 return mainPrRunSource(github,repo,run,snapshot,workflow,options);
}

export async function mainPrRunSource(github,repo,run,snapshot,workflow,options={}){
 const value=mainPrRequest(run,repo,snapshot,workflow,options);
 if(!value)throw new Error('Main PR requester is not authenticated');
 await verifyRunExecution(github,repo,run,'.github/workflows/ci.yml');
 const {data:merge}=await github.rest.repos.getCommit({...repo,ref:value.sourceSha,request});
 const parents=merge.parents?.map(parent=>parent.sha);
 if(merge.sha!==value.sourceSha||!Array.isArray(parents)||parents.length!==2||!parents.every(parent=>sha.test(parent||''))||parents[0]===parents[1]||parents[1]!==snapshot.headSha||(run.event==='workflow_dispatch'&&value.baseSha!==parents[0]))throw new Error('Main PR coverage merge is not bound to its tested source');
 const snapshotValue={...value,baseSha:parents[0],mergeParents:parents};
 const {data:pull}=await github.rest.pulls.get({...repo,pull_number:snapshot.prNumber,request});
 assertMainPrIdentity(repo,pull,snapshotValue,options.waitForProvenance===true);
 if(options.waitForProvenance&&pull.merge_commit_sha!==snapshotValue.sourceSha)await waitForCurrentMainSource(github,repo,snapshotValue,{delay:options.provenanceDelay});
 await verifyMainPrSnapshot(github,repo,pull,snapshotValue);
 return {run,snapshot:snapshotValue};
}

export function assertMainPrIdentity(repo,pull,snapshot,requireLabels=false){
 const fullName=`${repo.owner}/${repo.repo}`;
 if(snapshot.baseRef!=='main'||pull.base?.ref!=='main'||pull.number!==snapshot.prNumber||pull.state!=='open'||pull.draft!==false||pull.head?.sha!==snapshot.headSha||(snapshot.headRef!==undefined&&pull.head?.ref!==snapshot.headRef)||!same(pull.head?.repo?.full_name,snapshot.headRepository??fullName)||!same(pull.base?.repo?.full_name,fullName)||![snapshot.headSha,snapshot.baseSha,snapshot.sourceSha].every(value=>sha.test(value||''))||(requireLabels&&!['ready-for-ci','fast-ci'].every(name=>pull.labels?.some(label=>label.name===name))))throw new Error('Dedicated qualification revision or admission is stale');
}

export async function verifyMainPrSnapshot(github,repo,pull,snapshot,options={}){
 assertMainPrIdentity(repo,pull,snapshot);
 const {data:merge}=await github.rest.repos.getCommit({...repo,ref:snapshot.sourceSha,request:{...request,signal:AbortSignal.timeout(10_000)}});
 return verifyMainPrMerge(github,repo,pull,snapshot,options,merge);
}

// Only initial admission, journal and requester discovery resolve a new snapshot.
// Existing lease, receipt and explicit refresh inputs keep their exact tuple.
export async function resolveMainPrSnapshot(github,repo,pull,options={}){
 const candidate=options.eventPull??pull,fullName=`${repo.owner}/${repo.repo}`;
 const snapshot={prNumber:candidate.number,headSha:candidate.head?.sha,headRef:candidate.head?.ref,baseRef:candidate.base?.ref,baseSha:candidate.base?.sha,sourceSha:options.sourceSha??candidate.merge_commit_sha,
  ...(!same(candidate.head?.repo?.full_name,fullName)?{headRepository:candidate.head?.repo?.full_name}:{})};
 assertMainPrIdentity(repo,pull,snapshot);
 const {data:merge}=await github.rest.repos.getCommit({...repo,ref:snapshot.sourceSha,request:{...request,signal:AbortSignal.timeout(10_000)}});
 const parents=merge.parents?.map(parent=>parent.sha);
 if(!Array.isArray(parents)||parents.length!==2||!parents.every(parent=>sha.test(parent||'')))throw new Error('Merge commit ordered parents do not bind the tested main PR source');
 const resolved={...snapshot,baseSha:parents[0],mergeParents:parents};
 await verifyMainPrMerge(github,repo,pull,resolved,options,merge);
 return resolved;
}
async function verifyMainPrMerge(github,repo,pull,snapshot,options,merge){
 const fullName=`${repo.owner}/${repo.repo}`;
 assertMainPrIdentity(repo,pull,snapshot);
 const parents=merge.parents?.map(parent=>parent.sha);
 if(merge.sha!==snapshot.sourceSha||snapshot.baseSha===snapshot.headSha||JSON.stringify(parents)!==JSON.stringify([snapshot.baseSha,snapshot.headSha])||(snapshot.mergeParents!==undefined&&JSON.stringify(snapshot.mergeParents)!==JSON.stringify(parents)))throw new Error('Merge commit ordered parents do not bind the tested main PR source');
 // Only the trusted PTR caller supplies eventPull directly, never a serialized
 // lease/request snapshot or a workflow-run title. Later consumers use the App journal.
 const event=options.eventPull;
 const trustedEvent=event?.number===snapshot.prNumber&&event.head?.sha===snapshot.headSha&&event.base?.ref==='main'&&event.merge_commit_sha===snapshot.sourceSha&&same(event.head?.repo?.full_name,pull.head?.repo?.full_name)&&same(event.base?.repo?.full_name,fullName);
 // GitHub can retain an older pull.base.sha while regenerating merge_commit_sha.
 // The authenticated canonical pointer plus its verified ordered parents binds
 // the actual tested main base; the stored PR base is not that authority.
 const canonical=pull.merge_commit_sha===snapshot.sourceSha;
 if(!canonical&&!trustedEvent&&!await hasMainSourceProvenance(github,repo,{...snapshot,headRef:pull.head.ref}))throw new Error('Historical main source has no protected canonical provenance attestation');
 const main=await readCurrentBranchSha(github,repo,'main',request);
 if(main!==snapshot.baseSha){
  const {data:comparison}=await github.rest.repos.compareCommitsWithBasehead({...repo,basehead:`${snapshot.baseSha}...${main}`,per_page:1,request});
  if(!['ahead','identical'].includes(comparison.status)||comparison.merge_base_commit?.sha!==snapshot.baseSha)throw new Error('Tested main base is not an ancestor of current main');
 }
 return {...pull,mergeParents:parents,mainAdvanced:main!==snapshot.baseSha};
}

// Seed only from authenticated GitHub PR data, before looking at PR-controlled
// run titles. Retain older bindings when the bounded journal is full; an
// unrecorded historical source fails closed rather than evicting active CI.
export async function mainPrSourceBindings(github,repo,pull,prior,eventPull){
 const live={prNumber:pull.number,headSha:pull.head.sha,headRef:pull.head.ref,baseRef:pull.base.ref,baseSha:pull.base.sha,sourceSha:pull.merge_commit_sha,headRepository:pull.head.repo.full_name};
 const bindings=recordedMainSources(prior,live);
 if(live.baseRef!=='main')return [];
 const candidates=[pull];
 if(eventPull?.number===pull.number&&eventPull.head?.sha===pull.head.sha&&eventPull.base?.ref==='main')candidates.unshift(eventPull);
 for(const candidate of candidates){
  if(bindings.length>=MAIN_SOURCE_BINDING_LIMIT||bindings.some(value=>value.sourceSha===candidate.merge_commit_sha)||![candidate.merge_commit_sha,candidate.base?.sha].every(value=>sha.test(value||'')))continue;
  let snapshot;
  try{snapshot=await resolveMainPrSnapshot(github,repo,pull,candidate===eventPull?{eventPull}:{});}
  catch(error){if(!(error instanceof Error)||!bindings.length)throw error;logGateEvent('Retaining authenticated main PR provenance','canonical-source',error);continue;}
  bindings.push({baseSha:snapshot.baseSha,sourceSha:snapshot.sourceSha});
 }
 return bindings;
}

export async function waitForCurrentMainSource(github,repo,snapshot,options={}){
 return waitForMainSourceProvenance(github,repo,snapshot,{delay:options.delay,assertCurrent:async()=>{
  const {data:pull}=await github.rest.pulls.get({...repo,pull_number:snapshot.prNumber,request});
  assertMainPrIdentity(repo,pull,snapshot,true);
 }});
}
