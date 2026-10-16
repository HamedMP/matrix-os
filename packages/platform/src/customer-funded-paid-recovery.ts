/** Operator-only bounded exception. Never mount on a route or background worker. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import { MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import type { PlatformDB } from './db.js';
import { getBillingSubscription } from './db.js';
import { getRuntimeAccessDecision } from './billing.js';
import { resolveEffectiveBillingEntitlementForSlot } from './billing-entitlement-resolver.js';
import { lockCustomerFundedStarterActivation, initializeCustomerFundedStarterPolicy } from './customer-funded-starter-policy.js';
import { exactInteger, parseModels } from './ai-funded-metering-helpers.js';

const Reference = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Timestamp = z.iso.datetime({ offset: true });
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PaidStarterRecoveryReviewSchema = z.object({
  version: z.literal(1), authorizationReference: Reference, issuedAt: Timestamp, expiresAt: Timestamp,
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/), accountDeletionMode: z.enum(['enabled', 'disabled']),
  disabledDeletionAuthority: z.object({
    servingRevision: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict().optional(),
  targets: z.array(z.object({ ownerId: Reference, machineId: z.uuid(), runtimeSlot: z.literal('primary'),
    expectedRuntimeTokenEpoch: z.number().int().min(1).max(2_147_483_647),
    expectedImageVersion: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    expectedSubscriptionId: Reference, expectedSubscriptionUpdatedAt: Timestamp,
  }).strict()).min(1).max(3),
}).strict().superRefine((review, context) => {
  if ((review.accountDeletionMode === 'disabled') !== (review.disabledDeletionAuthority !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Explicit deletion authority mismatch' });
  }
  if (new Set(review.targets.map(target => target.ownerId)).size !== review.targets.length
    || new Set(review.targets.map(target => target.machineId)).size !== review.targets.length
    || new Set(review.targets.map(target => target.expectedSubscriptionId)).size !== review.targets.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate recovery identity' });
  }
});
export type PaidStarterRecoveryReview = z.infer<typeof PaidStarterRecoveryReviewSchema>;
export interface PaidStarterRecoveryResult {
  mode: 'dry-run' | 'applied'; fingerprint: string; targetCount: number; grantedMicrousd: number;
}
const Mode = z.object({ apply: z.boolean().optional(), reviewedFingerprint: Digest.optional() }).strict();
const ORDINARY = ['anthropic/claude-sonnet-5', ...MANAGED_WORKERS_AI_MODEL_IDS];
const MAX_OWNER_ROWS = 128;
function requireValid(value: unknown): asserts value {
  if (!value) throw new Error('Paid starter recovery refused; review current eligibility');
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item)).digest('hex');
}
function assertFresh(review: PaidStarterRecoveryReview, now: Date) {
  const issued = Date.parse(review.issuedAt); const expires = Date.parse(review.expiresAt); const current = now.getTime();
  requireValid(Number.isFinite(current) && issued <= current && current < expires
    && expires - issued > 0 && expires - issued <= 5 * 60_000);
}
function assertDeletionAuthority(review: PaidStarterRecoveryReview, env: NodeJS.ProcessEnv) {
  if (review.accountDeletionMode === 'enabled') {
    requireValid(Buffer.byteLength(env.ACCOUNT_DELETION_SECRET ?? '') >= 32);
    return;
  }
  // These are operator attestations of a fresh authenticated serving-config
  // read, not production feature gates. Missing secret alone never authorizes
  // this branch, and a present/empty secret still defines an unsafe namespace.
  requireValid(env.ACCOUNT_DELETION_SECRET === undefined
    && (env.ACCOUNT_DELETION_ENABLED === undefined || env.ACCOUNT_DELETION_ENABLED === 'false')
    && review.disabledDeletionAuthority
    && review.disabledDeletionAuthority.servingRevision === env.MATRIX_PAID_STARTER_RECOVERY_PLATFORM_REVISION
    && review.disabledDeletionAuthority.imageDigest === env.MATRIX_PAID_STARTER_RECOVERY_PLATFORM_IMAGE_DIGEST);
}

export function createPaidStarterRecovery(options: {
  db: PlatformDB; env: NodeJS.ProcessEnv; sourceSha: string; now: () => Date;
}) {
  return async (input: unknown, modeInput: { apply?: boolean; reviewedFingerprint?: string } = {}): Promise<PaidStarterRecoveryResult> => {
    const review = PaidStarterRecoveryReviewSchema.parse(input); const mode = Mode.parse(modeInput);
    const env = { ...options.env }; const apply = mode.apply === true;
    requireValid(env.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED === 'true' && env.MATRIX_FUNDED_AI_RUNTIME_ENABLED === 'true'
      && Buffer.byteLength(env.AI_FUNDED_CREDENTIAL_HASH_SECRET ?? '') >= 32
      && review.sourceSha === options.sourceSha && (!apply || mode.reviewedFingerprint));
    assertDeletionAuthority(review, env);
    const began = options.now().getTime(); const monotonic = performance.now();
    // An injected/frozen wall clock must not extend the reviewed mutation window.
    const now = () => new Date(Math.max(options.now().getTime(), began + performance.now() - monotonic));
    assertFresh(review, now()); await options.db.ready;
    const targets = [...review.targets].sort((left, right) => left.ownerId.localeCompare(right.ownerId));
    return options.db.transaction(async trx => {
      // READ COMMITTED is essential: an advisory-lock wait must not freeze the
      // pre-wait deletion/billing snapshot. Each admission read after the lock
      // sees newly committed denial. Existing rows stay locked through apply;
      // independent administrative inserts retain a documented point-in-time boundary.
      await sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(trx.executor);
      if (!apply) await sql`SET TRANSACTION READ ONLY`.execute(trx.executor);
      await sql`SET LOCAL lock_timeout = '3000ms'`.execute(trx.executor);
      await sql`SET LOCAL statement_timeout = '10000ms'`.execute(trx.executor);
      // All owners before any billing/machine row. Existing activation paths use
      // the same deletion -> funding-owner lock order; billing-only row writers
      // are constrained separately below, not by an assumed funding advisory lock.
      for (const target of targets) {
        await lockCustomerFundedStarterActivation(trx, target.ownerId, env);
        assertFresh(review, now());
      }
      const assertNoDeletionJobs = async () => {
        if (review.accountDeletionMode !== 'disabled') return;
        // Without the deployed hash namespace, even an unrelated/cancelled job
        // cannot safely be attributed. Read fresh under READ COMMITTED. Product
        // scheduling is absent; independent admin SQL remains a coordinated limit.
        const job = await trx.executor.selectFrom('account_deletion_jobs').select('owner_hash').limit(1).executeTakeFirst();
        requireValid(!job);
      };
      await assertNoDeletionJobs();
      const lock = <T extends { forUpdate(): T }>(query: T): T => apply ? query.forUpdate() : query;
      const snapshots: unknown[] = [];
      let eligibleThrough = Infinity;
      for (const target of targets) {
        assertFresh(review, now());
        const subscriptions = await lock(trx.executor.selectFrom('billing_subscriptions').selectAll()
          .where('clerk_user_id', '=', target.ownerId).orderBy('stripe_subscription_id').limit(MAX_OWNER_ROWS + 1)).execute();
        const entitlementRows = await lock(trx.executor.selectFrom('billing_entitlements').selectAll()
          .where('clerk_user_id', '=', target.ownerId)).execute();
        const overrides = await lock(trx.executor.selectFrom('billing_entitlement_overrides').selectAll()
          .where('clerk_user_id', '=', target.ownerId).orderBy('id').limit(MAX_OWNER_ROWS + 1)).execute();
        requireValid(subscriptions.length <= MAX_OWNER_ROWS && overrides.length <= MAX_OWNER_ROWS);
        const checked = now(); assertFresh(review, checked);
        const subscription = subscriptions.find(row => row.stripe_subscription_id === target.expectedSubscriptionId);
        requireValid(subscription && subscription.runtime_slot === 'primary' && subscription.status === 'active'
          && subscription.updated_at === target.expectedSubscriptionUpdatedAt
          && subscription.current_period_end !== null && Date.parse(subscription.current_period_end) > checked.getTime()
          && subscription.trial_converted_at !== null && Date.parse(subscription.trial_converted_at) <= checked.getTime()
          && subscription.first_trial_payment_failed_at === null);
        eligibleThrough = Math.min(eligibleThrough, Date.parse(subscription.current_period_end));
        // Use the same slot-selection and effective billing authorities as the
        // product, while requiring lifecycle evidence omitted by its projection.
        const selected = await getBillingSubscription(trx, target.ownerId, 'primary', checked.toISOString());
        const effective = await resolveEffectiveBillingEntitlementForSlot(trx, target.ownerId, checked, 'primary', env);
        requireValid(selected?.stripeSubscriptionId === target.expectedSubscriptionId && effective
          && effective.source === 'stripe' && effective.clerkUserId === target.ownerId
          && effective.status === 'active' && effective.maxRuntimeSlots >= 1
          && effective.stripeSubscriptionId === target.expectedSubscriptionId
          && getRuntimeAccessDecision(effective, checked).runtimeProxyAllowed);
        const machine = await lock(trx.executor.selectFrom('user_machines')
          .select(['machine_id', 'clerk_user_id', 'runtime_slot', 'runtime_token_epoch', 'image_version',
            'provisioning_class', 'status', 'activation_state', 'deleted_at'])
          .where('machine_id', '=', target.machineId)).executeTakeFirst();
        requireValid(machine && machine.clerk_user_id === target.ownerId && machine.runtime_slot === 'primary'
          && machine.runtime_token_epoch === target.expectedRuntimeTokenEpoch && machine.image_version === target.expectedImageVersion
          && machine.provisioning_class === 'customer' && machine.status === 'running'
          && machine.activation_state === 'authorized' && machine.deleted_at === null);
        const policy = await lock(trx.executor.selectFrom('ai_funded_runtime_policies').selectAll()
          .where('machine_id', '=', target.machineId)).executeTakeFirst();
        requireValid(!policy); // Frozen cohort is missing policy, never a policy override.
        const restrictions = await lock(trx.executor.selectFrom('ai_funded_credit_restrictions').selectAll()
          .where('owner_id', '=', target.ownerId).orderBy('machine_id').limit(MAX_OWNER_ROWS + 1)).execute();
        requireValid(restrictions.length <= MAX_OWNER_ROWS && restrictions.every(row => !row.frozen && exactInteger(row.debt_microusd) === 0));
        const balances = await lock(trx.executor.selectFrom('ai_funded_runtime_balances').selectAll()
          .where('owner_id', '=', target.ownerId).orderBy('machine_id').limit(MAX_OWNER_ROWS + 1)).execute();
        requireValid(balances.length <= MAX_OWNER_ROWS && balances.every(row => exactInteger(row.reserved_microusd) === 0
          && exactInteger(row.funding_shortfall_microusd) === 0 && exactInteger(row.month_reserved_microusd) === 0));
        const targetBalance = await lock(trx.executor.selectFrom('ai_funded_runtime_balances').selectAll()
          .where('machine_id', '=', target.machineId)).executeTakeFirst();
        requireValid(!targetBalance || (targetBalance.owner_id === target.ownerId && targetBalance.runtime_slot === 'primary'));
        const prior = await trx.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
          .where('owner_id', '=', target.ownerId).where('kind', 'in', ['promotional_grant', 'addon_grant'])
          .where(eb => eb.not(eb.and([eb('kind', '=', 'promotional_grant'),
            eb('entry_id', 'like', 'speech-monthly:%'), eb('source_reference', 'like', 'platform-speech-monthly:%')]))).limit(1).executeTakeFirst();
        requireValid(!prior); // Includes consumed/expired grants and grants on other runtimes.
        const pending = await trx.executor.selectFrom('ai_funded_usage_reservations').select('reservation_id')
          .where('owner_id', '=', target.ownerId).where(eb => eb.or([
            eb('status', 'not in', ['settled', 'released']),
            eb.and([eb('status', '=', 'settled'), eb('actual_microusd', 'is', null)]),
            eb('charge_waiver', 'is not', null),
          ])).limit(1).executeTakeFirst();
        requireValid(!pending);
        // Capture speech rows too: a changed allocation invalidates the prepared
        // fingerprint even if it still satisfies the no-general-grant predicate.
        const speech = await trx.executor.selectFrom('ai_funded_promotional_grant_balances').selectAll()
          .where('owner_id', '=', target.ownerId).orderBy('grant_entry_id').limit(MAX_OWNER_ROWS + 1).execute();
        requireValid(speech.length <= MAX_OWNER_ROWS && speech.every(row => row.grant_entry_id.startsWith('speech-monthly:')
          && exactInteger(row.remaining_microusd) >= 0
          && (row.expires_at === null || (Number.isFinite(Date.parse(row.expires_at))
            && (exactInteger(row.remaining_microusd) === 0 || Date.parse(row.expires_at) > now().getTime())))
          && balances.some(balance => balance.machine_id === row.machine_id && balance.runtime_slot === row.runtime_slot)));
        for (const grant of speech) {
          if (exactInteger(grant.remaining_microusd) > 0 && grant.expires_at !== null) {
            eligibleThrough = Math.min(eligibleThrough, Date.parse(grant.expires_at));
          }
        }
        const speechLedger = speech.length ? await trx.executor.selectFrom('ai_funded_credit_ledger').selectAll()
          .where('entry_id', 'in', speech.map(row => row.grant_entry_id)).orderBy('entry_id').limit(MAX_OWNER_ROWS + 1).execute() : [];
        requireValid(speechLedger.length === speech.length && speech.every(row => speechLedger.some(ledger =>
          ledger.entry_id === row.grant_entry_id && ledger.owner_id === target.ownerId && ledger.machine_id === row.machine_id
          && ledger.runtime_slot === row.runtime_slot && ledger.kind === 'promotional_grant'
          && ledger.source_reference.startsWith('platform-speech-monthly:') && ledger.expires_at === row.expires_at
          && exactInteger(ledger.amount_microusd) >= exactInteger(row.remaining_microusd))));
        // No prior general provenance is insufficient if aggregate money is
        // unexplained. Require exact nonnegative speech-only allocation backing.
        requireValid(balances.every(balance => {
          const total = speech.filter(row => row.machine_id === balance.machine_id && row.runtime_slot === balance.runtime_slot)
            .reduce((sum, row) => sum + exactInteger(row.remaining_microusd), 0);
          return Number.isSafeInteger(total) && total >= 0 && exactInteger(balance.addon_balance_microusd) === 0
            && exactInteger(balance.credit_balance_microusd) === total && exactInteger(balance.promotional_balance_microusd) === total
            && exactInteger(balance.month_spent_microusd) >= 0
            && (balance.machine_id !== target.machineId || total <= Number.MAX_SAFE_INTEGER - 5_000_000);
        }));
        snapshots.push({ machine, subscriptions, entitlementRows, overrides, balances, restrictions, speech, speechLedger });
      }
      const global = await lock(trx.executor.selectFrom('ai_funded_global_policy').selectAll()
        .where('policy_id', '=', 'default')).executeTakeFirstOrThrow();
      requireValid(global.enabled && parseModels(global.allowed_model_ids).some(model => ORDINARY.includes(model)));
      const fingerprint = hash({ review, global, snapshots, billingCatalog: {
        runtime: env.MATRIX_RUNTIME_CATALOG_JSON ?? null, legacy: env.STRIPE_LEGACY_PRICE_CATALOG_JSON ?? null,
        prices: Object.entries(env).filter(([key]) => key.startsWith('STRIPE_PRICE_')).sort(([a], [b]) => a.localeCompare(b)),
      } });
      assertFresh(review, now());
      requireValid(now().getTime() < eligibleThrough);
      const response: PaidStarterRecoveryResult = { mode: apply ? 'applied' : 'dry-run', fingerprint,
        targetCount: targets.length, grantedMicrousd: apply ? targets.length * 5_000_000 : 0 };
      if (!apply) return response;
      requireValid(mode.reviewedFingerprint === fingerprint);
      for (const target of targets) {
        await assertNoDeletionJobs();
        const checked = now(); assertFresh(review, checked);
        requireValid(checked.getTime() < eligibleThrough);
        requireValid(await initializeCustomerFundedStarterPolicy(trx, target.machineId, { now: checked.toISOString(), env }));
      }
      await assertNoDeletionJobs();
      assertFresh(review, now());
      requireValid(now().getTime() < eligibleThrough);
      return response;
    });
  };
}
