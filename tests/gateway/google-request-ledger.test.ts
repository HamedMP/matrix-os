import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleRequestLedger } from '../../packages/gateway/src/google-data/runtime/request-ledger.js';
import { GoogleProcessingEnvelopeSchema, signGoogleProcessingEnvelope, verifyGoogleProcessingEnvelope, type GoogleProcessingEnvelope } from '../../packages/gateway/src/google-data/runtime/envelope.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';
const initial = Date.parse('2026-10-21T20:00:00Z');
const machineToken = 'synthetic-ledger-machine-key-only';
const request = { method: 'POST', path: '/read-call', body: '{"service":"gmail","action":"get_message"}' };
const claim = { ownerId: 'owner-one', runId: 'run_one', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1',
  profileId: '11111111-1111-4111-8111-111111111111', profileRevision: 1, consentId: '22222222-2222-4222-8222-222222222222', consentRevision: 1,
  googleAccountId: '33333333-3333-4333-8333-333333333333', purposeId: 'gmail-assistance', routeDigest: 'b'.repeat(64), policyExpiresAt: new Date(initial + 60000).toISOString() };
function verified(overrides: Record<string, unknown> = {}, at = initial): GoogleProcessingEnvelope {
  const value = { ...claim, policyExpiresAt: new Date(at + 60000).toISOString(), ...overrides };
  const token = signGoogleProcessingEnvelope(value, { ...request, machineToken, now: at });
  return verifyGoogleProcessingEnvelope(token, { ...request, machineToken, ownerId: value.ownerId, now: at });
}
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
let ledger: ReturnType<typeof createGoogleRequestLedger>;
let clock: Date;
beforeEach(async () => {
  ({ db } = await createAuthorityFixture()); clock = new Date(initial);
  ledger = createGoogleRequestLedger(db.sql, { now: () => clock }); await ledger.migrate();
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await ledger.close(); await db.destroy(); });
const rows = () => sql<{ request_id: string; owner_id: string; claim_digest: string }>`SELECT * FROM google_processing_requests`.execute(db.sql);
describe('durable verified Google request consumption', () => {
  it('stores only a canonical full-claim digest and consumes an ID once globally', async () => {
    const envelope = verified(); await expect(ledger.consume(envelope)).resolves.toBeUndefined();
    const record = (await rows()).rows[0]!;
    expect(record).toMatchObject({ request_id: envelope.requestId, owner_id: claim.ownerId, claim_digest: createHash('sha256').update(JSON.stringify(GoogleProcessingEnvelopeSchema.parse(envelope))).digest('hex') });
    expect(Object.keys(record).sort()).toEqual(['claim_digest', 'consumed_at', 'expires_at', 'owner_id', 'request_id', 'retained_until']);
    expect(JSON.stringify(record)).not.toMatch(/run_one|gmail-assistance|get_message|profileRevision|machine-key/);
    await expect(ledger.consume(Object.fromEntries(Object.entries(envelope).reverse()))).rejects.toMatchObject({ code: 'replay' });
  });
  it('rejects replay with every changed owner/run/profile/consent/request claim', async () => {
    const envelope = verified(); await ledger.consume(envelope);
    for (const changed of [{ ownerId: 'other' }, { runId: 'run_other' }, { runtimeHandle: `runtime_${'c'.repeat(32)}` }, { executionGeneration: '2' },
      { profileId: '44444444-4444-4444-8444-444444444444' }, { profileRevision: 2 }, { consentId: '55555555-5555-4555-8555-555555555555' },
      { consentRevision: 2 }, { googleAccountId: '66666666-6666-4666-8666-666666666666' }, { purposeId: 'other' }, { routeDigest: 'd'.repeat(64) },
      { path: '/call' }, { bodyDigest: 'e'.repeat(64) }, { issuedAt: initial + 1 }, { expiresAt: initial + 29999 }, { policyExpiresAt: new Date(initial + 120000).toISOString() }]) {
      await expect(ledger.consume({ ...envelope, ...changed })).rejects.toMatchObject({ code: 'replay' });
    }
    expect((await rows()).rows).toHaveLength(1);
  });
  it('rejects malformed, unsupported and invalid-time objects before recording anything', async () => {
    const envelope = verified();
    for (const changed of [{ approved: true }, { method: 'GET' }, { path: '/other' }, { requestId: 'not-a-uuid' },
      { issuedAt: initial + 5001 }, { issuedAt: initial + 1000, expiresAt: initial + 500 }, { expiresAt: initial }, { expiresAt: envelope.issuedAt + 30001 },
      { policyExpiresAt: new Date(initial + 1).toISOString() }, { ownerId: '../owner' }]) {
      await expect(ledger.consume({ ...envelope, ...changed })).rejects.toMatchObject({ code: 'unavailable' });
    }
    await expect(ledger.consume(signGoogleProcessingEnvelope(claim, { ...request, machineToken, now: initial }))).rejects.toMatchObject({ code: 'unavailable' });
    expect((await rows()).rows).toHaveLength(0);
  });
  it('does not release a successful consumption after the database commit outlives the envelope', async () => {
    let reads = 0;
    const expiring = createGoogleRequestLedger(db.sql, { now: () => new Date(++reads === 1 ? initial : initial + 30001) });
    await expect(expiring.consume(verified())).rejects.toMatchObject({ code: 'unavailable' });
    await expiring.close();
  });
  it('retains replay metadata through expiry plus skew, then denies the old expired envelope even after purge', async () => {
    const envelope = verified(); await ledger.consume(envelope);
    clock = new Date(initial + 34999); expect(await ledger.cleanup()).toBe(0);
    await expect(ledger.consume(envelope)).rejects.toMatchObject({ code: 'unavailable' });
    clock = new Date(initial + 35000); expect(await ledger.cleanup()).toBe(1);
    expect((await rows()).rows).toHaveLength(0);
    await expect(ledger.consume(envelope)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(ledger.consume(verified({}, clock.getTime()))).resolves.toBeUndefined();
  });
  it('enforces global and owner caps without consuming a capacity-refused ID', async () => {
    const capped = createGoogleRequestLedger(db.sql, { now: () => clock, maxRows: 2, maxRowsPerOwner: 1 });
    const one = verified(), refused = verified(); await capped.consume(one);
    await expect(capped.consume(refused)).rejects.toMatchObject({ code: 'capacity' });
    await capped.consume(verified({ ownerId: 'second' }));
    await expect(capped.consume(verified({ ownerId: 'third' }))).rejects.toMatchObject({ code: 'capacity' });
    await expect(ledger.consume(refused)).resolves.toBeUndefined();
    await capped.close();
  });
  it('reclaims expired metadata inside consumption before enforcing the budget', async () => {
    const capped = createGoogleRequestLedger(db.sql, { now: () => clock, maxRows: 1, maxRowsPerOwner: 1 });
    await capped.consume(verified()); clock = new Date(initial + 35000);
    await expect(capped.consume(verified({}, clock.getTime()))).resolves.toBeUndefined();
    expect((await rows()).rows).toHaveLength(1); await capped.close();
  });
  it('drains only its recurring cleanup and leaves its injected database open', async () => {
    vi.useFakeTimers(); const intervals = vi.spyOn(globalThis, 'setInterval'), clear = vi.spyOn(globalThis, 'clearInterval');
    ledger.startCleanup(); ledger.startCleanup(); expect(intervals).toHaveBeenCalledTimes(1);
    const timer = intervals.mock.results[0]!.value; await vi.advanceTimersByTimeAsync(60000); await ledger.close();
    ledger.startCleanup(); expect(intervals).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(timer); expect((await sql`SELECT 1 AS alive`.execute(db.sql)).rows).toEqual([{ alive: 1 }]);
    await expect(ledger.consume(verified())).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('uses a default clock and rejects invalid budgets or clocks before dispatch', async () => {
    for (const options of [{ maxRows: 0 }, { maxRows: 100001 }, { maxRowsPerOwner: 1001 }]) expect(() => createGoogleRequestLedger(db.sql, options)).toThrow('Google data request unavailable');
    vi.useFakeTimers(); vi.setSystemTime(initial);
    const ordinary = createGoogleRequestLedger(db.sql); await ordinary.consume(verified()); await ordinary.close();
    const brokenClock = createGoogleRequestLedger(db.sql, { now: () => new Date('invalid') });
    await expect(brokenClock.consume(verified())).rejects.toMatchObject({ code: 'unavailable' }); await brokenClock.close();
  });
  it('contains recurring cleanup failure and keeps the database usable for its owner', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const transaction = vi.spyOn(db.sql, 'transaction').mockImplementation(() => { throw new Error('synthetic private cleanup error'); });
    vi.useFakeTimers(); ledger.startCleanup(); await vi.advanceTimersByTimeAsync(60000); await ledger.close();
    expect(warning.mock.calls.flat().join(' ')).not.toContain('synthetic private'); transaction.mockRestore();
    expect((await sql`SELECT 1 AS alive`.execute(db.sql)).rows).toEqual([{ alive: 1 }]);
  });
  it('contains database failure without storing or exposing raw claims', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const transaction = vi.spyOn(db.sql, 'transaction').mockImplementation(() => { throw new Error('synthetic private database failure'); });
    await expect(ledger.consume(verified())).rejects.toMatchObject({ code: 'unavailable', message: 'Google data request unavailable' });
    expect(warning.mock.calls.flat().join(' ')).not.toContain('synthetic private'); transaction.mockRestore();
    expect((await rows()).rows).toHaveLength(0);
  });
});
describe.runIf(Boolean(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL))('real PostgreSQL request ledger races', () => {
  it('admits exactly one concurrent identical or modified-ID replay across instances', async () => {
    const envelope = verified(), second = createGoogleRequestLedger(db.sql, { now: () => clock });
    const results = await Promise.allSettled([ledger.consume(envelope), second.consume(envelope), second.consume({ ...envelope, ownerId: 'other' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await rows()).rows).toHaveLength(1); await second.close();
  });
  it('serializes global and owner capacity checks with insert across instances', async () => {
    const one = createGoogleRequestLedger(db.sql, { now: () => clock, maxRows: 1, maxRowsPerOwner: 1 });
    const two = createGoogleRequestLedger(db.sql, { now: () => clock, maxRows: 1, maxRowsPerOwner: 1 });
    const results = await Promise.allSettled([one.consume(verified()), two.consume(verified({ ownerId: 'other' }))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await rows()).rows).toHaveLength(1); await one.close(); await two.close();
    clock = new Date(initial + 35000); await ledger.cleanup();
    const ownerOne = createGoogleRequestLedger(db.sql, { now: () => clock, maxRows: 2, maxRowsPerOwner: 1 });
    const ownerTwo = createGoogleRequestLedger(db.sql, { now: () => clock, maxRows: 2, maxRowsPerOwner: 1 });
    const owned = await Promise.allSettled([ownerOne.consume(verified({}, clock.getTime())), ownerTwo.consume(verified({}, clock.getTime()))]);
    expect(owned.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await rows()).rows).toHaveLength(1); await ownerOne.close(); await ownerTwo.close();
  });
  it('rechecks expiry after a real writer lock wait', async () => {
    let release!: () => void, acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = db.sql.transaction().execute(async tx => { await sql`SELECT pg_advisory_xact_lock(5510357)`.execute(tx); acquired(); await held; });
    await ready; const pending = ledger.consume(verified());
    await new Promise(resolve => setTimeout(resolve, 20)); clock = new Date(initial + 30001); release(); await blocker;
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' }); expect((await rows()).rows).toHaveLength(0);
  });
  it('orders cleanup and fresh consumption without deadlocks or lost replay state', async () => {
    await ledger.consume(verified()); clock = new Date(initial + 35000); const fresh = verified({}, clock.getTime());
    await Promise.all([ledger.cleanup(), ledger.consume(fresh), ledger.cleanup()]);
    expect((await rows()).rows).toHaveLength(1); await expect(ledger.consume(fresh)).rejects.toMatchObject({ code: 'replay' });
  });  it('caps in-flight database work and drains accepted work on close', async () => {
    let release!: () => void, acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = db.sql.transaction().execute(async tx => { await sql`SELECT pg_advisory_xact_lock(5510357)`.execute(tx); acquired(); await held; });
    await ready;
    const pending = Promise.allSettled(Array.from({ length: 64 }, () => ledger.consume(verified())));
    await expect(ledger.consume(verified())).rejects.toMatchObject({ code: 'capacity' });
    let drained = false; const closing = ledger.close().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(drained).toBe(false);
    await expect(ledger.consume(verified())).rejects.toMatchObject({ code: 'unavailable' });
    release(); await blocker;
    expect((await pending).every(result => result.status === 'fulfilled')).toBe(true); await closing;
    expect(drained).toBe(true); expect((await rows()).rows).toHaveLength(64);
    expect((await sql`SELECT 1 AS alive`.execute(db.sql)).rows).toEqual([{ alive: 1 }]);
  });
  it('coalesces slow recurring cleanup instead of queuing more work', async () => {
    let release!: () => void, acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = db.sql.transaction().execute(async tx => { await sql`SELECT pg_advisory_xact_lock(5510357)`.execute(tx); acquired(); await held; });
    await ready; vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); const transactions = vi.spyOn(db.sql, 'transaction');
    try {
      ledger.startCleanup(); await vi.advanceTimersByTimeAsync(120000);
      expect(transactions).toHaveBeenCalledTimes(1);
    } finally { release(); await blocker; }
    await ledger.close(); expect(transactions).toHaveBeenCalledTimes(1);
  });

});
