import { sql } from 'kysely';
import { withAccountDeletionOwnerLock } from '../account-deletion/admission.js';
import {
  getActiveUserMachineByClerkId,
  type PlatformDB,
} from '../db.js';
import { abandonExpiredUnattachedCheckout, unattachedCheckoutExpiryCutoff } from '../database/checkout-attempts.js';
import { getActivePrebillingIntent } from '../prebilling-provisioning-store.js';
import type { MetalProvisioner } from '../substrates/metal-provisioner.js';
import type { FreeTierConfig } from './config.js';
import { buildFreeEntitlement, FREE_RUNTIME_SLOT } from './free-entitlement.js';
import {
  FreeEntitlementReplacementRefused,
  hasOtherLiveRuntime,
  paidRightsEnded,
  storedEntitlementEnded,
  writeFreeEntitlement,
} from './former-paid-owner.js';
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
 *
 * A former paid owner may take the free plan once every paid right has ended
 * (ENG-520 P7, ported from PR #3437): their stored entitlement is an ended
 * Stripe one, no subscription or override still grants anything, and they
 * hold no other live runtime. The free entitlement then replaces the ended
 * row in one guarded statement, and a later live subscription still wins.
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
  | { kind: 'throttled' }
  | { kind: 'retry_exhausted' }
  | { kind: 'support_required' }
  | { kind: 'provisioning_unavailable' };

export interface FreeRuntimeProvisionerDeps {
  db: PlatformDB;
  config: FreeTierConfig;
  metal: Pick<MetalProvisioner, 'provision'> & Partial<Pick<MetalProvisioner, 'failExpiredProvisioning'>>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * Runs after admission commits, outside its transaction (ENG-520 launch
   * guard: expire the owner's open paid Checkout sessions). Failures are
   * logged; the free owner billing sweep retries.
   */
  afterAdmitted?: (clerkUserId: string) => Promise<unknown>;
}

const CAPACITY_LOCK_KEY = 'matrix:free-tier:runtime-capacity';

type Admission =
  | { kind: 'admitted' }
  | { kind: 'existing'; runtime: FreeRuntimeRecord }
  | { kind: 'waitlisted' | 'busy' | 'runtime_exists' | 'plan_unavailable' | 'deletion_pending' | 'checkout_pending' };

/**
 * Check creating claims that can still yield a session, all open attempts,
 * paid attempts without a later subscription event, and prebilling intents.
 * Attempts count in every slot: a paid checkout for a second computer that
 * survived the owner joining free would charge a free owner (ENG-520 launch
 * guard). Prebilling intents exist only for the free slot.
 */
async function paidCheckoutPending(db: PlatformDB, clerkUserId: string, at: Date): Promise<boolean> {
  const attempt = await db.executor.selectFrom('billing_checkout_attempts as a').select('a.id')
    .where('a.clerk_user_id', '=', clerkUserId)
    .where((eb) => eb.or([
      eb('a.status', '=', 'open'),
      eb.and([
        eb('a.status', '=', 'creating'),
        eb.or([
          eb('a.stripe_session_id', 'is not', null),
          eb('a.created_at', '>=', unattachedCheckoutExpiryCutoff(at)),
        ]),
      ]),
      eb.and([
        eb('a.status', '=', 'paid'),
        eb.not(eb.exists(eb.selectFrom('billing_subscriptions as s').select(sql<number>`1`.as('one'))
          .whereRef('s.clerk_user_id', '=', 'a.clerk_user_id').whereRef('s.runtime_slot', '=', 'a.runtime_slot')
          .where(sql<boolean>`s.latest_event_created_at::timestamptz >= a.created_at::timestamptz`))),
      ]),
    ]))
    .limit(1).executeTakeFirst();
  if (attempt) return true;
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
      const at = now();
      const atIso = at.toISOString();
      const entitlement = await trx.executor.selectFrom('billing_entitlements').select('source')
        .where('clerk_user_id', '=', clerkUserId).executeTakeFirst();
      const free = entitlement?.source === 'free';
      // A stored paid entitlement blocks the free plan until every paid right in it has ended.
      if (entitlement && !free && !await storedEntitlementEnded(trx, clerkUserId, atIso)) {
        return { kind: 'plan_unavailable' };
      }
      if (current && current.status !== 'failed') {
        // A metal runtime without a free entitlement is a paid or operator runtime, not this plan's.
        return free ? { kind: 'existing', runtime: toRecord(current) } : { kind: 'runtime_exists' };
      }
      if (await hasOtherLiveRuntime(trx, clerkUserId)) return { kind: 'runtime_exists' };
      if (!await paidRightsEnded(trx, clerkUserId, atIso)) return { kind: 'plan_unavailable' };
      // Checked under the billing owner lock, which checkout creation also takes.
      await abandonExpiredUnattachedCheckout(trx, clerkUserId, FREE_RUNTIME_SLOT, at);
      if (await paidCheckoutPending(trx, clerkUserId, at)) return { kind: 'checkout_pending' };
      // Already admitted: the invite was redeemed and the owner is counted.
      if (free) return { kind: 'admitted' };
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
      // Inserts, or replaces an ended paid row; a row that stopped being replaceable throws and rolls back.
      await writeFreeEntitlement(trx, buildFreeEntitlement(clerkUserId, at));
      return { kind: 'admitted' };
    }, deps.env);
  }

  async function reconcileExpired(clerkUserId: string): Promise<void> {
    if (!deps.metal.failExpiredProvisioning) return;
    try {
      await deps.metal.failExpiredProvisioning(clerkUserId, FREE_RUNTIME_SLOT);
    } catch (error: unknown) {
      // Admission still answers from current state; the maintenance pass or the next request retries.
      console.error('[free-tier] expired build reconciliation failed:', error instanceof Error ? error.name : 'unknown');
    }
  }

  async function runAfterAdmitted(clerkUserId: string): Promise<void> {
    if (!deps.afterAdmitted) return;
    try {
      await deps.afterAdmitted(clerkUserId);
    } catch (error: unknown) {
      console.error('[free-tier] post-admission checkout expiry failed:', error instanceof Error ? error.name : 'unknown');
    }
  }

  async function admitOrRefuse(clerkUserId: string): Promise<Admission> {
    try {
      return await admit(clerkUserId);
    } catch (error: unknown) {
      // The transaction rolled back, so the invite and the stored entitlement are untouched.
      if (error instanceof FreeEntitlementReplacementRefused) return { kind: 'plan_unavailable' };
      throw error;
    }
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
      const free = entitlement?.source === 'free';
      const at = now();
      const atIso = at.toISOString();
      // The same order as admission, so the journey, billing status, and provisioning agree.
      if (entitlement && !free && !await storedEntitlementEnded(db, clerkUserId, atIso)) return false;
      // A metal runtime without a free entitlement belongs to another plan.
      if (!free && current && current.status !== 'failed') return false;
      if (await hasOtherLiveRuntime(db, clerkUserId)) return false;
      if (!await paidRightsEnded(db, clerkUserId, atIso)) return false;
      if (await paidCheckoutPending(db, clerkUserId, at)) return false;
      if (free) return true;
      if (!config.inviteRequired) return true;
      const invite = await getFreeTierInvite(db, clerkUserId);
      return Boolean(invite && !invite.consumedAt);
    },

    /**
     * Fails the owner's free runtime if its first boot never registered within
     * the registration window (journey read path); see failExpiredProvisioning.
     */
    async reconcileStaleRuntime(clerkUserId: string, runtimeSlot: string = FREE_RUNTIME_SLOT): Promise<void> {
      if (runtimeSlot !== FREE_RUNTIME_SLOT || !deps.metal.failExpiredProvisioning) return;
      await deps.metal.failExpiredProvisioning(clerkUserId, runtimeSlot);
    },

    async provision(input: { clerkUserId: string; handle: string }): Promise<FreeProvisionOutcome> {
      // Outside the admission transaction: a build whose registration window
      // closed is failed first, so a repeat request retries it instead of
      // returning a runtime that can never register (no maintenance worker needed).
      await reconcileExpired(input.clerkUserId);
      const admission = await admitOrRefuse(input.clerkUserId);
      if (admission.kind === 'admitted' || admission.kind === 'existing') await runAfterAdmitted(input.clerkUserId);
      if (admission.kind !== 'admitted') return admission;
      const result = await deps.metal.provision({
        clerkUserId: input.clerkUserId, handle: input.handle, tier: 'free', runtimeSlot: FREE_RUNTIME_SLOT,
      });
      if ('error' in result) {
        switch (result.error) {
          case 'busy':
          case 'throttled':
          case 'retry_exhausted':
          case 'support_required':
            return { kind: result.error };
          default:
            return { kind: 'provisioning_unavailable' };
        }
      }
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
  metal: (Pick<MetalProvisioner, 'provision'> & Partial<Pick<MetalProvisioner, 'failExpiredProvisioning'>>) | undefined;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  afterAdmitted?: FreeRuntimeProvisionerDeps['afterAdmitted'];
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
      ...(input.afterAdmitted ? { afterAdmitted: input.afterAdmitted } : {}),
    }),
  };
}
