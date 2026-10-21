import { describe, expect, it, vi } from 'vitest';
import { createConfiguredPlatformGmail } from '../../packages/platform/src/native-gmail-startup.js';
import { isGmailOAuthCallback } from '../../packages/platform/src/integration-public-path.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createNativeGmailRuntime } from '../../packages/gateway/src/integrations/native-gmail/runtime.js';
import { createPlatformDb as createIntegrationDb } from '../../packages/gateway/src/platform-db.js';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';
import type { PipedreamConnectClient } from '../../packages/gateway/src/integrations/pipedream.js';
import { GMAIL_SCOPE } from '../../packages/gateway/src/integrations/native-gmail/types.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
describe('platform native Gmail startup', () => {
  it('uses existing legacy client when disabled, without loading secrets', async () => {
    const loadModule = vi.fn(); const client = { listAccounts: vi.fn(), revokeAccount: vi.fn() };
    const result = await createConfiguredPlatformGmail({ db: {} as PlatformDB, integrationDb: { getUserById: vi.fn() }, legacy: client, env: {}, loadModule });
    expect(result.client).toBe(client); expect(loadModule).not.toHaveBeenCalled();
  });
  it('composes revocation-only startup after feature-off rollback and account deletion revokes the stored grant', async () => {
    const { db, instance } = await createTestPlatformDb();
    const integrationDb = createIntegrationDb({ dialect: instance.dialect });
    const env = { GMAIL_OAUTH_INTERNAL_CLERK_IDS: 'user_gmailcleanup', GMAIL_OAUTH_ENABLED: 'true', GMAIL_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com', GMAIL_OAUTH_CLIENT_SECRET: 'google-secret',
      GMAIL_OAUTH_CALLBACK_URL: 'https://app.matrix-os.com/api/integrations/gmail/oauth/callback', GMAIL_CREDENTIAL_ENCRYPTION_KEY: '12'.repeat(32),
      ACCOUNT_DELETION_SECRET: 'gmail-deletion-secret-at-least-32' };
    const legacy = { listAccounts: vi.fn(async () => []), revokeAccount: vi.fn() } as unknown as PipedreamConnectClient;
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh',
      expires_in: 3600, token_type: 'Bearer', scope: GMAIL_SCOPE }))).mockResolvedValueOnce(new Response(JSON.stringify({ emailAddress: 'owner@example.test' })))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', request);
    try {
      await integrationDb.migrate();
      const owner = await integrationDb.createUser({ clerkId: 'user_gmailcleanup', handle: 'gmail-cleanup', displayName: 'Owner',
        email: 'owner@example.test', containerId: 'gmail-cleanup', pipedreamExternalId: 'external-owner' });
      const enabled = createNativeGmailRuntime({ env, db: integrationDb, legacy });
      const url = new URL((await enabled.oauth!.start({ userId: owner.id, externalUserId: 'external-owner' })).url);
      const state = url.searchParams.get('state')!;
      const browser = await enabled.oauth!.authorization(state, { userId: owner.id });
      const connected = await enabled.oauth!.complete(state, 'code', browser.browserProof);
      const runtime = await createConfiguredPlatformGmail({ db, integrationDb, legacy, env: { ...env, GMAIL_OAUTH_ENABLED: 'false' },
        resolveUserId: async () => owner.id,
        loadModule: async () => ({ createNativeGmailRuntime: options => createNativeGmailRuntime({ ...options, db: integrationDb, legacy }) }) });
      expect(runtime.client).toBe(legacy);
      expect(runtime.oauth).toBeUndefined();
      expect(runtime.launchRoutes).toBeUndefined();
      expect(runtime.cleanup).toBeDefined();
      expect(Object.keys(runtime.cleanup!)).toEqual(['revoke']);
      const mismatched = await createConfiguredPlatformGmail({ db, integrationDb, legacy,
        env: { ...env, GMAIL_OAUTH_ENABLED: 'false', GMAIL_OAUTH_CLIENT_ID: 'wrong-client.apps.googleusercontent.com' },
        loadModule: async () => ({ createNativeGmailRuntime: options => createNativeGmailRuntime({ ...options, db: integrationDb, legacy }) }) });
      await expect(createAccountDeletionAdapters({ db, clerkSecretKey: 'key', r2PrefixRoot: 'sync', pipedream: legacy, nativeGmail: mismatched.cleanup })
        .integrations({ clerkUserId: 'user_gmailcleanup', appleTokens: [] })).rejects.toThrow('Gmail connection unavailable');
      expect(await integrationDb.getConnectedService(connected.connectionId)).not.toBeNull();
      expect(request).toHaveBeenCalledTimes(2);
      // Cleanup remains permitted after deletion admission has already stopped new consent.
      const repository = new AccountDeletionRepository(db.kysely, { secret: env.ACCOUNT_DELETION_SECRET });
      await repository.accept({ clerkUserId: 'user_gmailcleanup', appleTokens: [] }, false);
      await createAccountDeletionAdapters({ db, clerkSecretKey: 'key', r2PrefixRoot: 'sync', pipedream: legacy, nativeGmail: runtime.cleanup })
        .integrations({ clerkUserId: 'user_gmailcleanup', appleTokens: [] });
      expect(await integrationDb.getConnectedService(connected.connectionId)).toBeNull();
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2][0]).toBe('https://oauth2.googleapis.com/revoke');
      expect(legacy.revokeAccount).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      // Both wrappers share the fixture driver; close the single PGlite resource once.
      await integrationDb.destroy();
    }
  });

  it('wires immutable consent owner admission and fails when the owner is gone', async () => {
    let admit!: (id: string, persist: () => Promise<void>) => Promise<void>;
    const loadModule = vi.fn(async () => ({ createNativeGmailRuntime: (opts: { admit: typeof admit }) => { admit = opts.admit; return { client: {}, oauth: {} }; } }));
    await createConfiguredPlatformGmail({ db: {} as PlatformDB, integrationDb: { getUserById: async () => null }, legacy: {} as any, env: { GMAIL_OAUTH_ENABLED: 'true' }, loadModule: loadModule as any });
    const persist = vi.fn(); await expect(admit('owner', persist)).rejects.toThrow('Connection owner unavailable'); expect(persist).not.toHaveBeenCalled();
  });
  it('only opens the exact GET callback to stored consent authorization', () => {
    expect(isGmailOAuthCallback('GET', '/api/integrations/gmail/oauth/callback')).toBe(true);
    for (const [method, path] of [['POST', '/api/integrations/gmail/oauth/callback'], ['GET', '/api/integrations/gmail/oauth/callback/extra'], ['GET', '/api/integrations/connect']]) expect(isGmailOAuthCallback(method!, path!)).toBe(false);
  });
  it('refuses a late consent write after deletion acceptance, and permits it after cancellation', async () => {
    const { db } = await createTestPlatformDb();
    const secret = 'gmail-admission-secret-at-least-32';
    try {
      let admit!: (id: string, persist: () => Promise<void>) => Promise<void>;
      await createConfiguredPlatformGmail({ db, integrationDb: { getUserById: async () => ({ clerk_id: 'user_gmail' }) },
        legacy: {} as any, env: { GMAIL_OAUTH_ENABLED: 'true', ACCOUNT_DELETION_SECRET: secret },
        loadModule: async () => ({ createNativeGmailRuntime: (options) => { admit = options.admit; return { client: {} as any }; } }) });
      const persist = vi.fn(async () => undefined);
      await admit('immutable-owner', persist);
      const repository = new AccountDeletionRepository(db.kysely, { secret });
      await repository.accept({ clerkUserId: 'user_gmail', appleTokens: [] }, false);
      await expect(admit('immutable-owner', persist)).rejects.toThrow('Connection unavailable');
      expect(persist).toHaveBeenCalledTimes(1);
      await db.executor.updateTable('account_deletion_jobs').set({ status: 'cancelled' }).execute();
      await admit('immutable-owner', persist);
      expect(persist).toHaveBeenCalledTimes(2);
    } finally { await destroyTestPlatformDb(db); }
  });
});
