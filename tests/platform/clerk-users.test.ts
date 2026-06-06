import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  backfillClerkUsersToPlatformDb,
  buildPlatformUserFromClerkUser,
  getClerkUserHandleCandidates,
} from '../../packages/platform/src/clerk-users.js';
import {
  ensurePlatformUser,
  getPlatformUserByClerkId,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

describe('clerk user sync', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('derives valid stable platform user fields from Clerk profiles', () => {
    const user = {
      id: 'user_2abcDEF',
      username: null,
      first_name: 'Ada',
      last_name: 'Lovelace',
      primary_email_address_id: 'email_primary',
      email_addresses: [
        { id: 'email_secondary', email_address: 'other@example.com' },
        { id: 'email_primary', email_address: 'Ada.Lovelace@example.com' },
      ],
    };

    expect(getClerkUserHandleCandidates(user)).toEqual([
      'ada-lovelace',
      'other',
      'u-user-2abcdef',
    ]);
    expect(buildPlatformUserFromClerkUser(user, 'ada-lovelace')).toMatchObject({
      clerkId: 'user_2abcDEF',
      handle: 'ada-lovelace',
      displayName: 'Ada Lovelace',
      email: 'Ada.Lovelace@example.com',
      containerId: 'clerk:user_2abcDEF',
    });
  });

  it('dry-runs Clerk backfill without writing rows', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([
        {
          id: 'user_new',
          username: 'neo',
          email_addresses: [{ id: 'email_1', email_address: 'neo@example.com' }],
        },
      ]), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const result = await backfillClerkUsersToPlatformDb(db, {
      clerkSecretKey: 'sk_test',
      apply: false,
      fetchFn,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ scanned: 1, synced: 1, skipped: 0 });
    await expect(getPlatformUserByClerkId(db, 'user_new')).resolves.toBeUndefined();
  });

  it('applies Clerk backfill idempotently and avoids handle collisions', async () => {
    await ensurePlatformUser(db, {
      clerkId: 'user_existing',
      handle: 'neo',
      displayName: 'Existing Neo',
      email: 'existing@example.com',
      containerId: 'clerk:user_existing',
    });
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([
        {
          id: 'user_new',
          username: 'neo',
          first_name: 'New',
          last_name: 'User',
          email_addresses: [{ id: 'email_1', email_address: 'neo@example.com' }],
        },
      ]), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const result = await backfillClerkUsersToPlatformDb(db, {
      clerkSecretKey: 'sk_test',
      apply: true,
      fetchFn,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ scanned: 1, synced: 1, skipped: 0 });
    await expect(getPlatformUserByClerkId(db, 'user_new')).resolves.toMatchObject({
      clerkId: 'user_new',
      handle: 'u-user-new',
      displayName: 'New User',
      email: 'neo@example.com',
      containerId: 'clerk:user_new',
    });
  });
});
