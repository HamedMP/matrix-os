import type Dockerode from 'dockerode';
import { resolveContainerEndpoint } from '../../packages/platform/src/container-endpoint.js';
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapDevstackIdentity, type DevstackBootstrapInput } from '../../packages/platform/src/devstack-bootstrap.js';
import { createPlatformDb, getContainer, getPlatformUserByClerkId, type PlatformDB } from '../../packages/platform/src/db.js';

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;

// Optional in unit-only runs; the existing required PostgreSQL runner supplies
// the URL and rejects skipped/missing assertions for every assigned suite.
describe.skipIf(!connectionString)('DevStack identity initialization on PostgreSQL', () => {
  let admin: Kysely<Record<string, never>>;
  let db: PlatformDB;
  let other: PlatformDB;
  let schema: string;
  const input = (overrides: Partial<DevstackBootstrapInput> = {}): DevstackBootstrapInput => ({
    instance: 'demo-a', clerkUserId: 'user_devstack_fixture', handle: 'devstack-fixture',
    email: 'devstack@example.com', displayName: 'DevStack fixture',
    containerId: 'a'.repeat(64), gatewayPort: 4000, shellPort: 3000,
    ...overrides,
  });

  beforeEach(async () => {
    if (!connectionString) throw new Error('MATRIX_TEST_POSTGRES_URL is required for DevStack PostgreSQL qualification');
    const url = new URL(connectionString);
    if (!['127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/[A-Za-z0-9_]+_test$/.test(url.pathname) || url.search || url.hash) {
      throw new Error('Disposable literal-loopback PostgreSQL test database required');
    }
    schema = `devstack_bootstrap_${randomUUID().replaceAll('-', '')}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    const connect = () => createPlatformDb({ dialect: new PostgresDialect({ pool: new Pool({
      connectionString, max: 4, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`,
    }) }) });
    db = connect(); await db.ready;
    other = connect(); await other.ready;
  });

  afterEach(async () => {
    try { await Promise.all([db?.destroy(), other?.destroy()]); }
    finally {
      try { if (schema && admin) await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); }
      finally { await admin?.destroy(); }
    }
  });

  it('creates one real local user and runtime route without paid or VPS state', async () => {
    const receipt = await bootstrapDevstackIdentity(db, input());
    const account = await getPlatformUserByClerkId(other, input().clerkUserId);
    expect(account).toMatchObject({ id: receipt.userId, clerkId: input().clerkUserId,
      handle: input().handle, email: input().email, plan: 'free', status: 'active',
      containerId: `devstack:demo-a:${input().clerkUserId}`, pipedreamExternalId: null });
    expect(receipt.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getContainer(other, input().handle)).toMatchObject({
      clerkUserId: input().clerkUserId, containerId: input().containerId,
      port: 4000, shellPort: 3000, status: 'running',
    });
    expect((await other.executor.selectFrom('user_machines').selectAll().execute())).toEqual([]);
    expect((await other.executor.selectFrom('billing_entitlement_overrides').selectAll().execute())).toEqual([]);
  });

  it('keeps one identity across reruns and independent concurrent initializers', async () => {
    const receipts = await Promise.all([
      bootstrapDevstackIdentity(db, input()), bootstrapDevstackIdentity(other, input()),
    ]);
    expect(receipts[0].userId).toBe(receipts[1].userId);
    await other.executor.updateTable('users').set({ pipedream_external_id: receipts[0].userId })
      .where('id', '=', receipts[0].userId).execute();
    expect(await bootstrapDevstackIdentity(db, input())).toMatchObject({
      userId: receipts[0].userId, pipedreamExternalId: receipts[0].userId,
    });
    expect(await db.executor.selectFrom('users').select('id').execute()).toHaveLength(1);
    expect(await db.executor.selectFrom('containers').select('handle').execute()).toHaveLength(1);
  });

  it.each([
    { instance: 'another' }, { handle: 'another-handle' }, { containerId: 'b'.repeat(64) },
    { gatewayPort: 4999 }, { shellPort: 3999 },
  ])('refuses to repoint retained identity or routing: %j', async (override) => {
    const original = await bootstrapDevstackIdentity(db, input());
    await expect(bootstrapDevstackIdentity(other, input(override))).rejects.toThrow(/owned|ownership|registration/i);
    expect(await getPlatformUserByClerkId(db, input().clerkUserId)).toMatchObject({ id: original.userId,
      containerId: `devstack:demo-a:${input().clerkUserId}`, handle: input().handle });
    expect(await getContainer(db, input().handle)).toMatchObject({ containerId: input().containerId, port: 4000, shellPort: 3000 });
  });

  it('rolls back runtime registration when the real user projection fails', async () => {
    await sql`CREATE FUNCTION reject_devstack_user() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fixture rejected user projection'; END;
    $$ LANGUAGE plpgsql`.execute(db.executor);
    await sql`CREATE TRIGGER reject_devstack_user BEFORE INSERT ON users
      FOR EACH ROW EXECUTE FUNCTION reject_devstack_user()`.execute(db.executor);
    await expect(bootstrapDevstackIdentity(db, input())).rejects.toThrow('fixture rejected user projection');
    expect(await db.executor.selectFrom('users').select('id').execute()).toEqual([]);
    expect(await db.executor.selectFrom('containers').select('handle').execute()).toEqual([]);
  });

  it('does not adopt a user projected by another environment', async () => {
    await bootstrapDevstackIdentity(db, input());
    await other.executor.updateTable('users').set({ container_id: 'clerk:foreign' })
      .where('clerk_id', '=', input().clerkUserId).execute();
    await expect(bootstrapDevstackIdentity(db, input())).rejects.toThrow(/owned|ownership/i);
    expect(await getPlatformUserByClerkId(db, input().clerkUserId)).toMatchObject({ containerId: 'clerk:foreign' });
  });

  it('cannot give a different Clerk owner and handle an occupied execution target', async () => {
    await bootstrapDevstackIdentity(db, input());
    await expect(bootstrapDevstackIdentity(other, input({ clerkUserId: 'user_other', handle: 'another' })))
      .rejects.toThrow(/target.*owned/i);
    expect(await getContainer(db, 'another')).toBeUndefined();
    expect(await getPlatformUserByClerkId(db, 'user_other')).toBeFalsy();
  });

  it.each([null, 'matrixos-existing'])('refuses an unresolved retained route %j before admitting another owner', async target => {
    const first = await bootstrapDevstackIdentity(db, input());
    await db.executor.updateTable('containers').set({ container_id: target })
      .where('handle', '=', input().handle).execute();
    await expect(bootstrapDevstackIdentity(other, input({ clerkUserId: 'user_peer', handle: 'peer' })))
      .rejects.toThrow(/reconcile/i);
    expect(await getContainer(db, 'peer')).toBeUndefined();
    expect(await getPlatformUserByClerkId(db, 'user_peer')).toBeFalsy();
    expect(await getPlatformUserByClerkId(db, input().clerkUserId)).toMatchObject({ id: first.userId });
    expect(await getContainer(db, input().handle)).toMatchObject({ containerId: target, clerkUserId: input().clerkUserId });
  });

  it('replays after normal Docker resolution reconciles an already owned legacy name', async () => {
    const first = await bootstrapDevstackIdentity(db, input());
    const name = 'matrixos-existing';
    await db.executor.updateTable('containers').set({ container_id: name }).where('handle', '=', input().handle).execute();
    const docker = { getContainer(id: string) {
      expect(id).toBe(name);
      return { inspect: async () => ({ Id: input().containerId, State: { Running: true }, NetworkSettings: { Networks: {} } }) };
    } } as unknown as Dockerode;
    await resolveContainerEndpoint(docker, other, input().handle, name);
    expect(await getContainer(db, input().handle)).toMatchObject({ containerId: input().containerId });
    expect(await bootstrapDevstackIdentity(db, input())).toEqual(first);
  });

  it('retains the same immutable target after a real endpoint lookup and identical replay', async () => {
    const first = await bootstrapDevstackIdentity(db, input());
    const docker = { getContainer(id: string) {
      expect(id).toBe(input().containerId);
      return { inspect: async () => ({ Id: input().containerId, State: { Running: true }, NetworkSettings: { Networks: {} } }) };
    } } as unknown as Dockerode;
    const route = await getContainer(other, input().handle);
    expect(await resolveContainerEndpoint(docker, other, input().handle, route?.containerId))
      .toMatchObject({ source: 'docker-id', containerId: input().containerId });
    expect(await bootstrapDevstackIdentity(db, input())).toEqual(first);
    await expect(bootstrapDevstackIdentity(db, input({containerId: 'matrixos-owned-name'}))).rejects.toThrow(/identity|registration/i);
  });

  it('cannot give another Clerk user an occupied local handle', async () => {
    const first = await bootstrapDevstackIdentity(db, input());
    await expect(bootstrapDevstackIdentity(other, input({ clerkUserId: 'user_another_fixture' })))
      .rejects.toThrow(/owned|ownership|registration/i);
    expect(await db.executor.selectFrom('users').select('id').execute()).toEqual([{ id: first.userId }]);
    expect(await getContainer(db, input().handle)).toMatchObject({ clerkUserId: input().clerkUserId });
  });
});
