import { isDeepStrictEqual } from 'node:util';
import { RoutineBrowserTupleSchema, RoutineBrowserProofSchema, ROUTINE_CREATION_PROOF_HEADER, ROUTINE_ORIGIN_PROOF_HEADER,
  type RoutineBrowserTuple, type RoutineOriginApprovalProof, type RoutineOriginApprovalTuple,
  type RoutineCreationRouteProof, type RoutineCreationRouteTuple } from '@matrix-os/contracts';
declare const verifiedOrigin: unique symbol;
declare const verifiedCreation: unique symbol;
export type VerifiedRoutineOriginApproval = RoutineOriginApprovalProof & { readonly [verifiedOrigin]: true };
export type VerifiedRoutineCreationRoute = RoutineCreationRouteProof & { readonly [verifiedCreation]: true };
/** Only the existing Platform can verify its HMAC. Runtime bearer provides transport authentication only. */
export function createRoutineOriginPlatformClient(options: { platformUrl: string; handle: string; token: string; fetcher?: typeof fetch }) {
  const base = new URL(options.platformUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.handle) || !options.token) throw new Error('Routine approval unavailable');
  const endpoint = new URL(`/internal/containers/${options.handle}/routine-origin/verify`,base).toString();
  const verify = async (input: RoutineBrowserTuple, proof: string, callerSignal?: AbortSignal) => {
    const tuple = RoutineBrowserTupleSchema.parse(input);
    if (tuple.handle !== options.handle || !proof || proof.length > 6000) throw new Error('Routine approval unavailable');
    // Compare the verifier's reply to the submitted envelope, including its nonce and actual session.
    // Parsing this untrusted envelope does not establish authority; only the Platform verifies the signature.
    const envelope = /^([A-Za-z0-9_-]+)\.[a-f0-9]{64}$/.exec(proof);
    if (!envelope) throw new Error('Routine approval unavailable');
    let original: unknown;
    try { original = JSON.parse(Buffer.from(envelope[1]!, 'base64url').toString('utf8')); }
    catch (error: unknown) { if (error instanceof SyntaxError) throw new Error('Routine approval unavailable'); throw error; }
    const signal = AbortSignal.any([AbortSignal.timeout(10_000),...(callerSignal ? [callerSignal] : [])]);
    const header = tuple.purpose === 'routine_origin_approval' ? ROUTINE_ORIGIN_PROOF_HEADER : ROUTINE_CREATION_PROOF_HEADER;
    const response = await (options.fetcher ?? fetch)(endpoint,{method:'POST',redirect:'error',signal,
      headers:{authorization:`Bearer ${options.token}`,'content-type':'application/json',[header]:proof},body:JSON.stringify(tuple)});
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 6000) {
      await response.body?.cancel(); throw new Error('Routine approval unavailable');
    }
    const reader=response.body.getReader(), chunks:Uint8Array[]=[]; let bytes=0;
    const abort=()=>{void reader.cancel().catch(error=>console.warn('[routine-origin] Response cancellation unavailable',error instanceof Error ? error.name : 'UnknownError'));};
    signal.addEventListener('abort',abort,{once:true});
    try {
      for (;;) {signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;
        bytes+=next.value.byteLength;if(bytes>6000){await reader.cancel();throw new Error('Routine approval unavailable');}chunks.push(next.value);}
      const raw:unknown=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
      if (!raw || typeof raw!=='object' || Object.keys(raw).length!==1 || !('verified' in raw)) throw new Error('Routine approval unavailable');
      const value=RoutineBrowserProofSchema.parse(raw.verified), now=Date.now();
      if(!isDeepStrictEqual(value, original) || value.issuedAt>now || value.expiresAt<=now || value.expiresAt>now+60_000 || value.expiresAt>value.issuedAt+60_000
        || !Object.entries(tuple).every(([key,field])=>value[key as keyof typeof value]===field)) throw new Error('Routine approval unavailable');
      return value;
    } finally {signal.removeEventListener('abort',abort);reader.releaseLock();}
  };
  return {
    async verifyApproval(tuple:RoutineOriginApprovalTuple,proof:string,signal?:AbortSignal):Promise<VerifiedRoutineOriginApproval>{
      if(tuple.purpose!=='routine_origin_approval')throw new Error('Routine approval unavailable');
      return await verify(tuple,proof,signal) as VerifiedRoutineOriginApproval;
    },
    async verifyCreation(tuple:RoutineCreationRouteTuple,proof:string,signal?:AbortSignal):Promise<VerifiedRoutineCreationRoute>{
      if(tuple.purpose!=='routine_creation_route')throw new Error('Routine approval unavailable');
      return await verify(tuple,proof,signal) as VerifiedRoutineCreationRoute;
    },
  };
}
