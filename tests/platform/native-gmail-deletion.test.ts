import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';
const userId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
describe('native Gmail account deletion inventory', () => {
  it.each(['active', 'expired', 'revoked'])('revokes remaining grants for a %s entry before erasure', async status => {
    const { db } = await createTestPlatformDb();
    try {
      await sql`INSERT INTO users (id,clerk_id,handle,display_name,email,container_id,pipedream_external_id)
        VALUES (${userId},'user_gmail','gmail','Gmail','owner@example.test','gmail','external-owner')`.execute(db.executor);
      await sql`CREATE TABLE connected_services (id UUID PRIMARY KEY,user_id UUID,pipedream_account_id TEXT,status TEXT)`.execute(db.executor);
      await sql`INSERT INTO connected_services VALUES (${connectionId},${userId},'gmail_33333333-3333-4333-8333-333333333333',${status})`.execute(db.executor);
      const revoke = vi.fn(async () => true);
      const pipedream = { listAccounts: vi.fn(async () => []), revokeAccount: vi.fn(async () => undefined) };
      await createAccountDeletionAdapters({ db, clerkSecretKey: 'key', r2PrefixRoot: 'sync', nativeGmail: { revoke }, pipedream })
        .integrations({ clerkUserId: 'user_gmail', appleTokens: [] });
      expect(revoke).toHaveBeenCalledExactlyOnceWith({ userId, connectionId });
      expect(pipedream.revokeAccount).not.toHaveBeenCalled();
    } finally { await destroyTestPlatformDb(db); }
  });
  it('fails closed without native revocation or when Google revocation fails', async () => {
    const { db } = await createTestPlatformDb();
    try {
      await sql`INSERT INTO users (id,clerk_id,handle,display_name,email,container_id)
        VALUES (${userId},'user_gmail','gmail','Gmail','owner@example.test','gmail')`.execute(db.executor);
      await sql`CREATE TABLE connected_services (id UUID PRIMARY KEY,user_id UUID,pipedream_account_id TEXT,status TEXT)`.execute(db.executor);
      await sql`INSERT INTO connected_services VALUES (${connectionId},${userId},'gmail_33333333-3333-4333-8333-333333333333','expired')`.execute(db.executor);
      const options = { db, clerkSecretKey: 'key', r2PrefixRoot: 'sync' };
      const context = { clerkUserId: 'user_gmail', appleTokens: [] };
      await expect(createAccountDeletionAdapters(options).integrations(context)).rejects.toThrow('Gmail cleanup configuration unavailable');
      await expect(createAccountDeletionAdapters({ ...options, nativeGmail: { revoke: async () => false } }).integrations(context)).rejects.toThrow('Gmail cleanup unavailable');
      expect((await sql`SELECT status FROM connected_services`.execute(db.executor)).rows).toEqual([{ status: 'expired' }]);
    } finally { await destroyTestPlatformDb(db); }
  });
});
