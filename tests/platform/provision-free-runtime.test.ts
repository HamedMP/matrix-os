import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppSessionRoutes } from '../../packages/platform/src/app-session-routes.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import type { CustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import {
  getBillingEntitlement,
  insertUserMachine,
  upsertBillingEntitlement,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import type { FreeTierConfig } from '../../packages/platform/src/free-tier/config.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { addFreeTierInvite, getFreeTierInvite } from '../../packages/platform/src/free-tier/invites.js';
import {
  createFreeRuntimeProvisioner,
  createFreeTierRuntime,
} from '../../packages/platform/src/free-tier/provision-free-runtime.js';
import { createContainerOwnerDatabases, type OwnerClusterAdmin } from '../../packages/platform/src/substrates/container-owner-database.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { hashAccountDeletionOwner } from '../../packages/platform/src/account-deletion/repository.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

const OWNER = 'user_freeowner';
const NOW = new Date('2026-11-11T10:00:00.000Z');

/** Owner-cluster admin that accepts every statement; the platform-side records are real. */
function acceptingAdmin(statements: string[] = []): OwnerClusterAdmin {
  return {
    async query(statement) { statements.push(statement); return []; },
    async executeInDatabase() {},
  };
}

function ownerDatabasesFor(db: PlatformDB, admin: OwnerClusterAdmin = acceptingAdmin()) {
  return createContainerOwnerDatabases({ db, admin, passwordSecret: 's'.repeat(40), sizeLimitBytes: 1024 ** 3 });
}

function routesFor(db: PlatformDB, options: {
  config?: FreeTierConfig;
  provisioner?: ReturnType<typeof createFreeRuntimeProvisioner> | null;
  customerVpsService?: CustomerVpsService;
  stripeBilling?: boolean;
  ownerDatabases?: ReturnType<typeof ownerDatabasesFor>;
} = {}) {
  const config = options.config ?? { maxRuntimes: 10, inviteRequired: true };
  const provisioner = options.provisioner === null ? undefined : options.provisioner
    ?? createFreeRuntimeProvisioner({ db, config, ownerDatabases: options.ownerDatabases ?? ownerDatabasesFor(db), env: {}, now: () => NOW });
  const ensureProvisionedPlatformUser = vi.fn(async () => {});
  const routes = createAppSessionRoutes({
    db,
    clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
    customerVpsService: options.customerVpsService,
    appEnv: {},
    platformJwtSecret: 'j'.repeat(32),
    legacyContainerRoutingEnabled: false,
    logRouteError: () => {},
    applyNoStoreHeaders: (c) => { c.header('Cache-Control', 'no-store'); },
    jsonCustomerVpsError: (c, err) => err instanceof CustomerVpsError && err.status === 402
      ? c.json({ error: 'Billing upgrade required', code: 'billing_required' }, 402)
      : c.json({ error: 'Provisioning failed', code: 'provisioning_failed' }, 503),
    stripeBillingEntitlementsEnabled: () => options.stripeBilling ?? false,
    resolveEffectiveBillingEntitlement: async () => null,
    selectProvisionIdentityForClerkUser: async (_db, userId) => ({ handle: userId.replace('user_', ''), displayName: 'Owner' }),
    ensureProvisionedPlatformUser,
    resolveAppDomainIdentity: async () => null,
    getGatewayUrlForHandle: (handle) => `https://${handle}.invalid`,
    freeRuntimeProvisioner: provisioner,
  });
  return { routes, ensureProvisionedPlatformUser };
}

