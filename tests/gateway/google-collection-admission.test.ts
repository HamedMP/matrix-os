import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { createGoogleDataAuthority } from '../../packages/gateway/src/google-data/authority.js';
import { createGoogleCollectionAdmission, GoogleCollectionAdmissionError, type GoogleCollectionAdmissionDependencies } from '../../packages/gateway/src/google-data/runtime/collection-admission.js';
import { GOOGLE_PROCESSING_HEADER, signGoogleProcessingEnvelope, type GoogleProcessingClaim } from '../../packages/gateway/src/google-data/runtime/envelope.js';
import { createGoogleRequestLedger } from '../../packages/gateway/src/google-data/runtime/request-ledger.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { accountId, consentInput, now, profileInput, route } from './google-data/fixtures.js';

const machineToken = 'synthetic-machine-token-not-a-real-secret';
const body = JSON.stringify({ service: 'gmail', action: 'list_messages', connectionId: accountId, params: { query: 'synthetic-private-query' } });
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'];
let ledger: ReturnType<typeof createGoogleRequestLedger>;
beforeEach(async () => { ({ db } = await createAuthorityFixture()); });
afterEach(async () => { await ledger?.close(); await db.destroy(); vi.restoreAllMocks(); });

async function fixture(options: { consentKinds?: string[]; models?: string[] } = {}) {
  let clock = new Date(now), active = true;
  const input = profileInput(); input.allowedModels = options.models ?? ['model-a'];
  const profile = await db.repository.reviewProfile(input, 0);
  const consent = await db.repository.recordConsent(consentInput(profile.id, options.consentKinds ? { dataKinds: options.consentKinds } : {}), 0);
  const authority = createGoogleDataAuthority(db.repository, { now: () => clock });
  const stamp = await authority.assertAuthorized({ ownerId: 'owner-one', googleAccountId: accountId,
    purposeId: input.purposeId, profileId: profile.id, dataKinds: options.consentKinds ?? input.dataKinds, resolvedRoute: route() });
  ledger = createGoogleRequestLedger(db.sql, { now: () => clock }); await ledger.migrate();
  const claim: GoogleProcessingClaim = { ownerId: stamp.ownerId, googleAccountId: accountId, runId: 'run_synthetic',
    runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', profileId: profile.id, profileRevision: stamp.profileRevision,
    consentId: stamp.consentId, consentRevision: stamp.consentRevision, purposeId: stamp.purposeId,
    routeDigest: stamp.routeDigest, policyExpiresAt: stamp.expiresAt };
  const consume = vi.fn(async value => { await ledger.consume(value); });
  const ownsGmailAccount = vi.fn(async (owner: string, account: string) => active && owner === claim.ownerId && account === accountId);
  const deps: GoogleCollectionAdmissionDependencies = { repository: db.repository, authority, ledger: { consume },
    resolveRuntime: async () => ({ ownerId: 'owner-one', machineToken }), ownsGmailAccount, now: () => clock };
  const collected = vi.fn();
  let beforeRelease: (() => Promise<void>) | undefined;
  let released: (() => Promise<void>) | undefined;
  function app(overrides: Partial<GoogleCollectionAdmissionDependencies> = {}) {
    const admission = createGoogleCollectionAdmission({ ...deps, ...overrides });
    const server = new Hono();
    server.all('*', async c => {
      try {
        const path = c.req.path === '/read-call' ? '/read-call' : '/call';
        const grant = await admission.admit({ context: c, ownerId: claim.ownerId, googleAccountId: accountId,
          path, body: await c.req.text() });
        released = grant.release; collected();
        await beforeRelease?.(); await grant.release();
        return c.json({ data: 'synthetic Google response' });
      } catch (error) {
        expect(error).toBeInstanceOf(GoogleCollectionAdmissionError);
        return c.json({ error: error instanceof Error ? error.message : 'unexpected' }, 403);
      }
    });
    return server;
  }
  const token = (extra: Partial<GoogleProcessingClaim> = {}, path: '/call' | '/read-call' = '/call') => signGoogleProcessingEnvelope({ ...claim, ...extra },
    { machineToken, method: 'POST', path, body, now: clock.getTime() });
  const send = (server: Hono, options: { token?: string; path?: string; body?: string; signal?: AbortSignal; method?: string } = {}) => server.request(options.path ?? '/call', {
    method: options.method ?? 'POST', headers: { 'content-type': 'application/json', [GOOGLE_PROCESSING_HEADER]: options.token ?? token() }, body: options.body ?? body, signal: options.signal,
  });
  return { app, send, token, deps, consume, ownsGmailAccount, collected, profile, consent, claim, stamp,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, deactivate: () => { active = false; },
    beforeRelease: (hook: () => Promise<void>) => { beforeRelease = hook; }, release: () => released!(),
    rows: () => sql<Record<string, unknown>>`SELECT * FROM google_processing_requests`.execute(db.sql),
  };
}

