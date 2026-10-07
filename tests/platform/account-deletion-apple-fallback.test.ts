import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from './platform-db-test-helper.js';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';
import { createAccountDeletionService } from '../../packages/platform/src/account-deletion/service.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { ACCOUNT_DELETION_GRACE_MS } from '../../packages/platform/src/account-deletion/types.js';

const secret = 'apple-deletion-fallback-secret-at-least-32-bytes';
const apple = { teamId: 'PX4JL74Y2K', keyId: 'ABCDEF1234', serviceId: 'web.matrix', nativeClientId: 'com.matrixos.mobile',
  privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
function nativeMetadata(owner: string) {
  const key = createHash('sha256').update('matrix-native-apple\0').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(owner));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ clientId: apple.nativeClientId,
    token: 'native-refresh', tokenType: 'refresh_token' })), cipher.final()]);
  return { matrix_native_apple_credential: Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url') };
}
describe('Apple fallback through deletion adapters and durable job', () => {
  let fixture: TestPlatformDb;
  beforeAll(async () => { fixture = await createTestPlatformDb(); });
  afterAll(async () => { await destroyTestPlatformDb(fixture?.db); });
  function adapters(options: { tokens?: unknown; metadata?: Record<string, unknown>; tokenStatus?: number;
    userStatus?: number; override?: typeof fetch; configured?: boolean; appleConfig?: typeof apple } = {}) {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (options.override) return options.override(url, init);
      const path = String(url);
      if (path.endsWith('/auth/revoke')) return new Response(null, { status: 200 });
      if (path.includes('organization_memberships')) return Response.json({ data: [], total_count: 0 });
      if (path.includes('oauth_access_tokens')) return Response.json(options.tokens ??
        [{ external_account_id: 'e1', token: 'opaque-web' }], { status: options.tokenStatus ?? 200 });
      return options.userStatus ? new Response(null, { status: options.userStatus }) : Response.json({
        external_accounts: [{ id: 'e1', provider: 'oauth_apple' }], private_metadata: options.metadata ?? {},
      });
    });
    return { request, value: createAccountDeletionAdapters({ db: fixture.db, clerkSecretKey: 'clerk',
      r2PrefixRoot: 'matrixos-sync', apple: options.configured === false ? undefined : options.appleConfig ?? apple, credentialSecret: secret, fetch: request }) };
  }

  it('schedules opaque web users, exposes manual instructions in status and still completes erasure', async () => {
    const owner = 'user_applewebfallback';
    const remote = adapters();
    const prepared = await remote.value.prepare(owner);
    expect(prepared).toMatchObject({ appleTokens: [], manualAppleRevocationRequired: true });
    let clock = new Date('2026-10-05T12:00:00.000Z');
    const billing = vi.fn(async () => {});
    const clerk = vi.fn(async () => {});
    const service = createAccountDeletionService({ db: fixture.db.kysely, secret, now: () => clock,
      adapters: { ...remote.value, billing, vps: vi.fn(async () => {}), integrations: vi.fn(async () => {}),
        storage: vi.fn(async () => {}), data: vi.fn(async () => {}), clerk }, logError: vi.fn() });
    expect(await service.schedule(owner)).toMatchObject({ status: 'scheduled', billingStopped: true,
      manualAppleRevocationRequired: true });
    expect(await service.get(owner)).toMatchObject({ manualAppleRevocationRequired: true });
    const repository = new AccountDeletionRepository(fixture.db.kysely, { secret, now: () => clock });
    expect(repository.decrypt((await repository.get(owner))!)).toMatchObject({ manualAppleRevocationRequired: true });
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS);
    await service.reconcile();
    expect(await service.get(owner)).toMatchObject({ status: 'completed' });
    expect(clerk).toHaveBeenCalledOnce();
    expect((await repository.get(owner))?.encrypted_context).toBeNull();
    expect(remote.request.mock.calls.some(([url]) => String(url).endsWith('/auth/revoke'))).toBe(false);
  });

  it('preserves automatic native refresh-token revocation when Clerk has no OAuth grants', async () => {
    const owner = 'user_applenativefallback';
    const remote = adapters({ tokens: [], metadata: nativeMetadata(owner) });
    const context = await remote.value.prepare(owner);
    expect(context.appleTokens).toEqual([{ clientId: apple.nativeClientId, token: 'native-refresh', tokenType: 'refresh_token' }]);
    expect(context).not.toMatchObject({ manualAppleRevocationRequired: true });
    const prepared = await remote.value.prepareAppleRevocation!(context);
    await remote.value.apple(prepared);
    const revoke = remote.request.mock.calls.find(([url]) => String(url).endsWith('/auth/revoke'))!;
    expect(new URLSearchParams(String(revoke[1]?.body)).get('client_id')).toBe(apple.nativeClientId);
  });

  it('converts legacy unknown Apple evidence into manual fallback instead of retaining the account forever', async () => {
    const remote = adapters();
    const prepared = await remote.value.prepareAppleRevocation!({ clerkUserId: 'user_legacyapple',
      appleTokens: [], appleRevocationUnknown: true });
    expect(prepared).toMatchObject({ manualAppleRevocationRequired: true, appleRevocationPrepared: true });
    await expect(remote.value.apple(prepared)).resolves.toBeUndefined();
    expect(remote.request).not.toHaveBeenCalled();
  });

  it('recognizes an already-deleted Clerk identity as manual fallback', async () => {
    const remote = adapters({ userStatus: 404 });
    const context = await remote.value.prepare('user_missingapple', true);
    expect(context).toMatchObject({ appleTokens: [], manualAppleRevocationRequired: true });
  });

  it('degrades an expired or missing current web credential to manual fallback at erasure time', async () => {
    const remote = adapters();
    const context = await remote.value.prepareAppleRevocation!({ clerkUserId: 'user_oldapple',
      appleTokens: [{ clientId: apple.serviceId, token: 'old-web', tokenType: 'access_token' }] });
    expect(context).toMatchObject({ appleTokens: [], manualAppleRevocationRequired: true, appleRevocationPrepared: true });
    await expect(remote.value.apple(context)).resolves.toBeUndefined();
  });

  it('continues a scheduled web deletion when Clerk identity disappears before grant refresh', async () => {
    const remote = adapters({ userStatus: 404 });
    const prepared = await remote.value.prepareAppleRevocation!({ clerkUserId: 'user_appledisappeared',
      appleTokens: [{ clientId: apple.serviceId, token: 'cached-web', tokenType: 'access_token' }] });
    expect(prepared).toMatchObject({ appleTokens: [], manualAppleRevocationRequired: true, appleRevocationPrepared: true });
    await expect(remote.value.apple(prepared)).resolves.toBeUndefined();
    expect(remote.request.mock.calls.some(([url]) => String(url).includes('oauth_access_tokens'))).toBe(false);
  });

  it('does not downgrade a token endpoint outage or missing configuration into manual fallback', async () => {
    const remote = adapters({ tokenStatus: 503 });
    const billing = vi.fn(async () => {});
    const service = createAccountDeletionService({ db: fixture.db.kysely, secret,
      adapters: { ...remote.value, billing }, logError: vi.fn() });
    await expect(service.schedule('user_appleoutage')).rejects.toThrow('Identity cleanup unavailable');
    expect(billing).not.toHaveBeenCalled();
    expect(await service.get('user_appleoutage')).toMatchObject({ status: 'none' });
    await expect(adapters({ configured: false }).value.prepare('user_appleconfig')).rejects
      .toThrow('Apple revocation configuration unavailable');
  });

  it('rejects missing or malformed signing keys even when the opaque web token would use manual fallback', async () => {
    for (const privateKey of ['', 'invalid signing key']) {
      await expect(adapters({ appleConfig: { ...apple, privateKey } }).value.prepare('user_appleinvalidkey'))
        .rejects.toThrow();
    }
  });

  it('keeps Apple key discovery outages as preflight errors before billing or account acceptance', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'apple-key' })
      .setIssuer('https://appleid.apple.com').setAudience(apple.serviceId).setIssuedAt().setExpirationTime('1h').sign(privateKey);
    const remote = adapters({ override: async (url) => {
      const path = String(url);
      if (path.endsWith('/auth/keys')) return new Response(null, { status: 503 });
      if (path.includes('organization_memberships')) return Response.json({ data: [], total_count: 0 });
      if (path.includes('oauth_access_tokens')) return Response.json([{ token: 'opaque', external_account_id: 'e1',
        id_token: idToken, expires_at: Date.now() + 60_000 }]);
      return Response.json({ external_accounts: [{ id: 'e1', provider: 'oauth_apple' }], private_metadata: {} });
    } });
    const billing = vi.fn(async () => {});
    const service = createAccountDeletionService({ db: fixture.db.kysely, secret,
      adapters: { ...remote.value, billing }, logError: vi.fn() });
    await expect(service.schedule('user_applekeyoutage')).rejects.toThrow();
    expect(billing).not.toHaveBeenCalled();
    expect(await service.get('user_applekeyoutage')).toMatchObject({ status: 'none' });
  });
});
