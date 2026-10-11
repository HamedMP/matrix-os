// Public commit tuples from native PR2490/2491; two adjacent levels extracted
// into a compact stack whose trunk is the preceding public synthetic merge.
import {vi} from 'vitest';
export const nativePins={head:'d07df84c58822a3d44e703ba889116a60c888e5a',base:'6912619b135ec3db33c4f340a50d78994b532161',merge:'bd4e087aaa2aacc2b28f3bb01787c09eb895a8ec',parentMerge:'e4ae7b3dcea87add896c157dce5fb6d6c834c65e',trunk:'0f3a23105ea9e58e61d83b4fdabe36396c7b9ad1',headTree:'deb31f6afe0908aef595d7541a4ffffd1bfaf7d7',baseTree:'2883ebf695e62d65838f11315654115cd8b9b682'};
export function nativeStackFixture(){
 const p=nativePins,repository={full_name:'HamedMP/matrix-os',id:1157069949};
 const stackMeta={id:1990425,number:2492,base:{ref:'main',sha:p.trunk},size:2};
 const parent:any={number:2490,state:'open',draft:false,labels:[],head:{sha:p.base,ref:'codex/ci-linux-prepared-cache-reuse',repo:repository},base:{sha:p.trunk,ref:'main',repo:repository},merge_commit_sha:p.parentMerge,stack:{...stackMeta,position:1}};
 const pull:any={number:2491,state:'open',draft:false,labels:[{name:'ci-linux'},{name:'ready-for-ci'}],head:{sha:p.head,ref:'codex/ci-linux-sdk-stack-contract',repo:repository},base:{...parent.head},merge_commit_sha:p.merge,stack:{...stackMeta,position:2}};
 const row=(value:any)=>({number:value.number,state:value.state,draft:value.draft,merged_at:null,head:structuredClone(value.head),base:structuredClone(value.base)});
 const stack:any={id:stackMeta.id,number:stackMeta.number,base:{ref:'main'},open:true,pull_requests:[row(parent),row(pull)]};
 const commits:any={
  [p.merge]:{sha:p.merge,parents:[{sha:p.parentMerge},{sha:p.head}],commit:{tree:{sha:p.headTree}}},
  [p.parentMerge]:{sha:p.parentMerge,parents:[{sha:p.trunk},{sha:p.base}],commit:{tree:{sha:p.baseTree}}},
  [p.head]:{sha:p.head,parents:[{sha:p.base}],commit:{tree:{sha:p.headTree}}},
  [p.base]:{sha:p.base,parents:[{sha:p.trunk}],commit:{tree:{sha:p.baseTree}}},
 };
 const github:any={request:vi.fn(async()=>({data:structuredClone(stack)})),rest:{pulls:{get:vi.fn(async(args:any)=>({data:structuredClone(args.pull_number===2490?parent:pull)}))},git:{getRef:vi.fn(async(args:any)=>({data:{object:{sha:args.ref==='heads/main'?p.trunk:p.base}}}))},repos:{getCommit:vi.fn(async(args:any)=>({data:structuredClone(commits[args.ref])}))}}};
 const snapshot={prNumber:pull.number,sourceSha:p.merge,headSha:p.head,headRef:pull.head.ref,baseSha:p.base,baseRef:pull.base.ref,mergeParents:[p.parentMerge,p.head]};
 const controller={sha:'d'.repeat(40),ref:'refs/heads/main',workflowRef:'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main'};
 const input={repo:{owner:'HamedMP',repo:'matrix-os'},controller,eventName:'pull_request_target',payload:{action:'synchronize',pull_request:structuredClone(pull)},inputSha:''};
 return{github,pull,parent,stack,commits,snapshot,input};
}
