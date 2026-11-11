import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withAccountDeletionOwnerLock } from '../account-deletion/admission.js';
import { toBillingEntitlementRow } from '../database/billing-records.js';
import { insertUserMachine } from '../database/user-machines.js';
import type { PlatformDB } from '../db.js';
import type { ContainerOwnerDatabases } from '../substrates/container-owner-database.js';
import type { FreeTierConfig } from './config.js';
import { buildFreeEntitlement, FREE_RUNTIME_SLOT } from './free-entitlement.js';
import { countFreeRuntimes, getFreeTierInvite, redeemFreeTierInvite } from './invites.js';

/**
 * Creates an owner's free container runtime record and owner database. It
 * never starts compute: the first authenticated owner request does that.
 *
 * One runtime per owner holds because creation runs under the owner's
 * account-deletion and billing locks and the partial unique index on active
 * container runtimes backs it. The capacity ceiling holds because every
 * creation counts and inserts under one transaction-scoped advisory lock.
 */

export interface FreeRuntimeRecord {
  machineId: string;
  handle: string;
  runtimeSlot: string;
  status: string;
}

export type FreeProvisionOutcome =
  | { kind: 'created' | 'existing'; runtime: FreeRuntimeRecord }
  | { kind: 'waitlisted' }
  | { kind: 'busy' }
  | { kind: 'runtime_exists' }
  | { kind: 'plan_unavailable' }
  | { kind: 'deletion_pending' }
  | { kind: 'database_unavailable'; runtime: FreeRuntimeRecord };

export interface FreeRuntimeProvisionerDeps {
  db: PlatformDB;
  config: FreeTierConfig;
  ownerDatabases: Pick<ContainerOwnerDatabases, 'ensure'>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  newMachineId?: () => string;
  logError?: (message: string, detail: Record<string, string>) => void;
}

const CAPACITY_LOCK_KEY = 'matrix:free-tier:runtime-capacity';
const OWNER_DATABASE_TIMEOUT_MS = 30_000;
const UNIQUE_VIOLATION = '23505';

type Created = Extract<FreeProvisionOutcome, { kind: 'created' | 'existing' }>;
type Decision = Exclude<FreeProvisionOutcome, { kind: 'database_unavailable' }>;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code: unknown }).code === UNIQUE_VIOLATION;
}

