// Protected-controller attestation for an exact current default-branch push.
const sha=/^[a-f0-9]{40}$/;
const request={timeout:10000};
export async function resolveMainSource(github,repo,source){
 let timer;const aborter=new AbortController();
 try{return await Promise.race([resolveWithinDeadline(github,repo,source,aborter.signal),new Promise((_,reject)=>{timer=setTimeout(()=>{aborter.abort();reject(new Error('Main attestation deadline exceeded'));},20000);timer.unref?.();})]);}
 finally{clearTimeout(timer);aborter.abort();}
}
async function resolveWithinDeadline(github,repo,source,signal){
 if(!sha.test(source||''))throw new Error('Invalid exact main source');
 const read=()=>github.rest.git.getRef({...repo,ref:'heads/main',request:{...request,signal}});
 const first=await read();if(first.data?.object?.sha!==source)throw new Error('Current main source is stale');
 const {data:commit}=await github.rest.repos.getCommit({...repo,ref:source,request:{...request,signal}});
 const parents=commit?.parents?.map(p=>p.sha);
 if(commit?.sha!==source||!Array.isArray(parents)||![1,2].includes(parents.length)||parents.some(p=>!sha.test(p)||p===source)||new Set(parents).size!==parents.length||!sha.test(commit.commit?.tree?.sha||''))throw new Error('Invalid public main commit proof');
 if((await read()).data?.object?.sha!==source)throw new Error('Main moved during source attestation');
 return {sourceKind:'main',prNumber:0,sourceSha:source,headSha:source,headRef:'main',baseSha:parents[0],baseRef:'main',mergeParents:parents};
}
export async function verifyMainSource(github,repo,value){
 if(value?.sourceKind!=='main'||value.prNumber!==0||value.headSha!==(value.sourceSha??value.mergeSha)||value.baseRef!=='main'||(value.headRef!==undefined&&value.headRef!=='main'))throw new Error('Invalid explicit main source');
 const current=await resolveMainSource(github,repo,value.sourceSha??value.mergeSha);
 if(value.baseSha!==current.baseSha||JSON.stringify(value.mergeParents)!==JSON.stringify(current.mergeParents))throw new Error('Main parent attestation is stale');
 return current;
}
