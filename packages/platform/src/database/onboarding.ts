import type { PlatformDB, NewOnboardingFirstRun, OnboardingFirstRunRecord, OnboardingJourneyEventRecord, UserMachineRecord, OnboardingFirstRunTable } from '../db.js';
import { mapUserMachine } from './user-machine-records.js';
import { withAccountDeletionOwnerLock } from '../account-deletion/admission.js';

function parseFirstRunSteps(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err: unknown) {
    // Corrupt persisted JSON → treat as no steps rather than failing the read.
    void err;
    return {};
  }
}

function mapFirstRun(row: OnboardingFirstRunTable): OnboardingFirstRunRecord {
  return {
    clerkUserId: row.clerk_user_id,
    completedAt: row.completed_at,
    goal: row.goal,
    steps: parseFirstRunSteps(row.steps),
    source: row.source,
  };
}

export async function getOnboardingFirstRun(
  db: PlatformDB,
  clerkUserId: string,
): Promise<OnboardingFirstRunRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('onboarding_first_run')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  return row ? mapFirstRun(row) : undefined;
}

/** Authoritative write-behind from the gateway: latest completion wins. */
export async function upsertOnboardingFirstRun(
  db: PlatformDB,
  record: NewOnboardingFirstRun,
): Promise<void> {
  await db.ready;
  await withAccountDeletionOwnerLock(db,record.clerkUserId,async(trx,admission)=>{
    if(!admission.newWorkAllowed)return;
  const values = {
    clerk_user_id: record.clerkUserId,
    completed_at: record.completedAt,
    goal: record.goal ?? null,
    steps: JSON.stringify(record.steps ?? {}),
    source: record.source,
  };
  await trx.executor
    .insertInto('onboarding_first_run')
    .values(values)
    .onConflict((oc) =>
      oc.column('clerk_user_id').doUpdateSet({
        completed_at: values.completed_at,
        goal: values.goal,
        steps: values.steps,
        source: values.source,
      }),
    )
    .execute();
  });
}

/** Best-effort legacy backfill: only fills a missing record, never overwrites
 * an authoritative gateway write-behind (spec 092 R4). */
export async function insertOnboardingFirstRunIfAbsent(
  db: PlatformDB,
  record: NewOnboardingFirstRun,
): Promise<void> {
  await db.ready;
  await withAccountDeletionOwnerLock(db,record.clerkUserId,async(trx,admission)=>{
    if(!admission.newWorkAllowed)return;
  await trx.executor
    .insertInto('onboarding_first_run')
    .values({
      clerk_user_id: record.clerkUserId,
      completed_at: record.completedAt,
      goal: record.goal ?? null,
      steps: JSON.stringify(record.steps ?? {}),
      source: record.source,
    })
    .onConflict((oc) => oc.column('clerk_user_id').doNothing())
    .execute();
  });
}

/** Running machines whose owner has no first-run record yet (backfill candidates). */
export async function listRunningMachinesMissingFirstRun(
  db: PlatformDB,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll('user_machines')
    .leftJoin('onboarding_first_run', 'onboarding_first_run.clerk_user_id', 'user_machines.clerk_user_id')
    .where('user_machines.status', '=', 'running')
    .where('user_machines.deleted_at', 'is', null)
    .where('onboarding_first_run.clerk_user_id', 'is', null)
    .orderBy('user_machines.provisioned_at')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

export async function getLatestJourneyEvent(
  db: PlatformDB,
  clerkUserId: string,
): Promise<OnboardingJourneyEventRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('onboarding_journey_events')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .orderBy('at', 'desc')
    .executeTakeFirst();
  return row
    ? {
        id: row.id,
        clerkUserId: row.clerk_user_id,
        fromPhase: row.from_phase,
        toPhase: row.to_phase,
        detail: row.detail,
        at: row.at,
      }
    : undefined;
}

export async function appendJourneyEvent(
  db: PlatformDB,
  record: { id: string; clerkUserId: string; fromPhase: string | null; toPhase: string; detail: string | null; at: string },
): Promise<void> {
  await db.ready;
  await withAccountDeletionOwnerLock(db,record.clerkUserId,async(trx,admission)=>{
    if(!admission.newWorkAllowed)return;
  await trx.executor
    .insertInto('onboarding_journey_events')
    .values({
      id: record.id,
      clerk_user_id: record.clerkUserId,
      from_phase: record.fromPhase,
      to_phase: record.toPhase,
      detail: record.detail,
      at: record.at,
    })
    .execute();
  });
}
