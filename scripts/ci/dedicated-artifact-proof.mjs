// A mutable Actions check is an index into immutable controller evidence only.
import {createHash} from 'node:crypto';
import {canonicalRequest,validateLeaseRequest,verifyLeaseReceipt} from './dedicated-ssh.mjs';
import {validInfrastructureProof} from './dedicated-outcome.mjs';
export function verifyControllerArtifact(receipt,evidence,expected,run,parents,check){
 const value=validateLeaseRequest(receipt?.request),digest=createHash('sha256').update(canonicalRequest(value)).digest('hex');
 if(receipt.schemaVersion!==1||receipt.leaseId!==evidence.leaseId||receipt.requestDigest!==digest||evidence.requestDigest!==digest||receipt.sourceSha!==expected.sourceSha||canonicalRequest(receipt.parents)!==canonicalRequest(parents)||receipt.imageDigest!==expected.imageDigest||receipt.harnessDigest!==expected.harnessDigest)throw new Error('Immutable controller receipt identity mismatch');
 const tuple={repository:`${expected.owner}/${expected.repo}`,sourceKind:expected.sourceKind,prNumber:expected.prNumber,headSha:expected.headSha,baseSha:expected.baseSha,baseRef:expected.baseRef,mergeSha:expected.sourceSha,mergeParents:parents,requestingRunId:expected.requestingRunId,requestingRunAttempt:expected.requestingRunAttempt,controllerRunId:run.id,controllerRunAttempt:run.run_attempt,controllerSha:evidence.controllerSha,imageDigest:expected.imageDigest,harnessDigest:expected.harnessDigest,mode:expected.mode,suite:'qualification'};
 for(const [key,wanted]of Object.entries(tuple))if(canonicalRequest(value[key])!==canonicalRequest(wanted))throw new Error('Immutable controller request scope mismatch');
 if(receipt.qualified===true){
  if(evidence.receiptVerified!==true||evidence.outcome!==undefined||receipt.outcome!==undefined||check.conclusion!=='success')throw new Error('Qualification summary contradicts immutable receipt');
  verifyLeaseReceipt(receipt,{request:value,leaseId:receipt.leaseId});return null;
 }
 if(receipt.qualified!==false||!validInfrastructureProof(receipt)||evidence.receiptVerified!==false||check.conclusion!=='neutral')throw new Error('Immutable receipt is not a completed qualification or proved availability failure');
 const keys=['outcome','status','reason','stage','workloadStarted','containerGone',...(receipt.outcome==='transport-unavailable'?['proofOrigin','grantSent','controlBytes','handshakeBoundSeconds']:[])];
 for(const key of keys)if(canonicalRequest(receipt[key])!==canonicalRequest(evidence[key]))throw new Error('Availability summary contradicts immutable receipt');
 return Object.fromEntries(keys.map(key=>[key,receipt[key]]));
}
