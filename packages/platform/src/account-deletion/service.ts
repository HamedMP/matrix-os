import type { Kysely } from 'kysely';
import type { PlatformDatabase } from '../db.js';
import { AccountDeletionRepository, type DeletionJob } from './repository.js';
import { ACCOUNT_DELETION_STEPS, type AccountDeletionAdapters, type AccountDeletionService, type AccountDeletionStatus } from './types.js';

function publicStatus(job: DeletionJob | undefined): AccountDeletionStatus {
  const erasesAfter=job && job.status !== 'cancelled' ? job.due_at : null;
  return { status: job?.status ?? 'none', erasesAfter,
    completesBy:job?.completed_at ?? (erasesAfter ? new Date(Date.parse(erasesAfter)+86_400_000).toISOString() : null),
    billingStopped: job?.billing_stopped ?? false };
}

export function createAccountDeletionService(options: {
  db: Kysely<PlatformDatabase>;
  adapters: AccountDeletionAdapters;
  secret: string;
  now?: () => Date;
  batchSize?: number;
  leaseMs?: number;
  logError?: (error: unknown) => void;
}): AccountDeletionService {
  const now = options.now ?? (() => new Date());
  const repository = new AccountDeletionRepository(options.db, { secret: options.secret, now });
  const leaseMs = Math.max(30_000, Math.min(600_000, options.leaseMs ?? 120_000));
  const batchSize = Math.max(1, Math.min(100, options.batchSize ?? 25));
  const logError = options.logError ?? ((error: unknown) => console.error('[platform] account deletion cleanup failed', error));

  async function process(job: DeletionJob, billingOnly = false): Promise<void> {
    let lostLease = false;
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal || lostLease) return;
      renewal = repository.renew(job, leaseMs).then((renewed) => { if (!renewed) lostLease = true; })
        .catch((error: unknown) => { lostLease = true; logError(error); })
        .finally(() => { renewal = undefined; });
    }, Math.floor(leaseMs / 3));
    heartbeat.unref?.();
    try {
      let context = repository.decrypt(job);
      for (let index = job.next_step; index < ACCOUNT_DELETION_STEPS.length; index += 1) {
        if (index > 0 && (billingOnly || now().toISOString() < job.due_at)) {
          await repository.release(job, false);
          return;
        }
        if (lostLease || !(await repository.renew(job, leaseMs))) return;
        if (ACCOUNT_DELETION_STEPS[index] === 'apple' && !context.appleRevocationPrepared && options.adapters.prepareAppleRevocation) {
          const prepared = await options.adapters.prepareAppleRevocation(context);
          if (prepared.clerkUserId !== context.clerkUserId || prepared.appleRevocationPrepared !== true) {
            throw new Error('Account deletion preparation failed.');
          }
          // Persist the exact grant before consuming it: a crash after revocation must
          // replay these credentials rather than rediscover a now-missing Clerk grant.
          if (lostLease || !(await repository.saveContext(job, prepared))) return;
          context = prepared;
          if (lostLease || !(await repository.renew(job, leaseMs))) return;
        }
        await options.adapters[ACCOUNT_DELETION_STEPS[index]](context);
        if (lostLease || !(await repository.checkpoint(job, index + 1, leaseMs))) return;
      }
      await repository.release(job, true);
    } catch (error: unknown) {
      logError(error);
      await repository.fail(job);
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
  }
  return {
    async schedule(clerkUserId, identityDeleted = false) {
      // Preflight and encrypted acceptance run under the same owner lock as native credential capture.
      await repository.acceptPrepared(clerkUserId, identityDeleted, (transaction) =>
        options.adapters.prepare(clerkUserId, identityDeleted, transaction));
      // Signed identity-deleted webhooks acknowledge only durable acceptance.
      // The worker performs potentially long remote cleanup outside the response.
      if (!identityDeleted && (await repository.get(clerkUserId))?.next_step === 0) {
        const job = await repository.claim(clerkUserId, leaseMs);
        if (job) await process(job, true);
      }
      return publicStatus(await repository.get(clerkUserId));
    },
    async get(clerkUserId) { return publicStatus(await repository.get(clerkUserId)); },
    async cancel(clerkUserId) { return publicStatus(await repository.cancel(clerkUserId)); },
    async isBlocked(clerkUserId) {
      const job = await repository.get(clerkUserId);
      return !!job && job.status !== 'cancelled';
    },
    async reconcile() {
      for (let count = 0; count < batchSize; count += 1) {
        const job = await repository.claim(undefined, leaseMs);
        if (!job) break;
        await process(job);
      }
    },
  };
}
