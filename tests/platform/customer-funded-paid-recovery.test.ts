import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { at, env, financialSnapshot, lifetimeId, model, recoveryApi, review, seed, sourceSha,
  type Api, type Recover, type Review, type Target } from './paid-starter-recovery-fixture.js';

describe('explicit paid-primary missing starter recovery', () => {
  let api: Api; let db: PlatformDB; let targets: Target[]; let recover: Recover;
  beforeAll(async () => { api = await recoveryApi(); });
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); targets = await seed(db);
    recover = api.createPaidStarterRecovery({ db, env, sourceSha, now: () => new Date(at) });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const apply = async (input = review(targets)) => {
    const prepared = await recover(input);
    return recover(input, { apply: true, reviewedFingerprint: prepared.fingerprint });
  };
  async function unchanged(operation: () => Promise<unknown>) {
    const before = await financialSnapshot(db);
    await expect(operation()).rejects.toThrow();
    expect(await financialSnapshot(db)).toEqual(before);
  }
  const repository = () => createAiFundedPolicyRepository({ db,
    credentialHashSecret: env.AI_FUNDED_CREDENTIAL_HASH_SECRET, now: () => new Date(at) });

  it('defaults to a zero-write dry-run for the exact three paid targets', async () => {
    const before = await financialSnapshot(db);
    expect(await recover(review(targets))).toMatchObject({ mode: 'dry-run', targetCount: 3, grantedMicrousd: 0,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await financialSnapshot(db)).toEqual(before);
  });
  it('applies only three permanent standard grants while retaining speech allocation and epoch', async () => {
    const before = await financialSnapshot(db);
    expect(await apply()).toMatchObject({ mode: 'applied', targetCount: 3, grantedMicrousd: 15_000_000 });
    const after = await financialSnapshot(db);
    expect(after.ledger.filter(row => row.source_reference === 'matrix-ai-lifetime-starter'))
      .toEqual(expect.arrayContaining(targets.map(target => expect.objectContaining({ entry_id: lifetimeId(target.ownerId),
        owner_id: target.ownerId, machine_id: target.machineId, kind: 'promotional_grant',
        amount_microusd: 5_000_000, expires_at: null }))));
    expect(after.ledger.filter(row => row.source_reference.startsWith('platform-speech-monthly:'))).toEqual(before.ledger);
    expect(after.grants.filter(row => row.grant_entry_id.startsWith('speech-monthly:'))).toEqual(before.grants);
    expect(after.speechAllowances).toEqual(before.speechAllowances);
    expect(after.balances.map(row => Number(row.credit_balance_microusd))).toEqual([6_000_000, 6_000_000, 6_000_000]);
    expect(after.policies).toHaveLength(3);
    expect(after.policies.every(row => row.enabled && row.revision === 1 && Number(row.monthly_budget_microusd) === 5_000_000)).toBe(true);
    expect(await db.executor.selectFrom('user_machines').select('runtime_token_epoch').execute())
      .toEqual([{ runtime_token_epoch: 1 }, { runtime_token_epoch: 1 }, { runtime_token_epoch: 1 }]);
  });
  it('rejects apply without the fresh exact dry-run fingerprint', async () => {
    await unchanged(() => recover(review(targets), { apply: true }));
    await unchanged(() => recover(review(targets), { apply: true, reviewedFingerprint: 'b'.repeat(64) }));
  });
  it.each([
    ['empty', (input: Review) => { input.targets = []; }],
    ['excess', (input: Review) => { input.targets.push({ ...targets[0], machineId: '00000000-0000-4000-8000-000000000099', ownerId: 'fixture_outside' }); }],
    ['duplicate-owner', (input: Review) => { input.targets[1].ownerId = input.targets[0].ownerId; }],
    ['duplicate-machine', (input: Review) => { input.targets[1].machineId = input.targets[0].machineId; }],
    ['expired', (input: Review) => { input.expiresAt = at; }],
    ['future', (input: Review) => { input.issuedAt = '2026-10-16T14:01:00.000Z'; }],
    ['long-lived', (input: Review) => { input.expiresAt = '2026-10-17T14:00:00.000Z'; }],
    ['wrong-source', (input: Review) => { input.sourceSha = 'b'.repeat(40); }],
    ['unknown-field', (input: Review) => { Object.assign(input, { force: true }); }],
  ] as const)('rejects %s cohort authority before any write', async (_label, change) => {
    const input = review(structuredClone(targets)); change(input);
    await unchanged(() => recover(input, { apply: true, reviewedFingerprint: 'b'.repeat(64) }));
  });
  it.each([
    { status: 'past_due', trial_converted_at: null, first_trial_payment_failed_at: at,
      grace_period_ends_at: '2026-11-01T00:00:00.000Z' },
    { status: 'trialing', trial_converted_at: null, trial_ends_at: '2026-11-01T00:00:00.000Z' },
    { status: 'canceled' }, { current_period_end: at }, { stripe_price_id: 'price_unrecognized' },
    { trial_converted_at: null }, { clerk_user_id: 'fixture_reassigned' },
  ])('does not admit unpaid/unconverted/changed billing: %j', async change => {
    await db.executor.updateTable('billing_subscriptions').set(change)
      .where('stripe_subscription_id', '=', targets[2].expectedSubscriptionId).execute();
    await unchanged(() => apply());
  });
  it('does not substitute an entitlement override for the exact active converted paid subscription', async () => {
    await db.executor.deleteFrom('billing_subscriptions').where('clerk_user_id', '=', targets[2].ownerId).execute();
    await db.executor.insertInto('billing_entitlement_overrides').values({ id: 'fixture_override',
      clerk_user_id: targets[2].ownerId, plan_slug: 'matrix_builder', status: 'active', max_runtime_slots: 1,
      included_runtime_slots: 1, addon_runtime_slots: 0, default_server_type: 'cpx22', allowed_server_types: '["cpx22"]',
      reason: 'fixture', created_by: 'fixture', created_at: at, expires_at: null, revoked_at: null }).execute();
    await unchanged(() => apply());
  });
  it.each([{ provisioning_class: 'preview' }, { runtime_slot: 'secondary' }, { activation_state: 'awaiting_billing' },
    { status: 'suspended' }, { clerk_user_id: 'fixture_reassigned' }, { runtime_token_epoch: 2 },
    { image_version: 'changed-db-version' }, { deleted_at: at }])('fails closed on changed machine %j', async change => {
    await db.executor.updateTable('user_machines').set(change).where('machine_id', '=', targets[2].machineId).execute();
    await unchanged(() => apply());
  });
  it('keeps deletion admission authoritative for every target', async () => {
    const deletion = new AccountDeletionRepository(db.kysely, { secret: env.ACCOUNT_DELETION_SECRET, now: () => new Date(at) });
    await deletion.accept({ clerkUserId: targets[2].ownerId, appleTokens: [] }, false);
    await unchanged(() => apply());
  });
  it.each(['MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED', 'MATRIX_FUNDED_AI_RUNTIME_ENABLED', 'ACCOUNT_DELETION_SECRET'] as const)
    ('refuses missing required %s rather than downgrade its admission', async field => {
      const disabled: NodeJS.ProcessEnv = { ...env }; delete disabled[field];
      recover = api.createPaidStarterRecovery({ db, env: disabled, sourceSha, now: () => new Date(at) });
      await unchanged(() => apply());
    });
  it.each(['lifetime', 'legacy', 'other-general', 'spent-general'] as const)
    ('defers any prior %s Chat grant, including fully consumed historical credit', async kind => {
      const target = targets[2]; const identity = { ownerId: target.ownerId, machineId: target.machineId, runtimeSlot: 'primary' };
      await repository().grantCredit({ identity, entryId: kind === 'lifetime' ? lifetimeId(target.ownerId)
        : kind === 'legacy' ? 'manual-main-chat-20261008-permanent-5usd:fixture' : 'fixture_general',
      kind: 'promotional_grant', amountMicrousd: 5_000_000, expiresAt: null,
      sourceReference: kind === 'legacy' ? 'user-authorized-main-chat-20261008-permanent-5usd'
        : kind === 'lifetime' ? 'matrix-ai-lifetime-starter' : 'fixture-other-general' });
      if (kind === 'spent-general') {
        await db.executor.updateTable('ai_funded_promotional_grant_balances').set({ remaining_microusd: 0 })
          .where('grant_entry_id', '=', 'fixture_general').execute();
        await db.executor.updateTable('ai_funded_runtime_balances').set({ credit_balance_microusd: 1_000_000,
          promotional_balance_microusd: 1_000_000, month_spent_microusd: 5_000_000 }).where('machine_id', '=', target.machineId).execute();
      }
      await unchanged(() => apply());
    });
  it('never refills after successful apply, even if all new general credit was spent', async () => {
    await apply();
    await db.executor.updateTable('ai_funded_promotional_grant_balances').set({ remaining_microusd: 0 })
      .where('grant_entry_id', 'like', 'starter-lifetime:%').execute();
    await db.executor.updateTable('ai_funded_runtime_balances').set({ credit_balance_microusd: 1_000_000,
      promotional_balance_microusd: 1_000_000, month_spent_microusd: 5_000_000 }).execute();
    await unchanged(() => apply());
  });
  it.each([{ enabled: false }, { enabled: true, expiresAt: at }, { enabled: true, allowedModelIds: ['anthropic/claude-opus-5'] }])
    ('preserves every existing policy without treating it as missing: %j', async policy => {
      await repository().setRuntimePolicy({ identity: { ownerId: targets[2].ownerId, machineId: targets[2].machineId, runtimeSlot: 'primary' },
        expectedRevision: 0, enabled: policy.enabled, monthlyBudgetMicrousd: 123, expiresAt: policy.expiresAt ?? null,
        allowedModelIds: policy.allowedModelIds ?? [model] });
      await unchanged(() => apply());
    });
  it.each([{ reserved_microusd: 1 }, { funding_shortfall_microusd: 1 }, { month_reserved_microusd: 1 }])
    ('does not add credit around a liability marker %j', async marker => {
      await db.executor.updateTable('ai_funded_runtime_balances').set(marker).where('machine_id', '=', targets[2].machineId).execute();
      await unchanged(() => apply());
    });
  it('defers financial freeze/debt without modifying its existing speech balance', async () => {
    const target = targets[2];
    await db.executor.insertInto('ai_funded_credit_restrictions').values({ owner_id: target.ownerId,
      machine_id: target.machineId, runtime_slot: 'primary', frozen: true, debt_microusd: 1, updated_at: at }).execute();
    await unchanged(() => apply());
  });
  it.each([{ addon_balance_microusd: 1 }, { credit_balance_microusd: 1_000_001 },
    { promotional_balance_microusd: 999_999 }])('rejects money without exact speech allocation backing: %j', async unexplained => {
    await db.executor.updateTable('ai_funded_runtime_balances').set(unexplained)
      .where('machine_id', '=', targets[2].machineId).execute();
    await unchanged(() => apply());
  });
  it('requires a new review when source state changes between dry-run and apply', async () => {
    const input = review(targets); const prepared = await recover(input);
    await db.executor.updateTable('billing_subscriptions').set({ updated_at: '2026-10-16T14:00:01.000Z' })
      .where('stripe_subscription_id', '=', targets[0].expectedSubscriptionId).execute();
    await unchanged(() => recover(input, { apply: true, reviewedFingerprint: prepared.fingerprint }));
  });
  it('rejects global model-policy changes after review rather than changing the approved entitlement', async () => {
    const input = review(targets); const prepared = await recover(input);
    await db.executor.updateTable('ai_funded_global_policy').set({ revision: 2, allowed_model_ids: '[]' }).execute();
    await unchanged(() => recover(input, { apply: true, reviewedFingerprint: prepared.fingerprint }));
  });

  describe('explicit attested disabled deletion namespace', () => {
    const authority = { servingRevision: 'matrix-platform-fixture-reviewed', imageDigest: `sha256:${'c'.repeat(64)}` };
    function configure() {
      const actualEnv: NodeJS.ProcessEnv = { ...env,
        MATRIX_PAID_STARTER_RECOVERY_PLATFORM_REVISION: authority.servingRevision,
        MATRIX_PAID_STARTER_RECOVERY_PLATFORM_IMAGE_DIGEST: authority.imageDigest };
      delete actualEnv.ACCOUNT_DELETION_SECRET;
      const input: Review = { ...review(targets), accountDeletionMode: 'disabled', disabledDeletionAuthority: { ...authority } };
      recover = api.createPaidStarterRecovery({ db, env: actualEnv, sourceSha, now: () => new Date(at) });
      return { input, actualEnv };
    }
    it.each([undefined, 'false'])('admits the exact paid cohort with explicit authority and scheduling flag %s', async scheduling => {
      const { input, actualEnv } = configure();
      if (scheduling !== undefined) actualEnv.ACCOUNT_DELETION_ENABLED = scheduling;
      const before = await financialSnapshot(db);
      expect(await recover(input)).toMatchObject({ mode: 'dry-run', targetCount: 3, grantedMicrousd: 0 });
      expect(await financialSnapshot(db)).toEqual(before);
      expect(await apply(input)).toMatchObject({ mode: 'applied', targetCount: 3, grantedMicrousd: 15_000_000 });
      const after = await financialSnapshot(db);
      expect(after.ledger.filter(row => row.source_reference === 'matrix-ai-lifetime-starter')).toHaveLength(3);
      expect(after.grants.filter(row => row.grant_entry_id.startsWith('speech-monthly:'))).toEqual(before.grants);
      expect(after.speechAllowances).toEqual(before.speechAllowances);
      expect(after.balances.map(row => Number(row.credit_balance_microusd))).toEqual([6_000_000, 6_000_000, 6_000_000]);
    });
    it.each(['true', 'unknown', ''])('rejects present/non-disabled scheduling flag %j', async scheduling => {
      const { input, actualEnv } = configure(); actualEnv.ACCOUNT_DELETION_ENABLED = scheduling;
      await unchanged(() => apply(input));
    });
    it.each(['missing-review-authority', 'missing-operator-revision', 'missing-operator-image',
      'wrong-operator-revision', 'wrong-operator-image', 'mutable-image-tag', 'extra-authority-field'] as const)
      ('defers %s with no financial changes', async invalid => {
        const { input, actualEnv } = configure();
        if (invalid === 'missing-review-authority') delete input.disabledDeletionAuthority;
        if (invalid === 'missing-operator-revision') delete actualEnv.MATRIX_PAID_STARTER_RECOVERY_PLATFORM_REVISION;
        if (invalid === 'missing-operator-image') delete actualEnv.MATRIX_PAID_STARTER_RECOVERY_PLATFORM_IMAGE_DIGEST;
        if (invalid === 'wrong-operator-revision') actualEnv.MATRIX_PAID_STARTER_RECOVERY_PLATFORM_REVISION = 'matrix-platform-fixture-other';
        if (invalid === 'wrong-operator-image') actualEnv.MATRIX_PAID_STARTER_RECOVERY_PLATFORM_IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
        if (invalid === 'mutable-image-tag') input.disabledDeletionAuthority!.imageDigest = 'registry.invalid/platform:latest';
        if (invalid === 'extra-authority-field') Object.assign(input.disabledDeletionAuthority!, { allowPending: true });
        await unchanged(() => apply(input));
      });
    it.each(['', 'short-invalid', env.ACCOUNT_DELETION_SECRET])
      ('requires secret absence rather than any present value: %s', async secret => {
        const { input, actualEnv } = configure(); actualEnv.ACCOUNT_DELETION_SECRET = secret;
        await unchanged(() => apply(input));
      });
    it.each(['scheduled', 'cancelled', 'completed'] as const)
      ('defers any global %s deletion job even for an unrelated owner', async status => {
        const { input } = configure();
        const deletion = new AccountDeletionRepository(db.kysely, { secret: env.ACCOUNT_DELETION_SECRET, now: () => new Date(at) });
        await deletion.accept({ clerkUserId: 'fixture_outside_reviewed_cohort', appleTokens: [] }, false);
        await db.executor.updateTable('account_deletion_jobs').set({ status }).execute();
        await unchanged(() => apply(input));
      });
    it('requires new inspection if a deletion job appears between dry-run and apply', async () => {
      const { input } = configure(); const prepared = await recover(input);
      const deletion = new AccountDeletionRepository(db.kysely, { secret: env.ACCOUNT_DELETION_SECRET, now: () => new Date(at) });
      await deletion.accept({ clerkUserId: 'fixture_outside_reviewed_cohort', appleTokens: [] }, false);
      await unchanged(() => recover(input, { apply: true, reviewedFingerprint: prepared.fingerprint }));
    });
    it('rejects disabled authority attached to the enabled branch', async () => {
      const input = { ...review(targets), disabledDeletionAuthority: { ...authority } };
      await unchanged(() => apply(input));
    });
  });
});