describe('machine-authenticated Gmail collection admission', () => {
  it.each(['native', 'pipedream'])('admits the same canonical owned account for %s transport and releases only after revalidation', async transport => {
    const f = await fixture(); const server = f.app();
    const response = await f.send(server);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: 'synthetic Google response' });
    expect(f.collected).toHaveBeenCalledOnce(); expect(f.consume).toHaveBeenCalledOnce();
    expect(f.ownsGmailAccount).toHaveBeenCalledWith('owner-one', accountId);
    expect(f.ownsGmailAccount.mock.calls.every(([, account]) => account === accountId)).toBe(true);
    expect(JSON.stringify((await f.rows()).rows)).not.toContain('synthetic-private-query');
    // Provider-specific markers are transport metadata; only the canonical UUID is authority.
    expect(f.consume.mock.calls[0]![0].googleAccountId).toBe(accountId);
    expect(f.consume.mock.calls[0]![0]).not.toHaveProperty('transport', transport);
  });
  it('accepts the independently signed dedicated read-call path', async () => {
    const f = await fixture(); expect((await f.send(f.app(), { path: '/read-call', token: f.token({}, '/read-call') })).status).toBe(200);
  });
  it('consumes a signed request once across receiver instances and never recollects on replay', async () => {
    const f = await fixture(); const token = f.token();
    expect((await f.send(f.app(), { token })).status).toBe(200);
    expect((await f.send(f.app(), { token })).status).toBe(403);
    expect(f.collected).toHaveBeenCalledOnce(); expect((await f.rows()).rows).toHaveLength(1);
  });
  it('rejects an expired signed request before touching collection or the ledger', async () => {
    const f = await fixture(); const token = f.token(); f.advance(30001);
    expect((await f.send(f.app(), { token })).status).toBe(403);
    expect(f.consume).not.toHaveBeenCalled(); expect(f.collected).not.toHaveBeenCalled();
  });
  it.each(['missing', 'owner', 'machine', 'signature', 'body', 'path', 'method', 'account', 'route'])("refuses %s mismatch before consuming or collecting", async mismatch => {
    const f = await fixture(); const overrides: Partial<GoogleCollectionAdmissionDependencies> = {};
    if (mismatch === 'missing') overrides.resolveRuntime = async () => null;
    if (mismatch === 'owner') overrides.resolveRuntime = async () => ({ ownerId: 'other-owner', machineToken });
    if (mismatch === 'machine') overrides.resolveRuntime = async () => ({ ownerId: 'owner-one', machineToken: 'different-synthetic-machine-token' });
    const sent: Parameters<typeof f.send>[1] = {};
    if (mismatch === 'signature') { const token = f.token(); sent.token = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`; }
    if (mismatch === 'body') sent.body = `${body} `;
    if (mismatch === 'path') { sent.token = f.token(); sent.path = '/read-call'; }
    if (mismatch === 'method') sent.method = 'PUT';
    if (mismatch === 'account') sent.token = f.token({ googleAccountId: '523e4567-e89b-42d3-a456-426614174000' });
    if (mismatch === 'route') sent.token = f.token({ routeDigest: 'f'.repeat(64) });
    expect((await f.send(f.app(overrides), sent)).status).toBe(403);
    expect(f.collected).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled(); expect((await f.rows()).rows).toHaveLength(0);
  });
  it.each(['profileRevision', 'consentRevision', 'consentId', 'purposeId', 'policyExpiresAt'] as const)('requires exact claim %s, not a fresh authority substitute', async field => {
    const f = await fixture();
    const change = field === 'profileRevision' || field === 'consentRevision' ? 2 : field === 'consentId' ? '123e4567-e89b-42d3-a456-426614174099'
      : field === 'policyExpiresAt' ? '2026-10-31T12:00:00.000Z' : 'other-purpose';
    expect((await f.send(f.app(), { token: f.token({ [field]: change }) })).status).toBe(403);
    expect(f.collected).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled();
  });
  it('requires all profile data kinds and uniquely reconstructs the signed route model', async () => {
    const f = await fixture({ consentKinds: ['gmail-metadata'], models: ['model-a', 'model-b'] });
    expect((await f.send(f.app())).status).toBe(403); expect(f.consume).not.toHaveBeenCalled();
  });
  it('finds the signed model even when it is not first in the reviewed model list', async () => {
    const f = await fixture({ models: ['model-b', 'model-a'] });
    expect((await f.send(f.app())).status).toBe(200); expect(f.collected).toHaveBeenCalledOnce();
  });
  it.each(['resolve', 'lookup', 'authority'])('rechecks account activity after awaiting %s', async stage => {
    const f = await fixture(); const overrides: Partial<GoogleCollectionAdmissionDependencies> = {};
    if (stage === 'resolve') overrides.resolveRuntime = async c => { const result = await f.deps.resolveRuntime(c); f.deactivate(); return result; };
    if (stage === 'lookup') overrides.repository = { snapshot: async key => { const result = await db.repository.snapshot(key); f.deactivate(); return result; } };
    if (stage === 'authority') overrides.authority = { ...f.deps.authority, assertAuthorized: async value => {
      const result = await f.deps.authority.assertAuthorized(value); f.deactivate(); return result;
    } };
    expect((await f.send(f.app(overrides))).status).toBe(403);
    expect(f.collected).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled();
  });
  it('rechecks an account that becomes inactive between lookups', async () => {
    const f = await fixture(); let checks = 0;
    const ownsGmailAccount = vi.fn(async () => ++checks === 1);
    expect((await f.send(f.app({ ownsGmailAccount }))).status).toBe(403);
    expect(ownsGmailAccount).toHaveBeenCalledTimes(2); expect(f.collected).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled();
  });
  it.each(['abort', 'expiry', 'account', 'consent', 'profile'])('denies %s changed during ledger admission after permanently consuming the request', async changed => {
    const f = await fixture(); const controller = new AbortController();
    const original = f.consume.getMockImplementation()!;
    f.consume.mockImplementation(async value => {
      await original(value);
      if (changed === 'abort') controller.abort();
      if (changed === 'expiry') f.advance(30001);
      if (changed === 'account') f.deactivate();
      if (changed === 'consent') await db.repository.revokeAccount('owner-one', accountId);
      if (changed === 'profile') await db.repository.revokeProfile(f.profile.id, 'owner-one', 1);
    });
    const response = await f.send(f.app(), { signal: controller.signal });
    expect(response.status).toBe(403); expect(f.collected).not.toHaveBeenCalled(); expect((await f.rows()).rows).toHaveLength(1);
  });
  it.each(['abort', 'expiry', 'account', 'consent', 'renewal', 'profile'])('withholds collected result after %s changes before release', async changed => {
    const f = await fixture(); const controller = new AbortController();
    f.beforeRelease(async () => {
      if (changed === 'abort') controller.abort();
      if (changed === 'expiry') f.advance(30001);
      if (changed === 'account') f.deactivate();
      if (changed === 'consent' || changed === 'renewal') await db.repository.revokeAccount('owner-one', accountId);
      if (changed === 'renewal') await db.repository.recordConsent(consentInput(f.profile.id), 2);
      if (changed === 'profile') await db.repository.revokeProfile(f.profile.id, 'owner-one', 1);
    });
    const response = await f.send(f.app(), { signal: controller.signal });
    expect(response.status).toBe(403); expect(f.collected).toHaveBeenCalledOnce();
    expect(await response.text()).not.toContain('synthetic Google response');
  });
  it.each(['resolve', 'lookup', 'account', 'ledger', 'authority'])('contains %s dependency failures without content-bearing diagnostics', async failed => {
    const f = await fixture(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = () => { throw new Error('synthetic-private-database-hostname'); };
    const overrides: Partial<GoogleCollectionAdmissionDependencies> = {};
    if (failed === 'resolve') overrides.resolveRuntime = error;
    if (failed === 'lookup') overrides.repository = { snapshot: error };
    if (failed === 'account') overrides.ownsGmailAccount = error;
    if (failed === 'ledger') overrides.ledger = { consume: error };
    if (failed === 'authority') overrides.authority = { assertAuthorized: error, revalidate: error };
    const response = await f.send(f.app(overrides));
    expect(response.status).toBe(403); expect(await response.text()).not.toContain('synthetic-private');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private'); expect(f.collected).not.toHaveBeenCalled();
  });
});
