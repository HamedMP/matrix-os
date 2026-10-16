import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { insertUserMachine, upsertBillingSubscription, type PlatformDB } from '../../packages/platform/src/db.js';

export const at = '2026-10-16T14:00:00.000Z';
export const sourceSha = 'a'.repeat(40);
export const model = '@cf/zai-org/glm-5.3-flash';
export const env = {
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
  AI_FUNDED_CREDENTIAL_HASH_SECRET: 'fixture-funding-hash-secret-at-least-32',
  ACCOUNT_DELETION_SECRET: 'fixture-deletion-secret-at-least-32',
  MATRIX_STRIPE_BILLING_ENABLED: 'true', STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_fixture_builder',
};
export interface Target {
  ownerId: string; machineId: string; runtimeSlot: 'primary'; expectedRuntimeTokenEpoch: number;
  expectedImageVersion: string; expectedSubscriptionId: string; expectedSubscriptionUpdatedAt: string;
}
export interface Review {
  version: 1; authorizationReference: string; issuedAt: string; expiresAt: string;
  sourceSha: string; accountDeletionMode: 'enabled'; targets: Target[];
}
export interface Result { mode: 'dry-run' | 'applied'; fingerprint: string; targetCount: number; grantedMicrousd: number }
export type Recover = (review: Review, mode?: { apply?: boolean; reviewedFingerprint?: string }) => Promise<Result>;
export interface Api {
  createPaidStarterRecovery(options: { db: PlatformDB; now: () => Date; env: NodeJS.ProcessEnv; sourceSha: string }): Recover;
}
export async function recoveryApi(): Promise<Api> {
  const url = new URL('../../packages/platform/src/customer-funded-paid-recovery.ts', import.meta.url);
  expect(existsSync(url), 'The reviewed, billing-guarded recovery operation must exist').toBe(true);
  return import(url.href) as Promise<Api>;
}
export function review(targets: Target[]): Review {
  return { version: 1, authorizationReference: 'fixture-explicit-three-owner-approval', issuedAt: at,
    expiresAt: '2026-10-16T14:05:00.000Z', sourceSha, accountDeletionMode: 'enabled', targets };
}
export function lifetimeId(ownerId: string): string {
  return `starter-lifetime:${createHash('sha256').update(ownerId).digest('hex')}`;
}
export async function seed(db: PlatformDB, count = 3): Promise<Target[]> {
  await db.executor.updateTable('ai_funded_global_policy').set({ enabled: true, revision: 1,
    allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5', model]) }).where('policy_id', '=', 'default').execute();
  const targets: Target[] = [];
  for (let index = 0; index < count; index++) {
    const machineId = randomUUID(); const ownerId = `fixture_paid_${index}`;
    await insertUserMachine(db, { machineId, clerkUserId: ownerId, handle: `fixture-paid-${index}`,
      runtimeSlot: 'primary', provisioningClass: 'customer', activationState: 'authorized',
      runtimeTokenEpoch: 1, status: 'running', imageVersion: 'fixture-reviewed-db-version', provisionedAt: at });
    const subscriptionId = `sub_fixture_${index}`;
    await upsertBillingSubscription(db, { stripeSubscriptionId: subscriptionId, stripeCustomerId: `cus_fixture_${index}`,
      clerkUserId: ownerId, runtimeSlot: 'primary', planSlug: 'matrix_builder', stripePriceId: 'price_fixture_builder',
      status: 'active', billingInterval: 'monthly', currentPeriodEnd: '2026-11-16T00:00:00.000Z', gracePeriodEndsAt: null,
      trialStartedAt: '2026-10-01T00:00:00.000Z', trialEndsAt: '2026-10-08T00:00:00.000Z',
      trialConvertedAt: '2026-10-08T00:01:00.000Z', firstTrialPaymentFailedAt: null,
      latestEventCreatedAt: at, latestEventId: `evt_fixture_${index}`, updatedAt: at });
    const identity = { ownerId, machineId, runtimeSlot: 'primary' };
    await db.executor.insertInto('ai_funded_runtime_balances').values({ machine_id: machineId, owner_id: ownerId,
      runtime_slot: 'primary', credit_balance_microusd: 0, promotional_balance_microusd: 0, addon_balance_microusd: 0,
      reserved_microusd: 0, funding_shortfall_microusd: 0, month_period_start: '2026-10-01T00:00:00.000Z',
      month_spent_microusd: 0, month_reserved_microusd: 0, updated_at: at }).execute();
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: env.AI_FUNDED_CREDENTIAL_HASH_SECRET,
      now: () => new Date(at) });
    await repository.grantCredit({ identity, entryId: `speech-monthly:2026-10:fixture_${index}`, kind: 'promotional_grant',
      amountMicrousd: 1_000_000, sourceReference: 'platform-speech-monthly:2026-10',
      expiresAt: '2026-11-01T00:00:00.000Z' });
    targets.push({ ...identity, runtimeSlot: 'primary', expectedRuntimeTokenEpoch: 1,
      expectedImageVersion: 'fixture-reviewed-db-version', expectedSubscriptionId: subscriptionId,
      expectedSubscriptionUpdatedAt: at });
  }
  return targets;
}
export async function financialSnapshot(db: PlatformDB) {
  return {
    policies: await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().orderBy('machine_id').execute(),
    balances: await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().orderBy('machine_id').execute(),
    ledger: await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().orderBy('entry_id').execute(),
    grants: await db.executor.selectFrom('ai_funded_promotional_grant_balances').selectAll().orderBy('grant_entry_id').execute(),
  };
}
