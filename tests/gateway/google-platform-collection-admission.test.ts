import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createGoogleCollectionAdmissionForPlatform } from '../../packages/gateway/src/google-data/register-collection-admission.js';
import { createGoogleDataAuthority } from '../../packages/gateway/src/google-data/authority.js';
import { createGoogleDataRepository } from '../../packages/gateway/src/google-data/repository.js';
import { createGoogleRequestLedger } from '../../packages/gateway/src/google-data/runtime/request-ledger.js';
import { GOOGLE_PROCESSING_HEADER, signGoogleProcessingEnvelope, type GoogleProcessingClaim } from '../../packages/gateway/src/google-data/runtime/envelope.js';
import { createPlatformGoogleCollectionAdmission } from '../../packages/platform/src/google-collection-admission.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { buildPlatformUserProof } from '../../packages/platform/src/session-routing-websocket.js';
import { registerInternalIntegrationRoutes } from '../../packages/platform/src/internal-integration-route-registration.js';
import { insertContainer, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from '../platform/native-platform-db-test-helper.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { accountId, consentInput, profileInput, route } from './google-data/fixtures.js';

const ownerId = 'user_alice'; const userId = '223e4567-e89b-42d3-a456-426614174000';
const secret = 'synthetic-platform-secret-not-a-live-secret'; const machineToken = buildPlatformVerificationToken('alice', secret);
const exactBody = '{ "service": "gmail", "action":"get_profile", "connectionId":"' + accountId + '" }\n';
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db']; let repository: ReturnType<typeof createGoogleDataRepository>;
let ledger: ReturnType<typeof createGoogleRequestLedger>; let platform: PlatformDB | undefined;
beforeEach(async () => { ({ db } = await createAuthorityFixture()); vi.stubEnv('ACCOUNT_DELETION_SECRET', undefined); });
afterEach(async () => { await ledger?.close(); await repository?.close(); await db.destroy(); if (platform) await destroyTestPlatformDb(platform);
  platform = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  let clock = new Date(); const now = () => clock; const future = () => new Date(clock.getTime() + 3600000).toISOString();
  repository = createGoogleDataRepository(db.sql, { now }); ledger = createGoogleRequestLedger(db.sql, { now }); await ledger.migrate();
  const input = profileInput(); input.ownerId = ownerId; input.evidence.expiresAt = future();
  input.dataKinds.push('google-derived-context');
  const profile = await repository.reviewProfile(input, 0); await repository.recordConsent(consentInput(profile.id, { ownerId, expiresAt: future(), dataKinds: input.dataKinds }), 0);
  const authority = createGoogleDataAuthority(repository, { now });
  const stamp = await authority.assertAuthorized({ ownerId, googleAccountId: accountId, purposeId: input.purposeId,
    profileId: profile.id, dataKinds: input.dataKinds, resolvedRoute: route() });
  const claim: GoogleProcessingClaim = { ownerId, googleAccountId: accountId, runId: 'run_test', runtimeHandle: `runtime_${'a'.repeat(32)}`,
    executionGeneration: '1', profileId: profile.id, profileRevision: stamp.profileRevision, consentId: stamp.consentId,
    consentRevision: stamp.consentRevision, purposeId: stamp.purposeId, routeDigest: stamp.routeDigest,
    policyExpiresAt: stamp.expiresAt, collectionExpiresAt: future() };
  let account = { id: accountId, user_id: userId, service: 'gmail', status: 'active', pipedream_account_id: 'apn_synthetic' };
  let user = { id: userId, clerk_id: ownerId };
  const consume = vi.fn(async (value: Parameters<typeof ledger.consume>[0]) => ledger.consume(value));
  const integrationDb = { googleData: { repository, authority, requestLedger: { consume } },
    getUserById: vi.fn(async (id: string) => id === user.id ? { ...user } : null),
    getUserByClerkId: vi.fn(async (id: string) => id === user.clerk_id ? { ...user } : null),
    getConnectedService: vi.fn(async (id: string) => id === account.id ? { ...account } : null) };
  const machineTokenForHandle = vi.fn(async (handle: string) => buildPlatformVerificationToken(handle, secret));
  const factory = () => createGoogleCollectionAdmissionForPlatform({ db: integrationDb as never, machineTokenForHandle, now });
  const sent = vi.fn(); let afterAdmit: (() => Promise<void>) | undefined;
  function routes(verified = true, overrides: Record<string, unknown> = {}, hook = factory()) {
    const app = new Hono(); app.use('*', bodyLimit({ maxSize: 65536 }));
    app.use('*', async (c, next) => { if (verified) { c.set('internalSignedOwnerDelegation', true); c.set('internalContainerHandle', 'alice'); c.set('internalContainerClerkUserId', ownerId); }
      for (const [key, value] of Object.entries(overrides)) c.set(key, value); await next(); });
    app.post('/:operation', async c => {
      try {
        await c.req.json(); // The producer must reuse cached exact UTF-8 bytes, not reserialize this object.
        const lease = await hook.admit(c, { ...account }, c.req.path.endsWith('/read-call') ? '/read-call' : '/call');
        await afterAdmit?.(); await lease.beforeSend(c.req.raw.signal); sent(); await lease.release(); return c.json({ ok: true });
      } catch (_error) { return c.json({ error: 'Integration service unavailable' }, 503); }
    }); return app;
  }
  const token = (options: { body?: string; path?: '/call' | '/read-call'; machineToken?: string; claim?: Partial<GoogleProcessingClaim> } = {}) =>
    signGoogleProcessingEnvelope({ ...claim, ...options.claim }, { method: 'POST', path: options.path ?? '/call', body: options.body ?? exactBody, machineToken: options.machineToken ?? machineToken, now: clock.getTime() });
  const send = (app: Hono, options: { token?: string; body?: string; path?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => app.request(options.path ?? '/call', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(options.body ?? exactBody)),
      [GOOGLE_PROCESSING_HEADER]: options.token ?? token(), ...options.headers }, body: options.body ?? exactBody, signal: options.signal });
  return { integrationDb, factory, routes, token, send, claim, consume, sent, machineTokenForHandle,
    account: () => ({ ...account }), setAccount: (value: Partial<typeof account>) => { account = { ...account, ...value }; },
    setUser: (value: Partial<typeof user>) => { user = { ...user, ...value }; }, afterAdmit: (work: () => Promise<void>) => { afterAdmit = work; },
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe('platform producer of internal Google collection admission', () => {
  it.each([
    ['/call', 'apn_synthetic'], ['/read-call', 'apn_synthetic'], ['/call', `gmail_${accountId}`], ['/read-call', `gmail_${accountId}`],
  ] as const)('checks exact cached request bytes and canonical ownership on %s for %s', async (path, transportId) => {
    const f = await fixture(); f.setAccount({ pipedream_account_id: transportId });
    const response = await f.send(f.routes(), { path, token: f.token({ path }) });
    expect(response.status).toBe(200); expect(f.consume).toHaveBeenCalledOnce(); expect(f.sent).toHaveBeenCalledOnce();
    expect(f.machineTokenForHandle).toHaveBeenCalledWith('alice'); expect(f.integrationDb.getConnectedService).toHaveBeenCalledWith(accountId);
  });
  it.each(['unsigned', 'false', 'string', 'missing-handle', 'missing-owner', 'public-session'] as const)('rejects %s context despite forged body/header assertions', async failure => {
    const f = await fixture(); const overrides = failure === 'false' ? { internalSignedOwnerDelegation: false }
      : failure === 'string' ? { internalSignedOwnerDelegation: 'true' } : failure === 'missing-handle' ? { internalContainerHandle: undefined }
      : failure === 'missing-owner' ? { internalContainerClerkUserId: undefined } : failure === 'public-session' ? { platformUserId: ownerId, platformHandle: 'alice' } : {};
    const response = await f.send(f.routes(!['unsigned', 'public-session'].includes(failure), overrides), { headers: {
      'x-platform-user-id': ownerId, 'x-platform-verified': 'true', internalSignedOwnerDelegation: 'true', authorization: `Bearer ${machineToken}` } });
    expect(response.status).toBe(503); expect(f.sent).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled();
  });
  it.each(['owner', 'service', 'inactive', 'account', 'machine', 'body', 'path', 'missing-envelope'] as const)('denies exact %s mismatch without sending', async failure => {
    const f = await fixture(); const request: Parameters<typeof f.send>[1] = {};
    if (failure === 'owner') f.setUser({ clerk_id: 'user_other' }); if (failure === 'service') f.setAccount({ service: 'github' });
    if (failure === 'inactive') f.setAccount({ status: 'revoked' }); if (failure === 'account') request.token = f.token({ claim: { googleAccountId: userId } });
    if (failure === 'machine') request.token = f.token({ machineToken: buildPlatformVerificationToken('other', secret) });
    if (failure === 'body') request.body = JSON.stringify(JSON.parse(exactBody)); if (failure === 'path') request.path = '/read-call';
    if (failure === 'missing-envelope') request.token = '';
    expect((await f.send(f.routes(), request)).status).toBe(503); expect(f.sent).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled();
  });
  it('keeps the replay ledger shared across producer instances', async () => {
    const f = await fixture(); const token = f.token();
    expect((await f.send(f.routes(), { token })).status).toBe(200); expect((await f.send(f.routes(), { token })).status).toBe(503);
    expect(f.sent).toHaveBeenCalledOnce();
  });
  it.each(['account', 'owner', 'consent', 'abort', 'expiry'] as const)('rechecks %s after admission before sending', async changed => {
    const f = await fixture(); const controller = new AbortController(); f.afterAdmit(async () => {
      if (changed === 'account') f.setAccount({ status: 'expired' }); if (changed === 'owner') f.setUser({ clerk_id: 'user_other' });
      if (changed === 'consent') await repository.revokeAccount(ownerId, accountId); if (changed === 'abort') controller.abort();
      if (changed === 'expiry') f.advance(30001);
    });
    expect((await f.send(f.routes(), { signal: controller.signal })).status).toBe(503); expect(f.sent).not.toHaveBeenCalled();
    expect(f.consume).toHaveBeenCalledOnce();
  });
  it('fails closed at construction when platform Google services are absent', async () => {
    const f = await fixture(); expect(() => createGoogleCollectionAdmissionForPlatform({ db: { ...f.integrationDb, googleData: undefined } as never,
      machineTokenForHandle: f.machineTokenForHandle })).toThrow('Integration service unavailable');
  });
  it.each(['throw', 'short-token'] as const)('normalizes %s token derivation failures without consuming or sending', async failure => {
    const f = await fixture(); f.machineTokenForHandle.mockImplementation(async () => {
      if (failure === 'throw') throw new Error('synthetic-private-platform-details'); return 'short';
    });
    const response = await f.send(f.routes()); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Integration service unavailable' });
    expect(f.consume).not.toHaveBeenCalled(); expect(f.sent).not.toHaveBeenCalled();
  });
  it('uses actual platform bearer + signed-owner middleware before admitting an internal request', async () => {
    const f = await fixture(); ({ db: platform } = await createTestPlatformDb());
    await insertContainer(platform, { handle: 'alice', clerkUserId: ownerId, port: 5001, shellPort: 6001, status: 'running' });
    const hook = createPlatformGoogleCollectionAdmission({ integrationDb: f.integrationDb as never, platformSecret: secret,
      createAdmission: createGoogleCollectionAdmissionForPlatform });
    const internal = f.routes(false, {}, hook); const app = new Hono();
    registerInternalIntegrationRoutes(app, { db: platform, platformSecret: secret, internalIntegrationRoutes: internal });
    const path = '/internal/containers/alice/integrations/call';
    const bearer = { authorization: `Bearer ${machineToken}` };
    for (const headers of [bearer, { ...bearer, 'x-platform-user-id': ownerId, 'x-platform-verified': 'forged' }]) {
      expect((await f.send(app, { path, headers })).status).toBeGreaterThanOrEqual(400); expect(f.sent).not.toHaveBeenCalled();
    }
    expect((await f.send(app, { path, headers: { ...bearer, 'x-platform-user-id': ownerId,
      'x-platform-verified': buildPlatformUserProof('alice', ownerId, secret) } })).status).toBe(200);
    expect(f.sent).toHaveBeenCalledOnce();
  });
});
