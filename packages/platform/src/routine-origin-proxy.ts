import { mintRoutineBrowserProof, routineBrowserPurposePath, routineBrowserSession, routineBrowserTuple } from './routine-origin-proof.js';
import { readRoutineProofProxyBody, type ReadRoutineProofProxyBody } from './routine-proof-proxy-body.js';
import type { OwnerApprovalProxyInput } from './canonical-owner-approval-proxy.js';

/** A single Browser turn may carry separate proofs for its routine route choice and Full Access. */
export async function authenticatedRoutineOriginProxyProof(input: OwnerApprovalProxyInput, readTurnBody?: ReadRoutineProofProxyBody):
  Promise<string | null | { status: 400 | 408 | 413 | 503 }> {
  const machine = input.machine;
  if (!routineBrowserPurposePath(input.method, input.path) || !input.platformSecret || !machine?.machineId
    || machine.handle !== input.handle || machine.clerkUserId !== input.identity.userId || input.identity.source !== 'auth') return null;
  const body = readTurnBody ? await readTurnBody()
    : await readRoutineProofProxyBody(input.request, input.path.endsWith('/resolve') ? 2048 : 128 * 1024, input.timeoutMs);
  if (typeof body !== 'string') return body;
  try {
    const tuple = routineBrowserTuple({ method: input.method, path: input.path, body, handle: input.handle,
      runtimeSlot: machine.runtimeSlot, machineId: machine.machineId, ownerId: input.identity.userId });
    if (!tuple) return null;
    const session = await routineBrowserSession(input);
    return session ? mintRoutineBrowserProof({ tuple, secret: input.platformSecret, session }) : null;
  } catch (error: unknown) {
    console.warn('[routine-origin] Browser proof unavailable', error instanceof Error ? error.name : 'UnknownError');
    return { status: error instanceof TypeError ? 400 : 503 };
  }
}
