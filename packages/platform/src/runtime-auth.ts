import { createHmac } from 'node:crypto';
import type { PlatformDB } from './db.js';
import { buildOwnedMachineVerificationToken, buildPlatformVerificationToken, buildRuntimeAuthToken, timingSafeTokenEquals } from './platform-token.js';

type RuntimeAuthMachine = Parameters<typeof buildRuntimeAuthToken>[0];

/** Proof of the verified user that the runtime gateway checks against its own bearer. */
export function buildRuntimeUserProof(machine: RuntimeAuthMachine, userId: string, platformSecret: string): string {
  return createHmac('sha256', buildRuntimeAuthToken(machine, platformSecret)).update(userId).digest('hex');
}

export const OWNED_MAX_MACHINES_PER_HANDLE = 8;

/**
 * Matches a runtime's bearer on machine-to-platform routes keyed by handle:
 * either the handle-wide token of a hosted runtime, or the current-epoch token
 * of one of the owner's live owned machines. Returns the matched token, or null.
 * A revoked owned machine fails because its epoch moved.
 */
export async function matchRuntimeBearerForHandle(
  db: PlatformDB, handle: string, bearer: string | undefined, platformSecret: string,
): Promise<string | null> {
  if (!bearer || !platformSecret) return null;
  const handleToken = buildPlatformVerificationToken(handle, platformSecret);
  if (timingSafeTokenEquals(bearer, handleToken)) return handleToken;
  await db.ready;
  const owned = await db.executor.selectFrom('user_machines')
    .select(['machine_id', 'handle', 'runtime_slot', 'runtime_token_epoch'])
    .where('handle', '=', handle).where('substrate', '=', 'owned').where('deleted_at', 'is', null)
    .limit(OWNED_MAX_MACHINES_PER_HANDLE).execute();
  let matched: string | null = null;
  for (const row of owned) {
    const expected = buildOwnedMachineVerificationToken(
      { handle: row.handle, machineId: row.machine_id, runtimeSlot: row.runtime_slot }, platformSecret, row.runtime_token_epoch);
    if (timingSafeTokenEquals(bearer, expected)) matched = expected;
  }
  return matched;
}

/** The delegated-actor proof a runtime signs with its own bearer. */
export function verifyRuntimeDelegationProof(runtimeToken: string, actorId: string, proof: string): boolean {
  return timingSafeTokenEquals(proof, createHmac('sha256', runtimeToken).update(actorId).digest('hex'));
}