function request(routes: ReturnType<typeof routesFor>['routes'], body: unknown, user = OWNER) {
  return routes.request('/api/auth/provision-runtime', {
    method: 'POST',
    headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function containerRows(db: PlatformDB, clerkUserId?: string) {
  return db.executor.selectFrom('user_machines').selectAll()
    .where('substrate', '=', 'container')
    .$if(Boolean(clerkUserId), (query) => query.where('clerk_user_id', '=', clerkUserId!))
    .execute();
}

const FREE = { planSlug: 'matrix_free' };
const EARLIER = '2026-10-01T00:00:00.000Z';
const LATER = '2026-12-01T00:00:00.000Z';

function endedPaid() {
  return {
    ...buildFreeEntitlement(OWNER, new Date(EARLIER)), source: 'stripe' as const, planSlug: 'matrix_starter' as const,
    status: 'canceled' as const, stripeSubscriptionId: 'sub_old', allowedServerTypes: ['cpx22'], defaultServerType: 'cpx22',
  };
}

function fakeVpsService(provision: CustomerVpsService['provision'] = vi.fn<CustomerVpsService['provision']>()) {
  const partial: Partial<CustomerVpsService> = { provision };
  return { service: partial as CustomerVpsService, provision };
}

describe('POST /api/auth/provision-runtime for the free plan', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('creates a stopped container runtime, its owner database, and a free entitlement for an invited owner', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const { service: customerVpsService, provision } = fakeVpsService();
    const { routes, ensureProvisionedPlatformUser } = routesFor(db, { customerVpsService, stripeBilling: true });

    const response = await request(routes, FREE);

    expect(response.status).toBe(202);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ runtime: 'container', clerkUserId: OWNER, handle: 'freeowner', runtimeSlot: 'primary', status: 'stopped' });
    const [row, ...others] = await containerRows(db, OWNER);
    expect(others).toHaveLength(0);
    expect(row).toMatchObject({
      machine_id: body.machineId, provisioning_class: 'free', status: 'stopped', generation: 1,
      substrate_ref: null, private_address: null, started_at: null, hetzner_server_id: null,
    });
    const ownerDb = await db.executor.selectFrom('container_owner_databases').selectAll()
      .where('clerk_user_id', '=', OWNER).executeTakeFirst();
    expect(ownerDb).toMatchObject({ state: 'active', password_epoch: 1 });
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeInstanceOf(Date);
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'free', planSlug: 'matrix_free', maxRuntimeSlots: 1 });
    expect(provision).not.toHaveBeenCalled();
    expect(ensureProvisionedPlatformUser).toHaveBeenCalledWith(db, expect.objectContaining({
      clerkUserId: OWNER, handle: 'freeowner', runtimeId: `container:${String(body.machineId)}`,
    }));
  });

  it('returns the same runtime on repeat without consuming anything again', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const statements: string[] = [];
    const { routes } = routesFor(db, { ownerDatabases: ownerDatabasesFor(db, acceptingAdmin(statements)) });
    const first = await (await request(routes, FREE)).json() as { machineId: string };
    const issued = statements.length;
    const second = await request(routes, FREE);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ machineId: first.machineId });
    expect(await containerRows(db, OWNER)).toHaveLength(1);
    expect(statements).toHaveLength(issued);
  });

  it('puts an uninvited owner on the waitlist and creates nothing', async () => {
    const { routes } = routesFor(db);
    const response = await request(routes, FREE);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Free plan is invite only', code: 'waitlisted' });
    expect(await containerRows(db)).toHaveLength(0);
    expect(await db.executor.selectFrom('container_owner_databases').selectAll().execute()).toHaveLength(0);
    expect(await getBillingEntitlement(db, OWNER)).toBeUndefined();
  });

  it('waitlists an owner whose single invite was already used', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await db.executor.updateTable('free_tier_invites').set({ consumed_at: NOW }).execute();
    const response = await request(routesFor(db).routes, FREE);
    expect(response.status).toBe(403);
    expect(await containerRows(db)).toHaveLength(0);
  });

  it('admits without an invite when signup is open', async () => {
    const { routes } = routesFor(db, { config: { maxRuntimes: 10, inviteRequired: false } });
    expect((await request(routes, FREE)).status).toBe(202);
  });

  it('answers busy at the capacity ceiling, leaves the invite unconsumed, and leaves no runtime', async () => {
    const base = { imageVersion: null, provisionedAt: NOW.toISOString(), activationState: 'authorized' as const, status: 'stopped', substrate: 'container' as const };
    await insertUserMachine(db, { ...base, machineId: 'm-a', clerkUserId: 'user_a', handle: 'a' });
    await insertUserMachine(db, { ...base, machineId: 'm-b', clerkUserId: 'user_b', handle: 'b' });
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    const response = await request(routesFor(db, { config: { maxRuntimes: 2, inviteRequired: true } }).routes, FREE);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({ error: 'Free capacity is full', code: 'busy' });
    expect(await containerRows(db, OWNER)).toHaveLength(0);
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
  });

  it('refuses an owner who already has a VPS runtime in the slot', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await insertUserMachine(db, {
      machineId: 'vps-1', clerkUserId: OWNER, handle: 'freeowner', status: 'running', imageVersion: 'v1',
      provisionedAt: NOW.toISOString(), activationState: 'authorized',
    });
    const response = await request(routesFor(db).routes, FREE);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'runtime_exists' });
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
  });

  it.each([
    { name: 'active', changes: { status: 'active' as const } },
    { name: 'trialing', changes: { status: 'trialing' as const } },
    { name: 'past due', changes: { status: 'past_due' as const } },
    { name: 'unpaid', changes: { status: 'unpaid' as const } },
    { name: 'incomplete', changes: { status: 'incomplete' as const } },
    { name: 'canceled within its grace period', changes: { gracePeriodEndsAt: LATER } },
    { name: 'canceled before its effective end', changes: { effectiveUntil: LATER } },
  ])('refuses a paid owner whose entitlement is $name and leaves it untouched', async ({ changes }) => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, { ...endedPaid(), ...changes });
    const response = await request(routesFor(db).routes, FREE);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'free_plan_unavailable' });
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe', stripeSubscriptionId: 'sub_old' });
    expect(await containerRows(db, OWNER)).toHaveLength(0);
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeNull();
  });

  it.each([
    { name: 'canceled', changes: {} },
    { name: 'ended', changes: { status: 'ended' as const } },
    { name: 'canceled after its grace period', changes: { gracePeriodEndsAt: EARLIER } },
    { name: 'canceled past its effective end', changes: { effectiveUntil: EARLIER } },
  ])('lets a former paid owner whose entitlement is $name take the free plan', async ({ changes }) => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, { ...endedPaid(), ...changes });
    const response = await request(routesFor(db).routes, FREE);
    expect(response.status).toBe(202);
    expect(await containerRows(db, OWNER)).toHaveLength(1);
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({
      source: 'free', planSlug: 'matrix_free', status: 'active', stripeSubscriptionId: null,
    });
  });

  it('refuses a former paid owner while another subscription or an override is still live', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, endedPaid());
    await db.executor.insertInto('billing_subscriptions').values({
      stripe_subscription_id: 'sub_extra', stripe_customer_id: 'cus_1', clerk_user_id: OWNER, runtime_slot: 'extra',
      plan_slug: 'matrix_starter', stripe_price_id: 'price_1', billing_interval: 'monthly', price_unit_amount_minor: null,
      price_currency: null, price_interval_count: null, price_quantity: null, status: 'past_due', current_period_end: null,
      grace_period_ends_at: null, trial_started_at: null, trial_ends_at: null, trial_converted_at: null,
      first_trial_payment_failed_at: null, latest_event_created_at: EARLIER, latest_event_id: 'evt_1',
      latest_invoice_event_created_at: null, latest_invoice_event_id: null, updated_at: EARLIER,
    }).execute();
    expect((await request(routesFor(db).routes, FREE)).status).toBe(409);

    await db.executor.updateTable('billing_subscriptions').set({ status: 'canceled', grace_period_ends_at: LATER }).execute();
    expect((await request(routesFor(db).routes, FREE)).status).toBe(409);

    await db.executor.deleteFrom('billing_subscriptions').execute();
    await db.executor.insertInto('billing_entitlement_overrides').values({ id: 'override_1', clerk_user_id: OWNER,
      plan_slug: 'internal', status: 'active', max_runtime_slots: 1, included_runtime_slots: 1, addon_runtime_slots: 0,
      default_server_type: 'cpx22', allowed_server_types: '["cpx22"]', reason: 'support', created_by: 'operator',
      expires_at: null, revoked_at: null, created_at: EARLIER }).execute();
    expect((await request(routesFor(db).routes, FREE)).status).toBe(409);
    expect(await containerRows(db, OWNER)).toHaveLength(0);
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe' });
  });

  it('refuses a former paid owner who still has a live VPS in any slot', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, endedPaid());
    await insertUserMachine(db, {
      machineId: 'vps-extra', clerkUserId: OWNER, handle: 'freeowner-extra', runtimeSlot: 'extra', status: 'stopped',
      imageVersion: 'v1', provisionedAt: NOW.toISOString(), activationState: 'authorized',
    });
    const response = await request(routesFor(db).routes, FREE);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'runtime_exists' });
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe' });

    await db.executor.updateTable('user_machines').set({ deleted_at: EARLIER, status: 'deleted' }).execute();
    expect((await request(routesFor(db).routes, FREE)).status).toBe(202);
  });

  it('lets a later Stripe reactivation replace the free entitlement even if its clock reads earlier', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await upsertBillingEntitlement(db, endedPaid());
    const reactivation = { ...endedPaid(), status: 'active' as const, effectiveFrom: NOW.toISOString(), updatedAt: NOW.toISOString() };
    const provisioner = createFreeRuntimeProvisioner({
      db, config: { maxRuntimes: 10, inviteRequired: true }, ownerDatabases: ownerDatabasesFor(db), env: {},
      now: () => new Date(NOW.getTime() + 1_000),
    });
    expect((await provisioner.provision({ clerkUserId: OWNER, handle: 'freeowner' })).kind).toBe('created');
    await upsertBillingEntitlement(db, reactivation);
    expect(await getBillingEntitlement(db, OWNER)).toMatchObject({ source: 'stripe', status: 'active' });
  });

  it('keeps the runtime when owner database setup fails and finishes it on retry', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    let failing = true;
    const admin: OwnerClusterAdmin = {
      async query() { if (failing) throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), { code: 'ECONNREFUSED' }); return []; },
      async executeInDatabase() {},
    };
    const { routes } = routesFor(db, { ownerDatabases: ownerDatabasesFor(db, admin) });
    const failed = await request(routes, FREE);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('retry-after')).toBe('30');
    const text = await failed.text();
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('10.0.0.9');
    expect(await containerRows(db, OWNER)).toHaveLength(1);
    failing = false;
    const retried = await request(routes, FREE);
    expect(retried.status).toBe(202);
    expect(await containerRows(db, OWNER)).toHaveLength(1);
  });

  it('removes the owner database it created when account deletion began during signup', async () => {
    const env = { ACCOUNT_DELETION_SECRET: 'd'.repeat(40) };
    const owners = ownerDatabasesFor(db);
    const remove = vi.spyOn(owners, 'remove');
    const ensure = owners.ensure.bind(owners);
    // Deletion is accepted (and its runtime cleanup runs) while signup creates the database.
    vi.spyOn(owners, 'ensure').mockImplementation(async (...args) => {
      await db.executor.insertInto('account_deletion_jobs').values({
        owner_hash: hashAccountDeletionOwner(OWNER, env.ACCOUNT_DELETION_SECRET), status: 'processing',
        due_at: NOW.toISOString(), next_attempt_at: NOW.toISOString(), created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      } as never).execute();
      return ensure(...args);
    });
    const provisioner = createFreeRuntimeProvisioner({
      db, config: { maxRuntimes: 10, inviteRequired: false }, ownerDatabases: owners, env, now: () => NOW,
    });
    expect(await provisioner.provision({ clerkUserId: OWNER, handle: 'freeowner' })).toEqual({ kind: 'deletion_pending' });
    expect(remove).toHaveBeenCalledWith(OWNER, expect.any(AbortSignal));
    const live = await db.executor.selectFrom('container_owner_databases').select('clerk_user_id')
      .where('deleted_at', 'is', null).execute();
    expect(live).toEqual([]);
  });

  it('rejects free requests that select a region, machine, tools, or another slot', async () => {
    const { routes } = routesFor(db);
    for (const body of [
      { ...FREE, regionSlug: 'region_fsn1' }, { ...FREE, serverType: 'cpx22' }, { ...FREE, location: 'fsn1' },
      { ...FREE, developerTools: ['codex'] }, { ...FREE, runtime: 'studio' },
    ]) {
      const response = await request(routes, body);
      expect(response.status).toBe(400);
    }
    expect(await containerRows(db)).toHaveLength(0);
  });

  it('requires a verified session', async () => {
    const { routes } = routesFor(db);
    const response = await routes.request('/api/auth/provision-runtime', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(FREE),
    });
    expect(response.status).toBe(401);
    expect(await containerRows(db)).toHaveLength(0);
  });

  it('is unavailable when the free tier is not configured, while paid provisioning is untouched', async () => {
    const { service: customerVpsService, provision } = fakeVpsService(vi.fn<CustomerVpsService['provision']>(
      async () => ({ machineId: 'vps-new', status: 'provisioning', etaSeconds: 90 })));
    const { routes } = routesFor(db, { provisioner: null, customerVpsService });
    const free = await request(routes, FREE);
    expect(free.status).toBe(503);
    expect(await free.json()).toMatchObject({ code: 'free_tier_unavailable' });
    const paid = await request(routes, { planSlug: 'matrix_starter', regionSlug: 'region_fsn1' });
    expect(paid.status).toBe(202);
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'freeowner', clerkUserId: OWNER, runtimeSlot: 'primary', serverType: 'cpx22', location: 'fsn1' }),
      { dispatch: 'detached' },
    );
    expect(await containerRows(db)).toHaveLength(0);
  });

  it('keeps the paid billing gate for paid plans even when the free tier is configured', async () => {
    const { service: customerVpsService, provision } = fakeVpsService();
    const { routes } = routesFor(db, { customerVpsService, stripeBilling: true });
    const response = await request(routes, { planSlug: 'matrix_starter', regionSlug: 'region_fsn1' });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: 'billing_required' });
    expect(provision).not.toHaveBeenCalled();
  });

  it('answers paid requests as unavailable when only the free tier is configured', async () => {
    const { routes } = routesFor(db);
    const response = await request(routes, { planSlug: 'matrix_starter', regionSlug: 'region_fsn1' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Provisioning unavailable', code: 'provisioning_unavailable' });
  });

  it('leaves free signup unavailable when the container substrate is not configured', () => {
    const log = vi.fn();
    const config = { maxRuntimes: 1, inviteRequired: true };
    expect(createFreeTierRuntime({ db, config, ownerDatabases: undefined, log })).toEqual({ config });
    expect(log).toHaveBeenCalledOnce();
    expect(createFreeTierRuntime({ db, config: undefined, ownerDatabases: undefined, log })).toBeUndefined();
    expect(createFreeTierRuntime({ db, config, ownerDatabases: ownerDatabasesFor(db) })?.provisioner).toBeDefined();
  });
});

