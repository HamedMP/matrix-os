import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { createGoogleRunPinStore, type GoogleRunPinInput } from '../../packages/gateway/src/google-data/runtime/run-pins.js';
const suite = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const key = { ownerId: 'owner', chatId: 'chat_one', runId: 'run_one', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1' };
const input = (extra: Partial<GoogleRunPinInput> = {}): GoogleRunPinInput => ({ ...key, identityDigest: 'b'.repeat(64), originIds: ['c'.repeat(64)], stamps: [{ ownerId: 'owner', googleAccountId: '123e4567-e89b-42d3-a456-426614174000', purposeId: 'mail', profileId: '223e4567-e89b-42d3-a456-426614174000', profileRevision: 1, evidenceRevision: 1, disclosureRevision: 1, retentionRevision: 1, consentId: '323e4567-e89b-42d3-a456-426614174000', consentRevision: 1, dataKinds: ['google-derived-context'], routeDigest: 'd'.repeat(64), expiresAt: new Date(Date.now() + 3600000).toISOString() }], ...extra });
suite('durable immutable Google run pins', () => {
  let db: Kysely<Record<string, never>>; let admin: Kysely<Record<string, never>>; let schema: string;
  let pins: ReturnType<typeof createGoogleRunPinStore>;
  beforeEach(async () => {
    const connectionString = process.env.MATRIX_TEST_POSTGRES_URL!;
    if (!new URL(connectionString).pathname.includes('test')) throw new Error('Dedicated test database required');
    schema = `pins_${randomUUID().replaceAll('-', '')}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 10, options: `-c search_path=${schema}` }) }) });
    pins = createGoogleRunPinStore(db); await pins.migrate();
  });
  afterEach(async () => { await pins?.close(); await db?.destroy(); if (admin) { await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); } });
  it('persists an immutable pin across repository instances and isolates exact run/owner/chat', async () => {
    const value = input(); const pin = await pins.latch(value);
    expect(await createGoogleRunPinStore(db).get(key)).toEqual(pin);
    expect(await pins.get({ ...key, ownerId: 'other' })).toBeNull();
    expect(await pins.get({ ...key, chatId: 'other' })).toBeNull();
    expect(await pins.latch(value)).toEqual(pin);
    await expect(pins.latch({ ...value, identityDigest: 'f'.repeat(64) })).rejects.toThrow();
    await expect(pins.latch({ ...value, originIds: ['e'.repeat(64)] })).rejects.toThrow();
  });
  it('allows exactly one concurrent target-stamp latch', async () => {
    const one = input(); const two = structuredClone(one); two.stamps[0]!.consentRevision = 2;
    const outcomes = await Promise.allSettled([pins.latch(one), pins.latch(two)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('does not sweep a policy-expired pin before the run retirement deadline', async () => {
    const pin = await pins.latch(input());
    await sql`UPDATE google_runtime_policy_pins SET expires_at=now()-interval '1 second'`.execute(db);
    expect(await pins.cleanup()).toBe(0);
    expect(await pins.get(key)).not.toBeNull();
    await expect(pins.latch(input())).rejects.toThrow();
    await sql`UPDATE google_runtime_policy_pins SET retire_at=now()-interval '1 second'`.execute(db);
    expect(await pins.cleanup()).toBe(1); expect(await pins.get(key)).toBeNull();
    expect(Date.parse(pin.retireAt) - Date.parse(pin.createdAt)).toBeLessThanOrEqual(1200001);
  });
  it('rechecks expiry after an awaited pin admission lock', async () => {
    await db.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035505)`.execute(held);
      try {
        const value = input(); value.stamps[0]!.expiresAt = new Date(Date.now() + 60).toISOString();
        const result = pins.latch(value).then(() => 'latched', () => 'rejected');
        await new Promise(resolve => setTimeout(resolve, 100)); await sql`SELECT pg_advisory_unlock(551035505)`.execute(held);
        expect(await result).toBe('rejected');
      } finally { await sql`SELECT pg_advisory_unlock_all()`.execute(held); }
    });
    expect(await pins.get(key)).toBeNull();
  });
  it('serializes fixed owner caps and never stores content or arbitrary fields', async () => {
    pins = createGoogleRunPinStore(db, { maxPinsPerOwner: 2 });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => pins.latch(input({ runId: `run_${i}` }))));
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    await expect(pins.latch({ ...input(), rawContent: 'private' } as never)).rejects.toThrow();
  });
  it('rejects mismatched stamp owners, duplicate targets and absence of derived-context permission', async () => {
    const value = input(); value.stamps[0]!.ownerId = 'other'; await expect(pins.latch(value)).rejects.toThrow();
    const duplicate = input(); duplicate.stamps.push(duplicate.stamps[0]!); await expect(pins.latch(duplicate)).rejects.toThrow();
    const wrongKind = input(); wrongKind.stamps[0]!.dataKinds = ['gmail-content']; await expect(pins.latch(wrongKind)).rejects.toThrow();
  });
  it('drains its own sweep and closes without destroying the injected host pool', async () => {
    pins.startCleanup(); await pins.close(); await pins.close();
    expect((await sql`SELECT 1`.execute(db)).rows).toHaveLength(1);
    await expect(pins.get(key)).rejects.toThrow();
  });
});
