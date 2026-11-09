import { authenticatedApprovalProxyProof, type OwnerApprovalProxyInput } from './canonical-owner-approval-proxy.js';
import { authenticatedRoutineOriginProxyProof } from './routine-origin-proxy.js';
/** Retains every existing purpose gate. A new routing proof never substitutes for Full Access consent. */
export async function authenticatedApprovalProxyProofs(input:OwnerApprovalProxyInput):Promise<string[]|{status:400|408|413|503}> {
  const existing=await authenticatedApprovalProxyProof(input);
  if(existing&&typeof existing==='object')return existing;
  const routine=await authenticatedRoutineOriginProxyProof(input);
  if(routine&&typeof routine==='object')return routine;
  return [...(existing?[existing]:[]),...(routine?[routine]:[])];
}
