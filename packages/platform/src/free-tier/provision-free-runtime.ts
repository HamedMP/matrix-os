import { sql } from 'kysely';
import { withAccountDeletionOwnerLock } from '../account-deletion/admission.js';
import { toBillingEntitlementRow } from '../database/billing-records.js';
import {
  getActiveUserMachineByClerkId,
  getSettlingCheckoutAttempt,
  type PlatformDB,
} from '../db.js';
import { getActivePrebillingIntent } from '../prebilling-provisioning-store.js';
import type { MetalProvisioner } from '../substrates/metal-provisioner.js';
import type { FreeTierConfig } from './config.js';
import { buildFreeEntitlement, FREE_RUNTIME_SLOT } from './free-entitlement.js';
import { countFreeOwners, getFreeTierInvite, redeemFreeTierInvite } from './invites.js';

/**
 * Admits an owner to the free plan and provisions their free metal runtime
 * (spec 2691, ENG-520). Ported from PR #3414's container provisioner; the
 * container provider and owner database are replaced by `MetalProvisioner`.
 *
 * Admission and provisioning are two steps:
 * 1. Under the owner's account-deletion and billing locks, one transaction
 *    checks the slot, the stored entitlement, the invite and the global
 *    ceiling, redeems the invite and stores the free entitlement. The stored
 *    free entitlement is the record of admission: a later request skips the
 *    invite and the ceiling, so a failed metal create never strands an owner
 *    whose single invite is already used.
 * 2. `MetalProvisioner.provision` places, records and creates the VM. It is
 *    idempotent through the active-runtime unique index: a repeat or
 *    concurrent request returns the runtime already in the slot.
 *
 * The ceiling holds because every admission counts and inserts under one
 * transaction-scoped advisory lock.
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
  | { kind: 'checkout_pending' }
  | { kind: 'provisioning_unavailable' };

export interface FreeRuntimeProvisionerDeps {
  db: PlatformDB;
  config: FreeTierConfig;
  metal: Pick<MetalProvisioner, 'provision'>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const CAPACITY_LOCK_KEY = 'matrix:free-tier:runtime-capacity';

type Admission =
  | { kind: 'admitted' }
  | { kind: 'existing'; runtime: FreeRuntimeRecord }
  | { kind: 'waitlisted' | 'busy' | 'runtime_exists' | 'plan_unavailable' | 'deletion_pending' | 'checkout_pending' };

/**
 * A paid checkout for the free slot is in flight: any `paid` or `open` attempt
 * (whatever its age; a Stripe session stays open for up to 24 hours) or an
 * active prebilling intent. This is exactly the journey's free-plan rule
 * (`!checkoutAttempt`, from the same getSettlingCheckoutAttempt query), so
 * billing status, provisioning, and the journey always agree.
 */
async function paidCheckoutPending(db: PlatformDB, clerkUserId: string): Promise<boolean> {
  if (await getSettlingCheckoutAttempt(db, clerkUserId, FREE_RUNTIME_SLOT)) return true;
  return Boolean(await getActivePrebillingIntent(db, clerkUserId, FREE_RUNTIME_SLOT));
}

function toRecord(machine: { machineId: string; handle: string; runtimeSlot: string; status: string }): FreeRuntimeRecord {
  return { machineId: machine.machineId, handle: machine.handle, runtimeSlot: machine.runtimeSlot, status: machine.status };
}

