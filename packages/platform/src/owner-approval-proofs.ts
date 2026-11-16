import { authenticatedApprovalProxyProof, type OwnerApprovalProxyInput } from './canonical-owner-approval-proxy.js';
import { authenticatedRoutineOriginProxyProof } from './routine-origin-proxy.js';
import { routineFullAccessPath } from './routine-full-access-proof.js';
import { readRoutineProofProxyBody } from './routine-proof-proxy-body.js';

export async function authenticatedApprovalProxyProofs(input: OwnerApprovalProxyInput): Promise<string[] | { status: 400 | 408 | 413 | 503 }> {
  let turnBody: ReturnType<typeof readRoutineProofProxyBody> | undefined;
  const readTurnBody = routineFullAccessPath(input.method, input.path)?.kind === 'turn'
    ? () => turnBody ??= readRoutineProofProxyBody(input.request, 128 * 1024, input.timeoutMs)
    : undefined;
  const existing = await authenticatedApprovalProxyProof(input, readTurnBody);
  if (existing && typeof existing === 'object') return existing;
  const routine = await authenticatedRoutineOriginProxyProof(input, readTurnBody);
  if (routine && typeof routine === 'object') return routine;
  return [...(existing ? [existing] : []), ...(routine ? [routine] : [])];
}
