import { MATRIX_FREE_AI_CREDIT_UNAVAILABLE, MATRIX_FREE_UPGRADE_UNAVAILABLE } from '@matrix-os/contracts';
import type { PlatformDB } from '../db.js';
import { FREE_RUNTIME_SLOT } from './free-entitlement.js';

/**
 * Launch guard (spec 2691, ENG-520): free to paid upgrade is ENG-606 and does
 * not exist yet. Paid checkout reuses an owner's existing machine, so a free
 * owner who paid would keep the free metal VM and its limits: a charge with
 * no paid computer. Until upgrade ships, a free owner gets no paid checkout
 * in any slot, including a second computer.
 */

export const FREE_UPGRADE_UNAVAILABLE_RESPONSE = {
  code: MATRIX_FREE_UPGRADE_UNAVAILABLE.code,
  error: MATRIX_FREE_UPGRADE_UNAVAILABLE.message,
} as const;

/** AI credit purchases are closed to free owners too, with credit-specific copy. */
export const FREE_AI_CREDIT_UNAVAILABLE_RESPONSE = {
  code: MATRIX_FREE_AI_CREDIT_UNAVAILABLE.code,
  error: MATRIX_FREE_AI_CREDIT_UNAVAILABLE.message,
} as const;

export class FreeUpgradeUnavailableError extends Error {
  constructor() {
    super('paid checkout is unavailable for a free plan owner');
    this.name = 'FreeUpgradeUnavailableError';
  }
}

/**
 * True when the owner holds the stored free entitlement or has a live metal
 * runtime in the free slot. Metal runtimes are only built for the free plan
 * today, so a metal VM marks a free owner even before or without the stored row.
 */
export async function ownerOnFreePlan(db: PlatformDB, clerkUserId: string): Promise<boolean> {
  await db.ready;
  const entitlement = await db.executor.selectFrom('billing_entitlements').select('source')
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  if (entitlement?.source === 'free') return true;
  const metal = await db.executor.selectFrom('user_machines').select('machine_id')
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .where('substrate', '=', 'metal')
    .where('runtime_slot', '=', FREE_RUNTIME_SLOT)
    .executeTakeFirst();
  return metal !== undefined;
}

/** Throws FreeUpgradeUnavailableError for a free owner. Reads only; call it under the owner lock to close the admission race. */
export async function assertPaidCheckoutAllowed(db: PlatformDB, clerkUserId: string): Promise<void> {
  if (await ownerOnFreePlan(db, clerkUserId)) throw new FreeUpgradeUnavailableError();
}
