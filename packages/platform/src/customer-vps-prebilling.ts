import type { ProvisioningJobRecord } from './customer-vps-provisioning-jobs.js';
import type { PlatformDB, UserMachineRecord } from './db.js';
import { validatePrebillingProvisioningIntent } from './prebilling-provisioning-store.js';

export async function isProvisioningJobAuthorized(
  db: PlatformDB,
  job: ProvisioningJobRecord,
  machine: UserMachineRecord,
  now: string,
): Promise<boolean> {
  if (job.authorizationBasis !== 'prebilling_intent') return true;
  if (!job.prebillingIntentId) return false;
  return Boolean(await validatePrebillingProvisioningIntent(db, {
    intentId: job.prebillingIntentId,
    clerkUserId: machine.clerkUserId,
    runtimeSlot: machine.runtimeSlot,
    serverType: machine.serverType ?? '',
    regionSlug: `region_${machine.location ?? ''}`,
    developerTools: machine.developerTools,
    machineId: machine.machineId,
    now,
  }));
}

export async function persistProvisioningClaimMutation(
  db: PlatformDB,
  input: { machineId: string; jobId: string; mutate: (trx: PlatformDB) => Promise<void> },
): Promise<{ persisted: boolean; prebillingCleanupWon: boolean; alreadyCompleted: boolean }> {
  return db.transaction(async (trx) => {
    const machine = await trx.executor.selectFrom('user_machines').select(['deleted_at', 'status'])
      .where('machine_id', '=', input.machineId).forUpdate().executeTakeFirst();
    const job = await trx.executor.selectFrom('provisioning_jobs').select(['status', 'authorization_basis'])
      .where('job_id', '=', input.jobId).forUpdate().executeTakeFirst();
    const active = machine?.deleted_at === null && machine.status === 'provisioning' && job?.status === 'running';
    if (!active) return {
      persisted: false,
      prebillingCleanupWon: job?.authorization_basis === 'prebilling_intent' && machine?.deleted_at !== null,
      alreadyCompleted: machine?.deleted_at === null && machine.status === 'running' && job?.status === 'completed',
    };
    await input.mutate(trx);
    return { persisted: true, prebillingCleanupWon: false, alreadyCompleted: false };
  });
}
