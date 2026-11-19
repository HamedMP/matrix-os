import { createHash } from 'node:crypto';
import { RoutineCreationRouteTupleSchema, canonicalChatTurnRequestIdentity, type CanonicalCreateChatTurnRequest } from '@matrix-os/contracts';
import type { RequestPrincipal } from '../request-principal.js';
import type { ChatOwner } from './records.js';
import type { createRoutineOriginPlatformClient } from '../bots/routine-origin-platform-client.js';
import { CanonicalChatOrchestrationError, safeError } from './orchestration-input.js';
export interface RoutineCreationAdmission {
  principal: RequestPrincipal; owner: ChatOwner; chatId: string; body: CanonicalCreateChatTurnRequest;
  proof?: string; path: 'turns' | 'queued-turns';
}
export function createRoutineCreationAdmission(options: { handle: string; runtimeSlot: string; machineId: string;
  verifyCreation: ReturnType<typeof createRoutineOriginPlatformClient>['verifyCreation'] }) {
  if (typeof options.verifyCreation !== 'function' || !options.handle || !options.runtimeSlot || !options.machineId) throw new Error('Routine creation unavailable');
  return async (input: RoutineCreationAdmission): Promise<void> => {
    if (!input.body.routineCreation) return;
    const deny = () => new CanonicalChatOrchestrationError(safeError('authorization_failed','Persistent task selection is unavailable.'),400);
    if (input.owner.type !== 'personal' || input.principal.userId !== input.owner.ownerId || !input.proof) throw deny();
    const tuple=RoutineCreationRouteTupleSchema.parse({purpose:'routine_creation_route',handle:options.handle,
      runtimeSlot:options.runtimeSlot,machineId:options.machineId,ownerId:input.owner.ownerId,sourceChatId:input.chatId,
      method:'POST',path:`/api/chats/${input.chatId}/${input.path}`,routineCreation:'matrix',
      clientRequestId:input.body.clientRequestId,baseRevision:input.body.baseRevision,
      bodyDigest:createHash('sha256').update(canonicalChatTurnRequestIdentity(input.body)).digest('hex')});
    try { await options.verifyCreation(tuple,input.proof); }
    catch(error:unknown) { console.warn('[routine-creation] Selection unavailable',error instanceof Error ? error.name : 'UnknownError');throw deny(); }
  };
}
/** Persisted only after the browser proof passes. No previous Chat/Run context is consulted. */
export function routineCreationContext(input: CanonicalCreateChatTurnRequest, context?: import('@matrix-os/contracts').ChatRunContext) {
  if (!input.routineCreation) return context;
  return { ...context, version:1 as const, chats:context?.chats ?? [],
    requestHash:createHash('sha256').update(canonicalChatTurnRequestIdentity(input)).digest('hex'),routineCreation:input.routineCreation };
}
export const nativeCronCreationAllowed = (input: {context?: import('@matrix-os/contracts').ChatRunContext}) => input.context?.routineCreation !== 'matrix';
