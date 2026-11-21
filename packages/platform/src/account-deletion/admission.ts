import type { PlatformDB } from '../db.js';
import { sql } from 'kysely';
import { hashAccountDeletionOwner, lockAccountDeletionOwner, lockAccountDeletionOwnerShared } from './repository.js';
import { lockBillingOwner } from '../billing/owner-lock.js';

export interface AccountDeletionAdmission {
  status: 'none' | 'scheduled' | 'processing' | 'completed' | 'cancelled';
  newWorkAllowed: boolean;
  runtimeAccess: 'normal' | 'grace' | 'blocked';
  scheduledAt: string | null;
}
export class AccountDeletionAdmissionError extends Error {
  constructor() { super('Account deletion is pending'); this.name = 'AccountDeletionAdmissionError'; }
}
const NORMAL: AccountDeletionAdmission = { status: 'none', newWorkAllowed: true, runtimeAccess: 'normal', scheduledAt: null };

function configuredSecret(env: NodeJS.ProcessEnv): string | undefined {
  const secret = env.ACCOUNT_DELETION_SECRET;
  if (secret !== undefined && Buffer.byteLength(secret) < 32) throw new Error('Account deletion is unavailable');
  return secret;
}

/** The absence of a secret disables scheduling and admission together. Invalid configuration fails closed. */
export async function getAccountDeletionAdmission(
  db: PlatformDB,
  clerkUserId: string,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<AccountDeletionAdmission> {
  const secret = configuredSecret(env);
  if (secret === undefined) return { ...NORMAL };
  await db.ready;
  const job = await db.executor.selectFrom('account_deletion_jobs').select(['status', 'due_at', 'created_at'])
    .where('owner_hash', '=', hashAccountDeletionOwner(clerkUserId, secret)).executeTakeFirst();
  if (!job) return { ...NORMAL };
  const status = job.status as AccountDeletionAdmission['status'];
  return {
    status,
    newWorkAllowed: status === 'cancelled',
    runtimeAccess: status === 'cancelled' ? 'normal'
      : status === 'scheduled' && Date.parse(job.due_at) > now.getTime() ? 'grace' : 'blocked',
    scheduledAt: job.created_at,
  };
}

type OwnerLane = 'exclusive' | 'funding' | 'storage';

async function withOwnerFence<T>(
  db: PlatformDB,
  clerkUserId: string,
  work: (trx: PlatformDB, admission: AccountDeletionAdmission) => Promise<T>,
  env: NodeJS.ProcessEnv,
  lane: OwnerLane,
): Promise<T> {
  const secret = configuredSecret(env);
  return db.transaction(async (trx) => {
    if (secret !== undefined) {
      const lock = lane === 'exclusive' ? lockAccountDeletionOwner : lockAccountDeletionOwnerShared;
      await lock(trx.executor, hashAccountDeletionOwner(clerkUserId, secret));
    }
    if (lane === 'storage' && secret !== undefined) {
      // Keep every storage publication serialized through its complete external side effect.
      // Storage callbacks must not enter the exclusive deletion or financial lanes.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`storage-owner:${clerkUserId}`}, 0))`.execute(trx.executor);
    } else {
      // Without deletion configuration, retain the legacy billing lifecycle fence for storage too.
      await lockBillingOwner(trx, clerkUserId);
    }
    return work(trx, await getAccountDeletionAdmission(trx, clerkUserId, env));
  });
}

/** Keep this exclusive lock through the write; existing callers retain their original lock semantics. */
export function withAccountDeletionOwnerLock<T>(
  db: PlatformDB, clerkUserId: string,
  work: (trx: PlatformDB, admission: AccountDeletionAdmission) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  return withOwnerFence(db, clerkUserId, work, env, 'exclusive');
}

/** Shared deletion fence, then the unchanged exclusive billing owner lock and fresh admission. */
export function withAccountDeletionFundingLock<T>(
  db: PlatformDB, clerkUserId: string,
  work: (trx: PlatformDB, admission: AccountDeletionAdmission) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  return withOwnerFence(db, clerkUserId, work, env, 'funding');
}

/** Shared deletion fence plus its own exclusive storage lane; hold both until signing/I/O completes. */
export function withAccountDeletionStorageLock<T>(
  db: PlatformDB, clerkUserId: string,
  work: (trx: PlatformDB, admission: AccountDeletionAdmission) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  return withOwnerFence(db, clerkUserId, work, env, 'storage');
}

export async function withAccountDeletionAdmission<T>(
  db: PlatformDB,
  clerkUserId: string,
  work: (trx: PlatformDB) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  return withAccountDeletionOwnerLock(db, clerkUserId, async (trx, admission) => {
    if (!admission.newWorkAllowed) throw new AccountDeletionAdmissionError();
    return work(trx);
  }, env);
}