describe.skipIf(!freeTierPostgresUrl)('free runtime provisioning races against real Postgres', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_provision', 2); });
  afterAll(async () => { await scoped?.close(); });
  beforeEach(async () => {
    const [a] = scoped.pools as [PlatformDB];
    for (const table of ['user_machines', 'free_tier_invites', 'container_owner_databases', 'billing_entitlements'] as const) {
      await a.executor.deleteFrom(table).execute();
    }
  });

  const routesOn = (db: PlatformDB, config: FreeTierConfig) => routesFor(db, { config }).routes;

  it('creates exactly one runtime from twenty concurrent requests across two platform instances', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    await addFreeTierInvite(a, { clerkUserId: OWNER, invitedBy: 'ops' });
    const config = { maxRuntimes: 10, inviteRequired: true };
    const apps = [routesOn(a, config), routesOn(b, config)];
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => request(apps[index % 2]!, FREE)));
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(202));
    const machineIds = new Set(await Promise.all(responses.map(async (response) => (await response.json() as { machineId: string }).machineId)));
    expect(machineIds.size).toBe(1);
    expect(await containerRows(a, OWNER)).toHaveLength(1);
    expect(await a.executor.selectFrom('container_owner_databases').selectAll().execute()).toHaveLength(1);
  });

  it('keeps the paid entitlement when a Stripe reactivation races a former paid owner taking the free plan', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    for (let round = 0; round < 5; round += 1) {
      for (const table of ['user_machines', 'free_tier_invites', 'container_owner_databases', 'billing_entitlements'] as const) {
        await a.executor.deleteFrom(table).execute();
      }
      await addFreeTierInvite(a, { clerkUserId: OWNER, invitedBy: 'ops' });
      await upsertBillingEntitlement(a, endedPaid());
      const reactivatedAt = new Date().toISOString();
      const [response] = await Promise.all([
        request(routesOn(a, { maxRuntimes: 10, inviteRequired: true }), FREE),
        upsertBillingEntitlement(b, { ...endedPaid(), status: 'active', effectiveFrom: reactivatedAt, updatedAt: reactivatedAt }),
      ]);
      expect([202, 409]).toContain(response.status);
      expect(await getBillingEntitlement(a, OWNER)).toMatchObject({ source: 'stripe', status: 'active' });
      expect(await containerRows(a, OWNER)).toHaveLength(response.status === 202 ? 1 : 0);
    }
  });

  it('never exceeds the capacity ceiling when different owners race', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    const owners = Array.from({ length: 10 }, (_, index) => `user_racer${index}`);
    for (const owner of owners) await addFreeTierInvite(a, { clerkUserId: owner, invitedBy: 'ops' });
    const config = { maxRuntimes: 3, inviteRequired: true };
    const apps = [routesOn(a, config), routesOn(b, config)];
    const responses = await Promise.all(owners.map((owner, index) => request(apps[index % 2]!, FREE, owner)));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([...Array(3).fill(202), ...Array(7).fill(503)]);
    expect(await containerRows(a)).toHaveLength(3);
    const consumed = await a.executor.selectFrom('free_tier_invites').select('clerk_user_id')
      .where('consumed_at', 'is not', null).execute();
    expect(consumed).toHaveLength(3);
  });
});