export function createFreeRuntimeProvisioner(deps: FreeRuntimeProvisionerDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());

  async function admit(clerkUserId: string): Promise<Admission> {
    return withAccountDeletionOwnerLock(db, clerkUserId, async (trx, admission): Promise<Admission> => {
      if (!admission.newWorkAllowed) return { kind: 'deletion_pending' };
      const current = await getActiveUserMachineByClerkId(trx, clerkUserId, FREE_RUNTIME_SLOT);
      if (current && current.substrate !== 'metal') return { kind: 'runtime_exists' };
      const entitlement = await trx.executor.selectFrom('billing_entitlements').select('source')
        .where('clerk_user_id', '=', clerkUserId).executeTakeFirst();
      if (entitlement && entitlement.source !== 'free') return { kind: 'plan_unavailable' };
      if (current && current.status !== 'failed') {
        // A metal runtime without a free entitlement is a paid or operator runtime, not this plan's.
        return entitlement ? { kind: 'existing', runtime: toRecord(current) } : { kind: 'runtime_exists' };
      }
      // Checked under the billing owner lock, which checkout creation also takes.
      if (await paidCheckoutPending(trx, clerkUserId)) return { kind: 'checkout_pending' };
      // Already admitted: the invite was redeemed and the owner is counted.
      if (entitlement) return { kind: 'admitted' };
      if (config.inviteRequired) {
        const invite = await getFreeTierInvite(trx, clerkUserId);
        if (!invite || invite.consumedAt) return { kind: 'waitlisted' };
      }
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${CAPACITY_LOCK_KEY}, 0))`.execute(trx.executor);
      if (await countFreeOwners(trx) >= config.maxRuntimes) return { kind: 'busy' };
      // Redemption is the last check: every return above leaves the invite unconsumed.
      if (config.inviteRequired && await redeemFreeTierInvite(trx, clerkUserId) !== 'redeemed') {
        return { kind: 'waitlisted' };
      }
      await trx.executor.insertInto('billing_entitlements')
        .values(toBillingEntitlementRow(buildFreeEntitlement(clerkUserId, now())))
        .onConflict((oc) => oc.column('clerk_user_id').doNothing())
        .execute();
      return { kind: 'admitted' };
    }, deps.env);
  }

  return {
    /**
     * Read-only: whether provisioning would admit or continue this owner on the
     * free plan (ignoring the global ceiling, which `provision` answers as
     * busy). The onboarding journey uses it to offer the free plan instead of
     * checkout. Writes nothing and takes no locks.
     */
    async isEligible(clerkUserId: string, runtimeSlot: string = FREE_RUNTIME_SLOT): Promise<boolean> {
      if (runtimeSlot !== FREE_RUNTIME_SLOT) return false;
      const current = await getActiveUserMachineByClerkId(db, clerkUserId, FREE_RUNTIME_SLOT);
      if (current && current.substrate !== 'metal') return false;
      const entitlement = await db.executor.selectFrom('billing_entitlements').select('source')
        .where('clerk_user_id', '=', clerkUserId).executeTakeFirst();
      if (entitlement && entitlement.source !== 'free') return false;
      if (entitlement) return !(await paidCheckoutPending(db, clerkUserId));
      // A metal runtime without a free entitlement belongs to another plan.
      if (current && current.status !== 'failed') return false;
      if (await paidCheckoutPending(db, clerkUserId)) return false;
      if (!config.inviteRequired) return true;
      const invite = await getFreeTierInvite(db, clerkUserId);
      return Boolean(invite && !invite.consumedAt);
    },

    async provision(input: { clerkUserId: string; handle: string }): Promise<FreeProvisionOutcome> {
      const admission = await admit(input.clerkUserId);
      if (admission.kind !== 'admitted') return admission;
      const result = await deps.metal.provision({
        clerkUserId: input.clerkUserId, handle: input.handle, tier: 'free', runtimeSlot: FREE_RUNTIME_SLOT,
      });
      if ('error' in result) return result.error === 'busy' ? { kind: 'busy' } : { kind: 'provisioning_unavailable' };
      const machine = await getActiveUserMachineByClerkId(db, input.clerkUserId, FREE_RUNTIME_SLOT);
      if (!machine || machine.machineId !== result.machineId) return { kind: 'provisioning_unavailable' };
      return { kind: 'created', runtime: toRecord(machine) };
    },
  };
}

export type FreeRuntimeProvisioner = ReturnType<typeof createFreeRuntimeProvisioner>;

/** Startup composition: free signup needs the metal provisioner, else it stays unavailable (503). */
export function createFreeTierRuntime(input: {
  db: PlatformDB;
  config: FreeTierConfig | undefined;
  metal: Pick<MetalProvisioner, 'provision'> | undefined;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): { config: FreeTierConfig; provisioner?: FreeRuntimeProvisioner } | undefined {
  if (!input.config) return undefined;
  if (!input.metal) {
    (input.log ?? ((message: string) => console.warn(message)))(
      '[platform] free tier enabled without a configured metal substrate; free signup is unavailable');
    return { config: input.config };
  }
  return {
    config: input.config,
    provisioner: createFreeRuntimeProvisioner({
      db: input.db, config: input.config, metal: input.metal, ...(input.env ? { env: input.env } : {}),
    }),
  };
}
