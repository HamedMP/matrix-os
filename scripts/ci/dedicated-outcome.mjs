// Only trusted host/controller state can authorize hosted infrastructure recovery.
const stages={queue_capacity:'admission',queue_timeout:'admission',host_capacity_unavailable:'preflight',docker_unavailable:'preflight',image_unavailable:'preflight'};
export function validInfrastructureProof(value){
 if(value?.status!==76||value.workloadStarted!==false||value.containerGone!==true)return false;
 if(value.outcome==='transport-unavailable')return value.proofOrigin==='controller-transport-v1'&&value.grantSent===false&&value.controlBytes===0&&value.handshakeBoundSeconds===20&&value.stage==='handshake'&&['connection_refused','connection_timeout'].includes(value.reason);
 return value.outcome==='infrastructure-unavailable'&&Object.hasOwn(stages,value.reason)&&stages[value.reason]===value.stage;
}
export function verifyInfrastructureRecord(record,envelope,digest){
 const keys=['protocolVersion','type','leaseId','requestDigest','status','reason','stage','workloadStarted','containerGone'].sort();
 const proof={...record,outcome:record.type};
 if(JSON.stringify(Object.keys(record).sort())!==JSON.stringify(keys)||record.leaseId!==envelope.leaseId||record.requestDigest!==digest||!validInfrastructureProof(proof))throw new Error('Invalid trusted infrastructure proof');
 return {schemaVersion:1,outcome:proof.outcome,status:76,reason:proof.reason,stage:proof.stage,workloadStarted:false,containerGone:true,leaseId:envelope.leaseId,requestDigest:digest,request:envelope.request,sourceSha:envelope.request.mergeSha,parents:envelope.request.mergeParents,imageDigest:envelope.request.imageDigest,harnessDigest:envelope.request.harnessDigest,qualified:false};
}
