import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createPlatformDb, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { installAiFundedRouteBindingSchema, insertAiFundedRouteBinding, readAiFundedRouteBinding,
  googleQualifiedRouteDigest } from '../../packages/platform/src/ai-funded-route-binding.js';
import { managedGoogleRouteDescriptorDigest } from '../../packages/proxy/src/funded-google-route-descriptor.js';
import { qualifiedIdentity as identity, qualifiedLeaseFixture, qualifiedModel, qualifiedNow as now, qualifiedRouteFixture } from '../helpers/google-qualified-funded-fixture.js';

describe.skipIf(!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL)('qualified route binding on real PostgreSQL', () => {
  let db: PlatformDB;
  let other: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); await installAiFundedRouteBindingSchema(db.executor);
    const name = (await sql<{ name: string }>`select current_database() as name`.execute(db.executor)).rows[0]!.name;
    const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL!); url.pathname = `/${name}`;
    other = createPlatformDb(url.toString()); await other.ready;
    await insertUserMachine(db, { ...identity, clerkUserId: identity.ownerId, handle: 'binding-one', status: 'running', imageVersion: 'fixture',
      activationState: 'authorized', provisionedAt: now.toISOString() });
    const token = qualifiedLeaseFixture().credential;
    await db.executor.insertInto('ai_runtime_credentials').values({ token_id: token.tokenId, token_hash: 'a'.repeat(64), owner_id: identity.ownerId,
      machine_id: identity.machineId, runtime_slot: identity.runtimeSlot, audience: token.audience, scope: token.scope,
      issued_at: token.issuedAt, expires_at: token.expiresAt, revoked_at: null, request_class: 'interactive' }).execute();
  });
  afterEach(async () => { await other?.destroy(); await destroyTestPlatformDb(db); });
  const binding = () => ({ ...qualifiedRouteFixture(), requestClass: 'interactive' as const });
  const input = () => ({ identity, tokenId: 'token_one', binding: binding() });
  const query = () => ({ identity, tokenId: 'token_one', api: 'openai-completions' as const, canonicalModelId: qualifiedModel,
    requestClass: 'interactive' as const, expectedDigest: binding().digest });
  const insert = (connection = db) => connection.kysely.transaction().execute(trx => insertAiFundedRouteBinding(trx, input(), () => new Date(now)));
  const rows = async () => (await sql`select * from ai_runtime_credential_routes`.execute(db.executor)).rows;
  async function waitForTokenLock(executor: PlatformDB['executor']) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      // Observer is itself in the held transaction; refresh PostgreSQL's transaction-cached activity snapshot.
      await sql`SELECT pg_stat_clear_snapshot()`.execute(executor);
      const result = await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE OF credential%'`.execute(executor);
      if (result.rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Insert never waited on actual credential lock');
  }

  it('shares canonical digest/domain with actual proxy builder and persists exact authoritative facts', async () => {
    expect(googleQualifiedRouteDigest(binding().descriptor)).toBe(managedGoogleRouteDescriptorDigest(binding().descriptor));
    expect(googleQualifiedRouteDigest(binding().descriptor)).toBe(binding().digest);
    expect(googleQualifiedRouteDigest(binding().descriptor)).toBe('c6c631d808b4d053f497ae8882ef9999f864a0c3bb2c96c2d26407eaa765a50a');
    expect(await insert()).toEqual(binding());
    expect(await readAiFundedRouteBinding(db.executor, query(), () => new Date(now))).toEqual(binding());
    expect((await rows())[0]).toMatchObject({ token_id: 'token_one', descriptor_digest: binding().digest,
      relay_base_url: binding().relayBaseUrl, evidence_expires_at: binding().evidenceExpiresAt });
    await installAiFundedRouteBindingSchema(db.executor); expect(await rows()).toHaveLength(1);
  });
  it('requires a caller-owned transaction and rolls back child with caller work', async () => {
    await expect(insertAiFundedRouteBinding(db.executor as any, input(), () => new Date(now))).rejects.toThrow('Qualified AI route unavailable');
    await expect(db.kysely.transaction().execute(async trx => { await insertAiFundedRouteBinding(trx, input(), () => new Date(now)); throw new Error('fixture rollback'); })).rejects.toThrow('fixture rollback');
    expect(await rows()).toHaveLength(0);
  });
  it('rechecks time after persistence awaits and rolls back if expiry passed', async () => {
    let checks = 0;
    await expect(db.kysely.transaction().execute(trx => insertAiFundedRouteBinding(trx, input(), () =>
      ++checks === 1 ? new Date(now) : new Date('2026-10-22T12:15:00.000Z')))).rejects.toThrow('Qualified AI route unavailable');
    expect(await rows()).toHaveLength(0);
  });
  it('allows concurrent exact retries but cannot replace an existing route', async () => {
    const results = await Promise.all([insert(), insert(other)]); expect(results).toEqual([binding(), binding()]);
    const changed = input(); changed.binding.descriptor.routeRevision++; changed.binding.digest = googleQualifiedRouteDigest(changed.binding.descriptor);
    await expect(db.kysely.transaction().execute(trx => insertAiFundedRouteBinding(trx, changed, () => new Date(now)))).rejects.toThrow('Qualified AI route unavailable');
    expect(await readAiFundedRouteBinding(db.executor, query(), () => new Date(now))).toEqual(binding()); expect(await rows()).toHaveLength(1);
  });
  it.each(['owner', 'machine', 'slot', 'digest', 'model', 'api', 'class'] as const)('rejects exact read expectation mismatch %s', async mismatch => {
    await insert(); const value: any = structuredClone(query());
    if (mismatch === 'owner') value.identity.ownerId = 'other_owner'; if (mismatch === 'machine') value.identity.machineId = 'other_machine';
    if (mismatch === 'slot') value.identity.runtimeSlot = 'other'; if (mismatch === 'digest') value.expectedDigest = 'f'.repeat(64);
    if (mismatch === 'model') value.canonicalModelId = '@cf/meta/llama-4-scout-17b-16e-instruct';
    if (mismatch === 'api') value.api = 'anthropic-messages'; if (mismatch === 'class') value.requestClass = 'background';
    await expect(readAiFundedRouteBinding(db.executor, value, () => new Date(now))).rejects.toThrow('Qualified AI route unavailable');
  });
  it('rejects forged digest/relay/evidence/class and a token longer-lived than exact reviewed evidence', async () => {
    for (const mutation of ['digest', 'relay', 'evidence', 'class', 'window', 'unknown'] as const) {
      const value: any = input();
      if (mutation === 'digest') value.binding.digest = 'f'.repeat(64);
      if (mutation === 'relay') value.binding.relayBaseUrl = 'https://forged.example.test';
      if (mutation === 'evidence') value.binding.evidenceExpiresAt = '2099-01-01T00:00:00.000Z';
      if (mutation === 'class') value.binding.requestClass = 'background';
      if (mutation === 'unknown') value.binding.approved = true;
      if (mutation === 'window') { value.binding.descriptor.evidence.expiresAt = '2026-10-22T12:01:00.000Z';
        value.binding.evidenceExpiresAt = value.binding.descriptor.evidence.expiresAt; value.binding.digest = googleQualifiedRouteDigest(value.binding.descriptor); }
      await expect(db.kysely.transaction().execute(trx => insertAiFundedRouteBinding(trx, value, () => new Date(now)))).rejects.toThrow('Qualified AI route unavailable');
      expect(await rows()).toHaveLength(0);
    }
  });
  it.each(['owner', 'machine', 'slot'] as const)('rejects insertion under a foreign %s identity', async field => {
    const value = structuredClone(input());
    if (field === 'owner') value.identity.ownerId = 'other_owner'; if (field === 'machine') value.identity.machineId = 'other_machine';
    if (field === 'slot') value.identity.runtimeSlot = 'other';
    await expect(db.kysely.transaction().execute(trx => insertAiFundedRouteBinding(trx, value, () => new Date(now)))).rejects.toThrow('Qualified AI route unavailable');
    expect(await rows()).toHaveLength(0);
  });
  it.each(['audience', 'scope', 'class', 'inactive', 'deleted'] as const)('refuses actual token/machine mismatch %s', async field => {
    if (field === 'audience') await db.executor.updateTable('ai_runtime_credentials').set({ audience: 'matrix-platform-speech' }).execute();
    if (field === 'scope') await db.executor.updateTable('ai_runtime_credentials').set({ scope: 'speech:transcribe' }).execute();
    if (field === 'class') await db.executor.updateTable('ai_runtime_credentials').set({ request_class: 'background' }).execute();
    if (field === 'inactive') await db.executor.updateTable('user_machines').set({ status: 'stopped' }).execute();
    if (field === 'deleted') await db.executor.updateTable('user_machines').set({ deleted_at: now.toISOString() }).execute();
    await expect(insert()).rejects.toThrow('Qualified AI route unavailable'); expect(await rows()).toHaveLength(0);
  });
  it('rechecks token revocation, token/evidence time and actual machine ownership without substituting route', async () => {
    await insert();
    await expect(readAiFundedRouteBinding(db.executor, query(), () => new Date('2026-10-22T12:15:00.000Z'))).rejects.toThrow('Qualified AI route unavailable');
    await expect(readAiFundedRouteBinding(db.executor, query(), () => new Date('2026-10-21T11:00:00.000Z'))).rejects.toThrow('Qualified AI route unavailable');
    await db.executor.updateTable('ai_runtime_credentials').set({ revoked_at: now.toISOString() }).where('token_id', '=', 'token_one').execute();
    await expect(readAiFundedRouteBinding(db.executor, query(), () => new Date(now))).rejects.toThrow('Qualified AI route unavailable');
    await expect(insert()).rejects.toThrow('Qualified AI route unavailable');
    await db.executor.updateTable('ai_runtime_credentials').set({ revoked_at: null }).where('token_id', '=', 'token_one').execute();
    await db.executor.updateTable('user_machines').set({ clerk_user_id: 'owner_two' }).where('machine_id', '=', identity.machineId).execute();
    await expect(readAiFundedRouteBinding(db.executor, query(), () => new Date(now))).rejects.toThrow('Qualified AI route unavailable');
  });
  it('returns null only for absent child and cascades with actual token deletion', async () => {
    expect(await readAiFundedRouteBinding(db.executor, query(), () => new Date(now))).toBeNull();
    await insert(); await db.executor.deleteFrom('ai_runtime_credentials').where('token_id', '=', 'token_one').execute();
    expect(await rows()).toHaveLength(0);
    await expect(insert()).rejects.toThrow('Qualified AI route unavailable');
  });
  it('lets actual token revocation win while an insert waits on its row lock', async () => {
    let pending!: Promise<unknown>;
    await db.kysely.transaction().execute(async trx => {
      await trx.updateTable('ai_runtime_credentials').set({ revoked_at: now.toISOString() }).where('token_id', '=', 'token_one').execute();
      pending = insert(other).then(() => 'unexpected success', error => error);
      await waitForTokenLock(trx);
    });
    expect(await pending).toMatchObject({ message: 'Qualified AI route unavailable' }); expect(await rows()).toHaveLength(0);
  });
  it.each([false, true])('bounds actual held-token wait and preserves stricter caller timeout=%s', async strict => {
    let unlock!: () => void; let markLocked!: () => void; let held!: PlatformDB['executor'];
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const locked = new Promise<void>(resolve => { markLocked = resolve; });
    const blocker = db.kysely.transaction().execute(async trx => {
      await sql`SELECT token_id FROM ai_runtime_credentials WHERE token_id = 'token_one' FOR UPDATE`.execute(trx);
      held = trx; markLocked(); await gate;
    });
    await locked;
    // Old unbounded behavior is released even when RED; never strand the DB/test pool.
    const fallback = setTimeout(unlock, 3300);
    try {
      const session = async () => (await sql`SELECT name, setting, pg_backend_pid() AS pid
        FROM pg_settings WHERE name IN ('statement_timeout', 'lock_timeout') ORDER BY name`.execute(other.executor)).rows;
      const before = await session();
      const started = performance.now();
      const pending = other.kysely.transaction().execute(async trx => {
        await sql`SELECT set_config('statement_timeout', ${strict ? '0.25s' : '0'}, true),
          set_config('lock_timeout', ${strict ? '0.1s' : '0'}, true)`.execute(trx);
        return insertAiFundedRouteBinding(trx, input(), () => new Date(now));
      }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      if (!strict) await waitForTokenLock(held);
      const result = await pending; const elapsed = performance.now() - started;
      expect(result.error).toMatchObject({ code: '55P03' });
      expect(result.value).toBeUndefined(); expect(elapsed).toBeGreaterThan(strict ? 60 : 1700);
      expect(elapsed).toBeLessThan(strict ? 1000 : 3000);
      expect(await session()).toEqual(before); // Same physical session restored after actual timeout/rollback.
    } finally { clearTimeout(fallback); unlock(); await blocker; }
    expect(await rows()).toHaveLength(0);
  });
  it.each([
    { statement: '0', lock: '0', expected: ['2000', '5000'], rollback: false },
    { statement: '0.25s', lock: '0.1s', expected: ['100', '250'], rollback: false },
    { statement: '0.1min', lock: '3s', expected: ['2000', '5000'], rollback: false },
    { statement: '0', lock: '0', expected: ['2000', '5000'], rollback: true },
  ])('sets local caps from PostgreSQL-normalized units and restores session $statement/$lock/rollback=$rollback', async scenario => {
    await db.kysely.connection().execute(async connection => {
      const settings = async (executor: PlatformDB['executor']) => (await sql<{ name: string; setting: string; unit: string }>`
        SELECT name, setting, unit FROM pg_settings WHERE name IN ('statement_timeout', 'lock_timeout') ORDER BY name`.execute(executor)).rows;
      const original = await settings(connection);
      const pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection)).rows[0]!.pid;
      const run = connection.transaction().execute(async trx => {
        await sql`SELECT set_config('statement_timeout', ${scenario.statement}, true), set_config('lock_timeout', ${scenario.lock}, true)`.execute(trx);
        await insertAiFundedRouteBinding(trx, input(), () => new Date(now));
        expect(await settings(trx)).toEqual([{ name: 'lock_timeout', setting: scenario.expected[0], unit: 'ms' },
          { name: 'statement_timeout', setting: scenario.expected[1], unit: 'ms' }]);
        if (scenario.rollback) throw new Error('fixture rollback');
      });
      if (scenario.rollback) await expect(run).rejects.toThrow('fixture rollback'); else await run;
      expect(await settings(connection)).toEqual(original);
      expect((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection)).rows[0]!.pid).toBe(pid);
    });
    expect(await rows()).toHaveLength(scenario.rollback ? 0 : 1);
  });
  it('refuses tampered stored proof and propagates a missing schema as failure, never legacy absence', async () => {
    await insert();
    await sql`update ai_runtime_credential_routes set descriptor = jsonb_set(descriptor, '{routeRevision}', '2'::jsonb)`.execute(db.executor);
    await expect(readAiFundedRouteBinding(db.executor, query(), () => new Date(now))).rejects.toThrow('Qualified AI route unavailable');
    await sql`drop table ai_runtime_credential_routes`.execute(db.executor);
    await expect(readAiFundedRouteBinding(db.executor, query(), () => new Date(now))).rejects.toMatchObject({ code: '42P01' });
  });
  it('enforces descriptor size and FK at the database boundary', async () => {
    await insert(); const row: any = (await rows())[0];
    await expect(sql`update ai_runtime_credential_routes set descriptor = ${JSON.stringify({ oversized: 'x'.repeat(65536) })}::jsonb`.execute(db.executor)).rejects.toMatchObject({ code: '23514' });
    await expect(sql`insert into ai_runtime_credential_routes select 'missing_token', descriptor, descriptor_digest,
      relay_base_url, api, canonical_model_id, request_class, evidence_expires_at from ai_runtime_credential_routes`.execute(db.executor)).rejects.toMatchObject({ code: '23503' });
    expect(row.token_id).toBe('token_one');
  });
});
