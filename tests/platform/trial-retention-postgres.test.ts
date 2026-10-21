import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlatformDb, insertUserMachine, upsertBillingCustomer, upsertBillingSubscription,
  upsertBillingOverride, projectTrialInvoiceEvent, claimCheckoutAttempt, type PlatformDB } from '../../packages/platform/src/db.js';
import { withAccountDeletionOwnerLock } from '../../packages/platform/src/account-deletion/admission.js';
import { prepareExpiredTrialCleanup } from '../../packages/platform/src/trial-retention.js';

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const ownerId = 'user_retention_race'; const machineId = '532787d0-09d3-44c7-aa01-10d8b83e95ff';
const sourceSha = 'a'.repeat(40); const at = '2026-10-01T00:00:00.000Z';
const now = () => new Date('2026-10-18T00:00:00.000Z');
const review = { version: 1, sourceSha, authorizationReference: 'review:concurrency',
  issuedAt: '2026-10-17T23:59:00.000Z', expiresAt: '2026-10-18T00:04:00.000Z', targets: [{
    ownerId, machineId, serverId: 12345, subscriptionId: 'sub_trial',
    noticeGivenAt: '2026-10-09T00:00:00.000Z', noticeReference: 'support:notice',
  }] };
const subscription = { clerkUserId: ownerId, stripeSubscriptionId: 'sub_trial', stripeCustomerId: 'cus_trial',
  runtimeSlot: 'primary', planSlug: 'matrix_starter' as const, stripePriceId: 'price_trial', billingInterval: 'monthly' as const,
  status: 'canceled' as const, currentPeriodEnd: at, gracePeriodEndsAt: null, trialStartedAt: '2026-09-24T00:00:00.000Z',
  trialEndsAt: at, trialConvertedAt: null, latestEventCreatedAt: at, latestEventId: 'evt_canceled', updatedAt: at };
const invoice = { stripeSubscriptionId: 'sub_trial', type: 'invoice.paid' as const, eventId: 'evt_paid',
  eventCreatedAt: '2026-10-02T00:00:00.000Z', lifecycleAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

describe.skipIf(!connectionString)('trial retention concurrency on PostgreSQL', () => {
  let db: PlatformDB; let admin: Kysely<unknown>; let schema: string;
  beforeEach(async () => {
    vi.stubEnv('ACCOUNT_DELETION_SECRET', undefined);
    schema = `retention_race_${randomUUID().replaceAll('-', '')}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = createPlatformDb({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 4,
      application_name: schema, options: `-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=3000` }) }) });
    await db.ready;
    await insertUserMachine(db, { machineId, clerkUserId: ownerId, handle: 'retention-race', runtimeSlot: 'primary',
      provisioningClass: 'customer', hetznerServerId: 12345, status: 'suspended', provisionedAt: '2026-09-24T00:00:00.000Z' });
    await upsertBillingCustomer(db, { clerkUserId: ownerId, stripeCustomerId: 'cus_trial', createdAt: at, updatedAt: at });
    await upsertBillingSubscription(db, subscription);
  });
  afterEach(async () => {
    vi.unstubAllEnvs(); await db?.destroy();
    if (admin) { await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); }
  });
  const prepare = (verifyProvider: () => Promise<void>, mode = {}) => prepareExpiredTrialCleanup({ db, now, sourceSha, verifyProvider,
    env: { MATRIX_TRIAL_RETENTION_DEPLOYED_SOURCE_SHA: sourceSha } }, review, mode);
  async function waitForAdvisoryWaiter() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=${schema}
      ) AS waiting`.execute(admin);
      if (result.rows[0]?.waiting) return true;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return false;
  }

  it.each([
    { name: 'new subscription', write: (db: PlatformDB) => upsertBillingSubscription(db, { ...subscription,
      stripeSubscriptionId: 'sub_new', status: 'active' }) },
    { name: 'invoice recovery', write: (db: PlatformDB) => projectTrialInvoiceEvent(db, invoice) },
    { name: 'internal override', write: (db: PlatformDB) => upsertBillingOverride(db, { id: 'override', clerkUserId: ownerId,
      planSlug: 'internal', status: 'active', maxRuntimeSlots: 1, includedRuntimeSlots: 1, addonRuntimeSlots: 0,
      defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'], reason: 'support', createdBy: 'operator',
      expiresAt: null, revokedAt: null, createdAt: at }) },
    { name: 'new purchase', write: (db: PlatformDB) => claimCheckoutAttempt(db, { id: 'checkout_new', clerkUserId: ownerId,
      runtimeSlot: 'primary', planSlug: 'matrix_starter', billingInterval: 'monthly', regionSlug: 'region_fsn1', createdAt: at }) },
  ])('serializes $name against cleanup even when account deletion is disabled', async ({ write }) => {
    const began = gate(); const release = gate();
    const cleanup = prepare(async () => { began.release(); await release.promise; });
    await began.promise;
    const writer = write(db);
    try { expect(await waitForAdvisoryWaiter()).toBe(true); }
    finally { release.release(); }
    await Promise.all([cleanup, writer]);
    expect(await db.executor.selectFrom('provider_deletion_queue').selectAll().execute()).toEqual([]);
  });

  it('reads committed payment recovery after waiting and refuses the stale deletion review', async () => {
    const dryRun = await prepare(async () => {}); const began = gate(); const release = gate();
    const payment = withAccountDeletionOwnerLock(db, ownerId, async trx => {
      began.release(); await release.promise; await projectTrialInvoiceEvent(trx, invoice);
    });
    await began.promise;
    const cleanup = prepare(async () => {}, { apply: true, reviewedFingerprint: dryRun.fingerprint });
    const rejected = expect(cleanup).rejects.toThrow(/refused/);
    try { expect(await waitForAdvisoryWaiter()).toBe(true); }
    finally { release.release(); }
    await payment; await rejected;
    expect(await db.executor.selectFrom('user_machines').select(['status', 'deleted_at']).executeTakeFirst())
      .toEqual({ status: 'suspended', deleted_at: null });
    expect(await db.executor.selectFrom('provider_deletion_queue').selectAll().execute()).toEqual([]);
  });
});
