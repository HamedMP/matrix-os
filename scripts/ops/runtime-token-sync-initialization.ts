/** Explicit operator preparation, never a credential-rotation or database writer. */
import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  buildPlatformSyncVerificationToken, buildPlatformVerificationToken,
} from '../../packages/platform/src/platform-token.ts';
import { sealRuntimeTokenPayload } from './runtime-token-envelope.mjs';

type Identity = { ownerId: string; handle: string; machineId: string; runtimeSlot: string };
export type SyncInitializationMachine = {
  machine_id: string; clerk_user_id: string; handle: string; runtime_slot: string;
  runtime_token_epoch: number; status: string; deleted_at: string | null;
  provisioning_class: string; activation_state: string;
};
export type SyncInitializationRequest = {
  expectedIdentity: Identity;
  expectedRelease: { version: string; gitCommit: string };
  expectedFile: { sha256: string; inode: number; device: number };
  recipientSha256: string; verifierDigest: string; expiresAt: Date; nonce: string;
};
const hex = (value: unknown, size: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const exact = (value: unknown, keys: string[]) => value !== null && typeof value === 'object'
  && Object.keys(value).sort().join(',') === keys.sort().join(',');
function requireValid(value: unknown): asserts value {
  if (!value) throw new Error('Sync initialization preparation refused');
}
function equalDigest(actual: string, expected: string) {
  requireValid(hex(actual, 64) && hex(expected, 64));
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function prepareSyncInitialization(input: SyncInitializationRequest & {
  machine: SyncInitializationMachine; recipientPublicKey: string; platformSecret: string; now: Date;
}) {
  const { machine, expectedIdentity: identity, expectedRelease, expectedFile, now, expiresAt } = input;
  requireValid(exact(identity, ['ownerId', 'handle', 'machineId', 'runtimeSlot'])
    && typeof identity.ownerId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(identity.ownerId)
    && typeof identity.handle === 'string' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(identity.handle)
    && typeof identity.machineId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(identity.machineId)
    && identity.runtimeSlot === 'primary');
  requireValid(machine && machine.machine_id === identity.machineId && machine.clerk_user_id === identity.ownerId
    && machine.handle === identity.handle && machine.runtime_slot === 'primary' && machine.status === 'running'
    && machine.deleted_at === null && machine.provisioning_class === 'customer' && machine.activation_state === 'authorized'
    && Number.isSafeInteger(machine.runtime_token_epoch) && machine.runtime_token_epoch >= 1 && machine.runtime_token_epoch <= 2_147_483_647);
  requireValid(exact(expectedRelease, ['version', 'gitCommit'])
    && typeof expectedRelease.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(expectedRelease.version) && hex(expectedRelease.gitCommit, 40)
    && exact(expectedFile, ['sha256', 'inode', 'device']) && hex(expectedFile.sha256, 64)
    && Number.isSafeInteger(expectedFile.inode) && expectedFile.inode > 0
    && Number.isSafeInteger(expectedFile.device) && expectedFile.device >= 0
    && now instanceof Date && Number.isFinite(now.getTime()) && expiresAt instanceof Date
    && 0 < expiresAt.getTime() - now.getTime() && expiresAt.getTime() - now.getTime() <= 30_000
    && hex(input.nonce, 32));
  requireValid(typeof input.platformSecret === 'string' && input.platformSecret.length >= 32
    && input.platformSecret.length <= 65_536 && input.platformSecret === input.platformSecret.trim()
    && !/[\r\n\0]/.test(input.platformSecret));
  const expectedVerifier = createHash('sha256').update(buildPlatformVerificationToken(identity.handle, input.platformSecret)).digest('hex');
  requireValid(equalDigest(input.verifierDigest, expectedVerifier));
  requireValid(typeof input.recipientPublicKey === 'string' && Buffer.byteLength(input.recipientPublicKey) <= 8192
    && /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/.test(input.recipientPublicKey));
  const key = createPublicKey(input.recipientPublicKey);
  requireValid(key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048);
  const recipient = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  requireValid(equalDigest(input.recipientSha256, recipient));
  const payload = {
    contractVersion: 1, kind: 'matrix-sync-initialization',
    identity: { ...identity, runtimeTokenEpoch: machine.runtime_token_epoch }, expectedRelease, expectedFile,
    recipientSha256: recipient, issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), nonce: input.nonce,
    syncRuntimeToken: buildPlatformSyncVerificationToken(identity, input.platformSecret, machine.runtime_token_epoch),
  };
  return sealRuntimeTokenPayload(payload, key, 2);
}

export async function prepareSyncInitializationFromDatabase(
  db: Kysely<{ user_machines: SyncInitializationMachine }>, machineId: string,
  input: SyncInitializationRequest & { recipientPublicKey: string; platformSecret: string },
  now: () => Date = () => new Date(),
) {
  return db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    await sql`SET LOCAL statement_timeout = '5000ms'`.execute(trx);
    const machine = await trx.selectFrom('user_machines')
      .select(['machine_id', 'clerk_user_id', 'handle', 'runtime_slot', 'runtime_token_epoch', 'status',
        'deleted_at', 'provisioning_class', 'activation_state'])
      .where('machine_id', '=', machineId).executeTakeFirst();
    if (!machine) throw new Error('Selected initialization machine is unavailable');
    return prepareSyncInitialization({ ...input, machine, now: now() });
  });
}
