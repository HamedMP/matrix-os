import { sql } from 'kysely';
import type { GoogleQualifiedFundedDispatchCheckRequest } from '@matrix-os/contracts';
import type { PlatformDB } from './db.js';
import { withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import { authenticatedQualifiedToken, qualifiedPolicy } from './ai-funded-qualified-state.js';
import { readAiFundedRouteBinding } from './ai-funded-route-binding.js';
import { QualifiedFundedError } from './ai-funded-qualified-errors.js';

/** Caller owns bounded transaction. Owner admission -> funded owner -> machine -> token -> runtime.
 * Request class is authenticated token state, never a browser/header/model assertion. Locks last through commit. */
export async function admitQualifiedFundedRoute(db: PlatformDB, request: GoogleQualifiedFundedDispatchCheckRequest,
  options: { hashSecret: string; now: () => Date; env?: NodeJS.ProcessEnv }) {
  const token = await authenticatedQualifiedToken(db, request.credential, options.hashSecret);
  return withAccountDeletionOwnerLock(db, token.identity.ownerId, async (admitted, admission) => {
    if (!admission.newWorkAllowed) throw new QualifiedFundedError();
    await sql`select pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${token.identity.ownerId}`}, 0))`.execute(admitted.executor);
    const machine = await admitted.executor.selectFrom('user_machines').selectAll().where('machine_id', '=', token.identity.machineId).forUpdate().executeTakeFirst();
    if (!machine || machine.runtime_token_epoch !== token.epoch) throw new QualifiedFundedError();
    const fresh = await authenticatedQualifiedToken(admitted, request.credential, options.hashSecret, true);
    if (fresh.identity.ownerId !== token.identity.ownerId || fresh.identity.machineId !== token.identity.machineId
      || fresh.identity.runtimeSlot !== token.identity.runtimeSlot || fresh.epoch !== machine.runtime_token_epoch
      || (fresh.row.request_class !== 'interactive' && fresh.row.request_class !== 'background')) throw new QualifiedFundedError();
    const binding = await readAiFundedRouteBinding(admitted.executor, { identity: fresh.identity, tokenId: fresh.row.token_id,
      api: request.api, canonicalModelId: request.canonicalModelId, requestClass: fresh.row.request_class, expectedDigest: request.expectedDigest }, options.now);
    if (!binding) throw new QualifiedFundedError();
    const { policy } = await qualifiedPolicy(admitted, fresh.identity, binding.canonicalModelId, options.now());
    return { binding, authorization: { contractVersion: 1 as const, authorized: true as const,
      identity: { ...fresh.identity, tokenId: fresh.row.token_id, audience: 'matrix-funded-relay' as const, scope: 'ai:invoke' as const, expiresAt: fresh.row.expires_at }, policy } };
  }, options.env);
}
