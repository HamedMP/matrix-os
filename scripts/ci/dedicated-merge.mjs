// Protected-controller public API proof; never import this module from a PR.
const hash=/^[a-f0-9]{40}$/;
const id=value=>Number.isSafeInteger(value)&&value>0;
const ref=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x20\x7f~^:?*\[\\]/.test(value)&&!value.includes('..')&&!value.includes('@{')&&!value.endsWith('/')&&!value.endsWith('.');
const same=(value,repo)=>typeof value==='string'&&value.toLowerCase()===`${repo.owner}/${repo.repo}`.toLowerCase();
const endpoint=value=>[value?.sha,value?.ref,value?.repo?.id,value?.repo?.full_name?.toLowerCase()];
const identity=(pull,labels=false)=>JSON.stringify([pull.number,pull.state,pull.draft,endpoint(pull.head),endpoint(pull.base),pull.merge_commit_sha,pull.stack,labels?pull.labels?.map(x=>x.name).sort():null]);
function meta(value){
 if(!value||!id(value.id)||!id(value.number)||!id(value.size)||value.size>100||!id(value.position)||value.position>value.size||!ref(value.base?.ref)||!hash.test(value.base?.sha||''))throw new Error('Invalid bounded native stack metadata');
 return value;
}
function member(pull,repo){
 if(!id(pull?.number)||pull.state!=='open'||pull.draft!==false||!same(pull.head?.repo?.full_name,repo)||!same(pull.base?.repo?.full_name,repo)||!hash.test(pull.head?.sha||'')||!hash.test(pull.base?.sha||'')||!ref(pull.head?.ref)||!ref(pull.base?.ref))throw new Error('Invalid current native stack member');
}
function stackRows(stack,membership,repositoryId){
 if(!stack||stack.id!==membership.id||stack.number!==membership.number||stack.open!==true||stack.base?.ref!==membership.base.ref||!Array.isArray(stack.pull_requests)||stack.pull_requests.length!==membership.size||Buffer.byteLength(JSON.stringify(stack))>1024*1024)throw new Error('Incomplete native stack membership');
 const numbers=new Set();
 for(const row of stack.pull_requests){
  if(!id(row?.number)||numbers.has(row.number)||row.state!=='open'||row.draft!==false||row.merged_at!==null||!ref(row.head?.ref)||!ref(row.base?.ref)||!hash.test(row.head?.sha||'')||!hash.test(row.base?.sha||''))throw new Error('Invalid ordered native stack membership');
  if(row.head.repo?.id!==repositoryId||row.base.repo?.id!==repositoryId)throw new Error('Native stack member repository identity differs');
  numbers.add(row.number);
 }
 for(let i=1;i<stack.pull_requests.length;i++){
  const lower=stack.pull_requests[i-1],upper=stack.pull_requests[i];
  if(upper.base.ref!==lower.head.ref||upper.base.sha!==lower.head.sha)throw new Error('Broken ordered native stack linkage');
 }
 if(stack.pull_requests[0].base.ref!==membership.base.ref||stack.pull_requests[0].base.sha!==membership.base.sha)throw new Error('Native stack trunk linkage changed');
 return stack.pull_requests;
}
const matches=(row,pull)=>row.number===pull.number&&row.head.sha===pull.head.sha&&row.head.ref===pull.head.ref&&row.base.sha===pull.base.sha&&row.base.ref===pull.base.ref;
const stackIdentity=stack=>JSON.stringify([stack.id,stack.number,stack.open,stack.base,stack.pull_requests.map(p=>[p.number,p.state,p.draft,p.merged_at,p.head.sha,p.head.ref,p.base.sha,p.base.ref])]);
function commit(value,expected){
 if(value?.sha!==expected||!Array.isArray(value.parents)||value.parents.length!==2||value.parents.some(p=>!hash.test(p?.sha||''))||value.parents[0].sha===value.parents[1].sha)throw new Error('Merge commit parents do not bind the current source');
 return value.parents.map(p=>p.sha);
}

