import type { PlatformDB } from '../db.js';
import { hashAccountDeletionOwner, lockAccountDeletionOwner } from './repository.js';

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

/** Keep this lock through the write: a route pre-check alone races deletion acceptance. */
export async function withAccountDeletionOwnerLock<T>(
  db: PlatformDB,
  clerkUserId: string,
  work: (trx: PlatformDB, admission: AccountDeletionAdmission) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const secret = configuredSecret(env);
  return db.transaction(async (trx) => {
    if (secret !== undefined) await lockAccountDeletionOwner(trx.executor, hashAccountDeletionOwner(clerkUserId, secret));
    return work(trx, await getAccountDeletionAdmission(trx, clerkUserId, env));
  });
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
