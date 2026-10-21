import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {verifyControllerArtifact} from '../../scripts/ci/dedicated-artifact-proof.mjs';
import {canonicalRequest} from '../../scripts/ci/dedicated-ssh.mjs';
import {receiptFor} from './helpers/dedicated-artifact-fixture';
function fixture(){
 const expected={owner:'HamedMP',repo:'matrix-os',prNumber:2454,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),baseRef:'main',sourceSha:'c'.repeat(40),requestingRunId:321,requestingRunAttempt:1,imageDigest:'sha256:'+'e'.repeat(64),harnessDigest:'f'.repeat(64),mode:'delegated'};
 const evidence={...expected,controllerSha:'d'.repeat(40),controllerAttempt:1,leaseId:'8'.repeat(32),receiptVerified:true};const receipt=receiptFor(evidence);Object.assign(evidence,{requestDigest:receipt.requestDigest});return {expected,evidence,receipt,run:{id:123,run_attempt:1},check:{conclusion:'success'},parents:[expected.baseSha,expected.headSha]};
}
it('requires the actual complete qualification receipt, not a summary boolean',()=>{const f=fixture();expect(verifyControllerArtifact(f.receipt,f.evidence,f.expected,f.run,f.parents,f.check)).toBeNull();});
it.each(['sourceKind','requester','attempt','controller','parents','image','digest','lease','qualified','phase','reports','summary'])('rejects wrong immutable artifact %s',kind=>{
 const f=fixture(),r:any=f.receipt;
 if(kind==='sourceKind')r.request.sourceKind='main';if(kind==='requester')r.request.requestingRunId=322;if(kind==='attempt')r.request.controllerRunAttempt=2;if(kind==='controller')r.request.controllerRunId=124;if(kind==='parents')r.parents.reverse();if(kind==='image')r.imageDigest='sha256:'+'0'.repeat(64);if(kind==='digest')r.requestDigest='0'.repeat(64);if(kind==='lease')r.leaseId='1'.repeat(32);if(kind==='qualified')r.qualified=false;if(kind==='phase')r.phaseCount=54;if(kind==='reports')delete r.reports.unit;if(kind==='summary')(f.evidence as any).outcome='infrastructure-unavailable';
 if(['requester','attempt','controller'].includes(kind)){r.requestDigest=createHash('sha256').update(canonicalRequest(r.request)).digest('hex');(f.evidence as any).requestDigest=r.requestDigest;}
 expect(()=>verifyControllerArtifact(r,f.evidence,f.expected,f.run,f.parents,f.check)).toThrow();
});


it('binds the isolated envelope to its immutable origin while leaving the host receipt unchanged',()=>{
 const f=fixture(),origin={schemaVersion:1,controllerSha:f.evidence.controllerSha,controllerRef:'refs/heads/main',executionRef:`refs/heads/ci-execution/${f.evidence.controllerSha}`,executionSha:'1'.repeat(40),executionWorkflowSha:'1'.repeat(40),workflowPath:'.github/workflows/ci-dedicated.yml',treeSha:'2'.repeat(40)};
 const evidence={...f.evidence,schemaVersion:4,executionOrigin:origin};
 const before=JSON.stringify(f.receipt);
 expect(verifyControllerArtifact({schemaVersion:2,executionOrigin:origin,receipt:f.receipt},evidence,f.expected,f.run,f.parents,f.check)).toBeNull();
 expect(JSON.stringify(f.receipt)).toBe(before);
 for(const envelope of [f.receipt,{schemaVersion:2,executionOrigin:{...origin,executionSha:'3'.repeat(40)},receipt:f.receipt},{schemaVersion:2,executionOrigin:origin}])expect(()=>verifyControllerArtifact(envelope,evidence,f.expected,f.run,f.parents,f.check)).toThrow(/envelope/);
 expect(()=>verifyControllerArtifact({schemaVersion:2,executionOrigin:origin,receipt:f.receipt},{...f.evidence,schemaVersion:3},f.expected,f.run,f.parents,f.check)).toThrow(/versioned/);
});