export async function resolveDedicatedMergeParents(github,repo,pull){
 pull=structuredClone(pull);
 const deadline=Date.now()+20000,abort=AbortSignal.timeout(20000);
 const call=async(fn,args)=>{
  const left=deadline-Date.now();if(left<=0)throw new Error('Native merge proof deadline exceeded');
  let timer,result;
  try{result=await Promise.race([fn({...args,request:{timeout:Math.min(10000,left),signal:abort}}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native merge proof API deadline exceeded')),Math.min(10000,left));})]);}
  finally{clearTimeout(timer);}
  if(Date.now()>=deadline)throw new Error('Native merge proof deadline exceeded');return result.data;
 };
 const getCommit=sha=>call(github.rest.repos.getCommit,{...repo,ref:sha});
 const merge=await getCommit(pull.merge_commit_sha),parents=commit(merge,pull.merge_commit_sha);
 if(parents[1]!==pull.head.sha)throw new Error('Merge commit parents do not bind the current PR head');
 if(parents[0]===pull.base.sha)return parents;
 member(pull,repo);const repositoryId=pull.head.repo.id;
 if(!id(repositoryId)||pull.base.repo.id!==repositoryId)throw new Error('Native child repository identity differs');
 const membership=meta(pull.stack);if(membership.position<2)throw new Error('Native merge requires an adjacent predecessor');
 if(typeof github.request!=='function')throw new Error('Native stack API unsupported');
 const getStack=()=>call(args=>github.request('GET /repos/{owner}/{repo}/stacks/{stack_number}',args),{...repo,stack_number:membership.number});
 const stack=await getStack(),rows=stackRows(stack,membership,repositoryId),selected=rows[membership.position-1],lower=rows[membership.position-2];
 if(!matches(selected,pull)||lower.head.sha!==pull.base.sha||lower.head.ref!==pull.base.ref)throw new Error('Native selected or adjacent member changed');
 const getPull=number=>call(github.rest.pulls.get,{...repo,pull_number:number});
 const parent=await getPull(lower.number);member(parent,repo);const parentMeta=meta(parent.stack);
 if(parent.head.repo.id!==repositoryId||parent.base.repo.id!==repositoryId||!matches(lower,parent)||parentMeta.id!==membership.id||parentMeta.number!==membership.number||parentMeta.size!==membership.size||parentMeta.position!==membership.position-1||parentMeta.base.ref!==membership.base.ref||parentMeta.base.sha!==membership.base.sha||parent.merge_commit_sha!==parents[0])throw new Error('Current native predecessor does not bind merge parent');
 const [parentMerge,base,head]=await Promise.all([getCommit(parents[0]),getCommit(pull.base.sha),getCommit(pull.head.sha)]);
 if(commit(parentMerge,parents[0])[1]!==pull.base.sha)throw new Error('Native predecessor second parent differs');
 const tree=value=>hash.test(value?.commit?.tree?.sha||'')?value.commit.tree.sha:null;
 if(base?.sha!==pull.base.sha||head?.sha!==pull.head.sha||!tree(base)||!tree(head)||tree(parentMerge)!==tree(base)||tree(merge)!==tree(head))throw new Error('Native merge trees are not equivalent to current branch source');
 const getRef=branch=>call(github.rest.git.getRef,{...repo,ref:`heads/${branch}`});
 const [currentPull,currentParent,currentStack,trunk,parentRef]=await Promise.all([getPull(pull.number),getPull(parent.number),getStack(),getRef(membership.base.ref),getRef(pull.base.ref)]);
 stackRows(currentStack,membership,repositoryId);
 if(identity(currentPull,true)!==identity(pull,true)||identity(currentParent)!==identity(parent)||stackIdentity(currentStack)!==stackIdentity(stack)||trunk.object?.sha!==membership.base.sha||parentRef.object?.sha!==pull.base.sha)throw new Error('Native source, parent, membership or trunk is stale');
 return parents;
}