async function findContainerRuntime(db: PlatformDB, clerkUserId: string) {
  return db.executor.selectFrom('user_machines')
    .select(['machine_id', 'handle', 'runtime_slot', 'status', 'generation'])
    .where('clerk_user_id', '=', clerkUserId)
    .where('substrate', '=', 'container')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

async function hasOtherRuntimeInSlot(db: PlatformDB, clerkUserId: string): Promise<boolean> {
  const row = await db.executor.selectFrom('user_machines').select('machine_id')
    .where('clerk_user_id', '=', clerkUserId)
    .where('runtime_slot', '=', FREE_RUNTIME_SLOT)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return Boolean(row);
}

async function hasActiveOwnerDatabase(db: PlatformDB, clerkUserId: string): Promise<boolean> {
  const row = await db.executor.selectFrom('container_owner_databases').select('clerk_user_id')
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return Boolean(row);
}

function toRecord(row: { machine_id: string; handle: string; runtime_slot: string; status: string }): FreeRuntimeRecord {
  return { machineId: row.machine_id, handle: row.handle, runtimeSlot: row.runtime_slot, status: row.status };
}

export function createFreeRuntimeProvisioner(deps: FreeRuntimeProvisionerDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const newMachineId = deps.newMachineId ?? (() => randomUUID());
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));

  async function decide(clerkUserId: string, handle: string): Promise<Decision> {
    return withAccountDeletionOwnerLock(db, clerkUserId, async (trx, admission): Promise<Decision> => {
      if (!admission.newWorkAllowed) return { kind: 'deletion_pending' };
      const existing = await findContainerRuntime(trx, clerkUserId);
      if (existing) return { kind: 'existing', runtime: toRecord(existing) };
      if (await hasOtherRuntimeInSlot(trx, clerkUserId)) return { kind: 'runtime_exists' };
      const entitlement = await trx.executor.selectFrom('billing_entitlements').select('source')
        .where('clerk_user_id', '=', clerkUserId).executeTakeFirst();
      if (entitlement && entitlement.source !== 'free') return { kind: 'plan_unavailable' };
      if (config.inviteRequired) {
        const invite = await getFreeTierInvite(trx, clerkUserId);
        if (!invite || invite.consumedAt) return { kind: 'waitlisted' };
      }
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK_KEY}, 0))`.execute(trx.executor);
      if (await countFreeRuntimes(trx) >= config.maxRuntimes) return { kind: 'busy' };
      // Redemption is the last check: every return above leaves the invite unconsumed.
      if (config.inviteRequired && await redeemFreeTierInvite(trx, clerkUserId) !== 'redeemed') {
        return { kind: 'waitlisted' };
      }
      const at = now();
      const machineId = newMachineId();
      await insertUserMachine(trx, {
        machineId,
        clerkUserId,
        handle,
        runtimeSlot: FREE_RUNTIME_SLOT,
        substrate: 'container',
        provisioningClass: 'free',
        status: 'stopped',
        imageVersion: null,
        provisionedAt: at.toISOString(),
        activationState: 'authorized',
      });
      await trx.executor.insertInto('billing_entitlements')
        .values(toBillingEntitlementRow(buildFreeEntitlement(clerkUserId, at)))
        .onConflict((oc) => oc.column('clerk_user_id').doNothing())
        .execute();
      return { kind: 'created', runtime: { machineId, handle, runtimeSlot: FREE_RUNTIME_SLOT, status: 'stopped' } };
    }, deps.env);
  }

  /** The owner database is created outside the transaction: it is provider DDL, idempotent, and re-run at first start. */
  async function ensureOwnerDatabase(clerkUserId: string, outcome: Created): Promise<FreeProvisionOutcome> {
    if (outcome.kind === 'existing' && await hasActiveOwnerDatabase(db, clerkUserId)) return outcome;
    const machine = await findContainerRuntime(db, clerkUserId);
    try {
      await deps.ownerDatabases.ensure(clerkUserId, machine?.generation ?? 1, AbortSignal.timeout(OWNER_DATABASE_TIMEOUT_MS));
      return outcome;
    } catch (error: unknown) {
      logError('[free-tier] owner database setup failed', {
        cause: error instanceof Error ? error.name : 'unknown',
        code: typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : 'none',
      });
      return { kind: 'database_unavailable', runtime: outcome.runtime };
    }
  }

  return {
    async provision(input: { clerkUserId: string; handle: string }): Promise<FreeProvisionOutcome> {
      let decision: Decision;
      try {
        decision = await decide(input.clerkUserId, input.handle);
      } catch (error: unknown) {
        // A concurrent paid or free insert for this owner or handle won the unique index; re-read the winner.
        if (!isUniqueViolation(error)) throw error;
        const existing = await findContainerRuntime(db, input.clerkUserId);
        decision = existing ? { kind: 'existing', runtime: toRecord(existing) } : { kind: 'runtime_exists' };
      }
      if (decision.kind !== 'created' && decision.kind !== 'existing') return decision;
      return ensureOwnerDatabase(input.clerkUserId, decision);
    },
  };
}

export type FreeRuntimeProvisioner = ReturnType<typeof createFreeRuntimeProvisioner>;

/** Startup composition: free signup needs the container substrate's owner databases, else it stays unavailable (503). */
export function createFreeTierRuntime(input: {
  db: PlatformDB;
  config: FreeTierConfig | undefined;
  ownerDatabases: Pick<ContainerOwnerDatabases, 'ensure'> | undefined;
  log?: (message: string) => void;
}): { config: FreeTierConfig; provisioner?: FreeRuntimeProvisioner } | undefined {
  if (!input.config) return undefined;
  if (!input.ownerDatabases) {
    (input.log ?? ((message: string) => console.warn(message)))(
      '[platform] free tier enabled without a configured container substrate; free signup is unavailable');
    return { config: input.config };
  }
  return {
    config: input.config,
    provisioner: createFreeRuntimeProvisioner({ db: input.db, config: input.config, ownerDatabases: input.ownerDatabases }),
  };
}
