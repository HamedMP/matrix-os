// The reviewed source authority remains Main. Auxiliary jobs execute on a
// distinct, protected, tree-identical child so their checks cannot attach to Main.
const sha=/^[a-f0-9]{40}$/;
const workflows=new Set(['.github/workflows/ci.yml','.github/workflows/ci-dedicated.yml','.github/workflows/preview-vps.yml']);
const request={timeout:10000};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const sameRepo=(name,repo)=>typeof name==='string'&&name.toLowerCase()===`${repo.owner}/${repo.repo}`.toLowerCase();
function require(value,message){if(!value)throw new Error(message);}

export function executionBranch(controllerSha){
 require(sha.test(controllerSha||''),'Invalid reviewed execution controller');
 return `ci-execution/${controllerSha}`;
}
export function executionControllerSha(ref){
 const match=typeof ref==='string'&&ref.match(/^refs\/heads\/ci-execution\/([a-f0-9]{40})$/);
 return match?match[1]:null;
}

export async function verifyIsolatedExecutionOrigin(github,repo,context,options){
 const pin=options?.controllerSha,path=options?.workflowPath;
 require(repo?.owner?.toLowerCase()==='hamedmp'&&repo?.repo?.toLowerCase()==='matrix-os'&&workflows.has(path),'Invalid isolated workflow repository or path');
 require(sha.test(pin||'')&&executionControllerSha(context?.ref)===pin&&sha.test(context?.sha||'')&&context.sha!==pin,'Invalid isolated execution ref or commit');
 require(context.workflowSha===context.sha&&context.workflowRef===`${repo.owner}/${repo.repo}/${path}@${context.ref}`,'Isolated workflow definition identity mismatch');
 const branch=executionBranch(pin);
 const {data:current}=await github.rest.repos.getBranch({...repo,branch,request});
 require(current?.name===branch&&current.commit?.sha===context.sha,'Isolated execution ref moved');
 const {data:commit}=await github.rest.git.getCommit({...repo,commit_sha:context.sha,request});
 const {data:controller}=await github.rest.git.getCommit({...repo,commit_sha:pin,request});
 require(commit?.sha===context.sha&&controller?.sha===pin&&sha.test(commit.tree?.sha||'')&&commit.tree.sha===controller.tree?.sha,'Execution tree differs from reviewed controller');
 require(Array.isArray(commit.parents)&&commit.parents.length===1&&commit.parents[0]?.sha===pin,'Execution commit is not the sole child of its reviewed controller');
 const {data:main}=await github.rest.repos.getBranch({...repo,branch:'main',request});
 require(main?.name==='main'&&sha.test(main.commit?.sha||''),'Invalid current Main identity');
 const {data:ancestry}=await github.rest.repos.compareCommitsWithBasehead({...repo,basehead:`${pin}...${main.commit.sha}`,request});
 require(['ahead','identical'].includes(ancestry?.status)&&ancestry.merge_base_commit?.sha===pin,'Reviewed execution controller is not on Main');
 return {schemaVersion:1,controllerSha:pin,controllerRef:'refs/heads/main',executionRef:context.ref,executionSha:context.sha,executionWorkflowSha:context.sha,workflowPath:path,treeSha:commit.tree.sha};
}

export async function verifyIsolatedExecutionRun(github,repo,run,options){
 const path=options?.workflowPath,branch=executionBranch(options?.controllerSha);
 // For workflow_dispatch, GitHub executes the definition at the run's SHA/ref.
 // workflow_run and PR events have different semantics and are never inferred here.
 require(positive(run?.id)&&positive(run.run_attempt)&&positive(run.workflow_id)&&run.event==='workflow_dispatch'&&run.head_branch===branch&&sameRepo(run.repository?.full_name,repo)&&sameRepo(run.head_repository?.full_name,repo),'Unauthenticated isolated workflow run');
 require(options.workflowId===undefined||run.workflow_id===options.workflowId,'Isolated workflow ID mismatch');
 require([path,`${path}@${branch}`,`${path}@refs/heads/${branch}`].includes(run.path),'Isolated workflow path mismatch');
 return verifyIsolatedExecutionOrigin(github,repo,{ref:`refs/heads/${branch}`,sha:run.head_sha,workflowSha:run.head_sha,workflowRef:`${repo.owner}/${repo.repo}/${path}@refs/heads/${branch}`},options);
}
