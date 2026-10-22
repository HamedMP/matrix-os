// Only the pinned local SSH process may attest a failed connection before any grant.
// No remote control record, banner, authentication error or generic exit255 qualifies.
export function classifyUnavailableTransport(host,stderr,elapsed){
 if(!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host||'')||typeof stderr!=='string'||Buffer.byteLength(stderr)>8192||!Number.isFinite(elapsed)||elapsed<0||elapsed>20000)return null;
 const prefix=`ssh: connect to host ${host} port 22: `;
 for(const [message,reason]of [['Connection refused','connection_refused'],['Connection timed out','connection_timeout'],['Operation timed out','connection_timeout']]){
  if(stderr===prefix+message+'\n'||stderr===prefix+message+'\r\n')return reason;
 }
 return null;
}
export function transportOutcome(envelope,digest,reason){
 if(!['connection_refused','connection_timeout'].includes(reason))throw new Error('Invalid pinned transport availability');
 return {schemaVersion:1,outcome:'transport-unavailable',proofOrigin:'controller-transport-v1',status:76,reason,stage:'handshake',grantSent:false,controlBytes:0,handshakeBoundSeconds:20,workloadStarted:false,containerGone:true,leaseId:envelope.leaseId,requestDigest:digest,request:envelope.request,sourceSha:envelope.request.mergeSha,parents:envelope.request.mergeParents,imageDigest:envelope.request.imageDigest,harnessDigest:envelope.request.harnessDigest,qualified:false};
}
