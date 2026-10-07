import { describe, expect, it, vi } from 'vitest';
import { createConfiguredPlatformGmail } from '../../packages/platform/src/native-gmail-startup.js';
import { isGmailOAuthCallback } from '../../packages/platform/src/integration-public-path.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
describe('platform native Gmail startup', () => {
  it('uses existing legacy client when disabled, without loading secrets', async () => {
    const loadModule = vi.fn(); const client = { listAccounts: vi.fn(), revokeAccount: vi.fn() };
    const result = await createConfiguredPlatformGmail({ db: {} as PlatformDB, integrationDb: { getUserById: vi.fn() }, legacy: client, env: {}, loadModule });
    expect(result.client).toBe(client); expect(loadModule).not.toHaveBeenCalled();
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
