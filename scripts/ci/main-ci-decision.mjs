// The real main detector publishes its selected scope; the App never infers it from skips.
import {mkdir,lstat,writeFile,unlink,rmdir} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {downloadControllerReceipt} from './dedicated-artifact.mjs';
import {HOSTED_LANES} from './dedicated-hosted.mjs';
const request={timeout:10000},sha=/^[a-f0-9]{40}$/;
const id=value=>Number.isSafeInteger(value)&&value>0;
const bool=value=>{if(!['true','false'].includes(value))throw new Error('Invalid main coverage decision boolean');return value==='true';};
const keys=['schemaVersion','sourceKind','repository','workflowRef','sourceSha','requestingRunId','requestingRunAttempt','coverageBaseSha','bootstrap','shouldRun','docsContractTests','osViewParityTests','dedicatedEligible','dedicatedRequired'];
function assertDecision(value,repo,run){
 if(!value||typeof value!=='object'||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||value.schemaVersion!==1||value.sourceKind!=='main'||value.repository!==`${repo.owner}/${repo.repo}`||value.workflowRef!==`${repo.owner}/${repo.repo}/.github/workflows/ci.yml@refs/heads/main`||value.sourceSha!==run.head_sha||!sha.test(value.sourceSha||'')||value.requestingRunId!==run.id||value.requestingRunAttempt!==run.run_attempt||!sha.test(value.coverageBaseSha||''))throw new Error('Main coverage decision identity mismatch');
 for(const key of keys.slice(8))if(typeof value[key]!=='boolean')throw new Error('Invalid main coverage decision boolean');
 if(!value.osViewParityTests||(!value.shouldRun&&(value.dedicatedEligible||value.dedicatedRequired)))throw new Error('Main coverage routing contradicts selected scope');
}
function artifactDirectory(env){
 if(!isAbsolute(env.RUNNER_TEMP||''))throw new Error('Missing bounded main coverage temp directory');
 return join(env.RUNNER_TEMP,'main-ci-decision');
}
export async function writeMainCiDecision(env){
 if(env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_REF!=='refs/heads/main'||!/^([1-9][0-9]{0,15})$/.test(env.GITHUB_RUN_ID||'')||!/^([1-9][0-9]{0,8})$/.test(env.GITHUB_RUN_ATTEMPT||''))throw new Error('Main coverage proof requires an exact main push');
 const value={schemaVersion:1,sourceKind:'main',repository:env.GITHUB_REPOSITORY,workflowRef:env.GITHUB_WORKFLOW_REF,sourceSha:env.GITHUB_SHA,requestingRunId:Number(env.GITHUB_RUN_ID),requestingRunAttempt:Number(env.GITHUB_RUN_ATTEMPT),coverageBaseSha:env.COVERAGE_BASE_SHA,bootstrap:bool(env.COVERAGE_BOOTSTRAP),shouldRun:bool(env.SHOULD_RUN),docsContractTests:bool(env.DOCS_CONTRACT_TESTS),osViewParityTests:bool(env.OS_VIEW_PARITY_TESTS),dedicatedEligible:bool(env.DEDICATED_ELIGIBLE),dedicatedRequired:bool(env.DEDICATED_REQUIRED)};
 const [owner,repo,...extra]=(env.GITHUB_REPOSITORY||'').split('/');if(!owner||!repo||extra.length||!id(value.requestingRunId)||!id(value.requestingRunAttempt))throw new Error('Invalid main coverage repository/run');
 assertDecision(value,{owner,repo},{id:value.requestingRunId,run_attempt:value.requestingRunAttempt,head_sha:env.GITHUB_SHA});
 const directory=artifactDirectory(env);await mkdir(directory,{mode:0o700,recursive:true});const stat=await lstat(directory);
 if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Unsafe main coverage temp directory');
 const bytes=JSON.stringify(value)+'\n';if(Buffer.byteLength(bytes)>4096)throw new Error('Main coverage decision exceeds bound');
 await writeFile(join(directory,'receipt.json'),bytes,{flag:'wx',mode:0o600});return value;
}
export async function cleanupMainCiDecision(env){
 const directory=artifactDirectory(env);
 let stat;try{stat=await lstat(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Unsafe main coverage cleanup directory');
 try{const file=join(directory,'receipt.json'),entry=await lstat(file);if(entry.isSymbolicLink()||!entry.isFile())throw new Error('Unsafe main coverage cleanup file');await unlink(file);}catch(error){if(error.code!=='ENOENT')throw error;}
 await rmdir(directory);
}
function exactJob(job,run){return id(job.id)&&job.run_id===run.id&&job.run_attempt===run.run_attempt&&job.head_sha===run.head_sha&&job.status==='completed';}
function selectedJob(jobs,name,run){const matches=jobs.filter(job=>job.name===name);if(matches.length!==1||!exactJob(matches[0],run)||matches[0].conclusion!=='success')throw new Error('Selected main coverage job failed or stale');return matches[0];}
async function verifyAggregate(github,repo,jobs,run){
 const aggregate=selectedJob(jobs,'CI Results',run),prefix=`https://api.github.com/repos/${repo.owner}/${repo.repo}/check-runs/`;
 if(!aggregate.check_run_url?.startsWith(prefix))throw new Error('Main aggregate identity missing');const checkId=Number(aggregate.check_run_url.slice(prefix.length));if(!id(checkId))throw new Error('Invalid main aggregate check identity');
 const {data:check}=await github.rest.checks.get({...repo,check_run_id:checkId,request});
 if(check.id!==checkId||check.name!=='CI Results'||check.app?.slug!=='github-actions'||check.head_sha!==run.head_sha||check.status!=='completed'||check.conclusion!=='success'||!check.details_url?.startsWith(`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id}/`))throw new Error('Main aggregate is not genuine');
}
const exactKeys=(value,wanted)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===wanted.length&&wanted.every(key=>Object.hasOwn(value,key));
const sourceKeys=['sourceKind','headSha','sourceSha','baseSha','mergeParents'];
const controllerKeys=['sha','ref','workflow','imageDigest','harnessDigest','mode'];
const artifactKeys=['id','name','digest'];
const proofKeys=['schemaVersion','origin','qualified','qualifiedAt','decision','artifact','source','controller'];
function proofSource(snapshot){return Object.fromEntries(sourceKeys.map(key=>[key,snapshot[key]]));}
function proofController(controller,config,mode){return{sha:controller.sha,ref:controller.ref,workflow:'.github/workflows/ci-dedicated.yml',imageDigest:config.imageDigest,harnessDigest:config.harnessDigest,mode};}
// Only ownedGate's authenticated checks-only App history may supply this proof.
// The original-success marker survives red rechecks; it never replaces live workload checks.
export function authenticatedMainDecisionProof(prior,repo,run,snapshot,controller,config,mode){
 const proof=prior?.evidence?.coverageProof;if(!proof||!id(run?.id)||!id(run?.run_attempt)||!sha.test(run?.head_sha||''))return null;
 if(prior.check.status!=='completed'||!(['success','failure'].includes(prior.check.conclusion)||(prior.check.conclusion==='neutral'&&prior.evidence.shadowUnverified===true))||prior.evidence.notApplicable===true||!exactKeys(proof,proofKeys)||proof.schemaVersion!==1||proof.origin!=='main-ci-decision-artifact-v1'||proof.qualified!==true||typeof proof.qualifiedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(proof.qualifiedAt)||!Number.isFinite(Date.parse(proof.qualifiedAt))||Date.parse(proof.qualifiedAt)>Date.now()+30000||Buffer.byteLength(JSON.stringify(proof))>3072)return null;
 if(!exactKeys(proof.source,sourceKeys)||proof.source.sourceKind!=='main'||![proof.source.headSha,proof.source.sourceSha,proof.source.baseSha].every(value=>sha.test(value||''))||proof.source.headSha!==proof.source.sourceSha||!Array.isArray(proof.source.mergeParents)||proof.source.mergeParents.length<1||proof.source.mergeParents.length>2||!proof.source.mergeParents.every(value=>sha.test(value||'')&&value!==proof.source.sourceSha)||new Set(proof.source.mergeParents).size!==proof.source.mergeParents.length||proof.source.baseSha!==proof.source.mergeParents[0])return null;
 if(sourceKeys.some(key=>JSON.stringify(proof.source[key])!==JSON.stringify(snapshot[key])||JSON.stringify(proof.source[key])!==JSON.stringify(prior.evidence[key])))return null;
 if(!exactKeys(proof.controller,controllerKeys)||JSON.stringify(proof.controller)!==JSON.stringify(proofController(controller,config,mode))||prior.evidence.controllerSha!==controller.sha||prior.evidence.controllerRef!==controller.ref||prior.evidence.qualificationMode!==mode)return null;
 if(!exactKeys(proof.artifact,artifactKeys)||!id(proof.artifact.id)||!/^sha256:[a-f0-9]{64}$/.test(proof.artifact.digest||'')||proof.artifact.name!==`main-ci-decision-${run.head_sha}-${run.id}-${run.run_attempt}`||prior.evidence.requestingRunId!==run.id||prior.evidence.requestingRunAttempt!==run.run_attempt)return null;
 try{assertDecision(proof.decision,repo,run);}catch(error){if(!(error instanceof Error))throw error;console.warn('Durable main coverage proof rejected',{stage:'decision-schema'});return null;}
 return proof;
}
function verifiedProof(decision,artifact,context){
 return{schemaVersion:1,origin:'main-ci-decision-artifact-v1',qualified:true,qualifiedAt:new Date().toISOString(),decision,artifact:Object.fromEntries(artifactKeys.map(key=>[key,artifact[key]])),source:proofSource(context.snapshot),controller:proofController(context.controller,context.config,context.mode)};
}

export async function verifyMainCiDecision(github,repo,run,context){
 if(!id(run.id)||!id(run.run_attempt)||!sha.test(run.head_sha||'')||run.event!=='push'||run.head_branch!=='main'||run.status!=='completed'||run.conclusion!=='success')throw new Error('Invalid main coverage requesting run');
 const {data}=await github.rest.actions.listJobsForWorkflowRun({...repo,run_id:run.id,filter:'latest',per_page:100,request});
 if(!Number.isSafeInteger(data.total_count)||data.total_count>100||!Array.isArray(data.jobs)||data.jobs.length!==data.total_count)throw new Error('Main coverage job inventory incomplete');
 const detector=selectedJob(data.jobs,'Detect CI-relevant changes',run);
 for(const name of ['Detect source changes','Select guarded Linux delegation','Record exact main coverage decision','Upload exact main coverage decision']){
  const matches=detector.steps?.filter(step=>step.name===name);if(matches?.length!==1||matches[0].status!=='completed'||matches[0].conclusion!=='success')throw new Error('Actual main detector proof step missing');
 }
 const {data:inventory}=await github.rest.actions.listWorkflowRunArtifacts({...repo,run_id:run.id,per_page:100,request});
 if(!Number.isSafeInteger(inventory.total_count)||inventory.total_count>100||!Array.isArray(inventory.artifacts)||inventory.artifacts.length!==inventory.total_count)throw new Error('Main coverage artifact inventory incomplete');
 const cached=context?authenticatedMainDecisionProof(context.prior,repo,run,context.snapshot,context.controller,context.config,context.mode):null;
 const matches=inventory.artifacts.filter(artifact=>artifact.name===`main-ci-decision-${run.head_sha}-${run.id}-${run.run_attempt}`);
 if(matches.length>1||(!matches.length&&!cached))throw new Error('Main coverage decision artifact missing or duplicated');
 const artifact=matches[0];
 if(artifact&&(!id(artifact.id)||![true,false].includes(artifact.expired)||!Number.isSafeInteger(artifact.size_in_bytes)||artifact.size_in_bytes<1||artifact.size_in_bytes>16384||artifact.workflow_run?.id!==run.id||artifact.workflow_run?.head_sha!==run.head_sha||!/^sha256:[a-f0-9]{64}$/.test(artifact.digest||'')))throw new Error('Main coverage artifact provenance mismatch');
 if(artifact&&cached&&artifactKeys.some(key=>artifact[key]!==cached.artifact[key]))throw new Error('Authenticated main decision artifact changed');
 if(artifact?.expired&&!cached)throw new Error('Main coverage decision artifact expired before qualification');
 // Only absence/explicit expiry can reuse previously verified bytes, never an API failure.
 const reused=!artifact||artifact.expired;
 const decision=reused?cached.decision:await downloadControllerReceipt(github,repo,artifact);assertDecision(decision,repo,run);
 const coverageProof=context?(cached??verifiedProof(decision,artifact,context)):undefined;
 if(decision.shouldRun)return{...decision,coverageProof};
 for(const job of data.jobs){
  if(!exactJob(job,run)||!['success','skipped'].includes(job.conclusion))throw new Error('Main docs coverage contains failed or stale work');
  const unselected=HOSTED_LANES.includes(job.name)&&!['Docs Contract Tests','OS View Parity'].includes(job.name)||/^Unit Tests \(|^E2E Tests(?: \(|$)/.test(job.name)||job.name==='Verified Dedicated Linux Qualification';
  if(unselected&&job.conclusion!=='skipped')throw new Error('Main docs decision contradicts source workload execution');
 }
 const selected=['OS View Parity',...(decision.docsContractTests?['Docs Contract Tests']:[])];for(const name of selected)selectedJob(data.jobs,name,run);
 if(!decision.docsContractTests&&data.jobs.some(job=>job.name==='Docs Contract Tests'&&job.conclusion!=='skipped'))throw new Error('Unselected docs contract job executed');
 await verifyAggregate(github,repo,data.jobs,run);return{...decision,selectedHostedLaneCount:selected.length,coverageProof};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv[2]==='--cleanup')await cleanupMainCiDecision(process.env);else await writeMainCiDecision(process.env);
}
