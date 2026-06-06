import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  backfillClerkUsersToPlatformDb,
  buildPlatformUserFromClerkUser,
  getClerkUserHandleCandidates,
} from '../../packages/platform/src/clerk-users.js';
import {
  ensurePlatformUser,
  getPlatformUserByClerkId,
  insertUserMachine,
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

  it('avoids handles already owned by active machines during backfill', async () => {
    await insertUserMachine(db, {
      machineId: 'machine-existing',
      clerkUserId: 'user_existing',
      handle: 'neo',
      status: 'running',
      provisionedAt: new Date().toISOString(),
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
      handle: 'u-user-new',
      containerId: 'clerk:user_new',
    });
  });

  it('does not downgrade a provisioned runtime id during backfill', async () => {
    await ensurePlatformUser(db, {
      clerkId: 'user_existing',
      handle: 'neo',
      displayName: 'Provisioned Neo',
      email: 'neo@example.com',
      containerId: 'vps:machine-1',
    });

    await ensurePlatformUser(db, buildPlatformUserFromClerkUser({
      id: 'user_existing',
      username: 'neo',
      first_name: 'Neo',
      email_addresses: [{ id: 'email_1', email_address: 'neo@example.com' }],
    }, 'neo'));

    await expect(getPlatformUserByClerkId(db, 'user_existing')).resolves.toMatchObject({
      containerId: 'vps:machine-1',
      displayName: 'Neo',
    });
  });

  it('upgrades a backfilled placeholder runtime id after provisioning', async () => {
    await ensurePlatformUser(db, {
      clerkId: 'user_existing',
      handle: 'neo',
      displayName: 'Backfilled Neo',
      email: 'neo@example.com',
      containerId: 'clerk:user_existing',
    });

    await ensurePlatformUser(db, {
      clerkId: 'user_existing',
      handle: 'neo',
      displayName: 'Provisioned Neo',
      email: 'neo@example.com',
      containerId: 'vps:machine-1',
    });

    await expect(getPlatformUserByClerkId(db, 'user_existing')).resolves.toMatchObject({
      containerId: 'vps:machine-1',
      displayName: 'Provisioned Neo',
    });
  });

  it('preserves an existing container version during later Clerk sync', async () => {
    await ensurePlatformUser(db, {
      clerkId: 'user_existing',
      handle: 'neo',
      displayName: 'Provisioned Neo',
      email: 'neo@example.com',
      containerId: 'vps:machine-1',
      containerVersion: 'v2026.06.06',
    });

    await ensurePlatformUser(db, buildPlatformUserFromClerkUser({
      id: 'user_existing',
      username: 'neo',
      first_name: 'Neo',
      email_addresses: [{ id: 'email_1', email_address: 'neo@example.com' }],
    }, 'neo'));

    await expect(getPlatformUserByClerkId(db, 'user_existing')).resolves.toMatchObject({
      containerId: 'vps:machine-1',
      containerVersion: 'v2026.06.06',
    });
  });

  it('keeps the first platform handle stable on repeated Clerk sync', async () => {
    await ensurePlatformUser(db, {
      clerkId: 'user_existing',
      handle: 'neo',
      displayName: 'Original Neo',
      email: 'neo@example.com',
      containerId: 'clerk:user_existing',
    });

    await ensurePlatformUser(db, {
      clerkId: 'user_existing',
      handle: 'new-neo',
      displayName: 'Renamed Neo',
      email: 'new-neo@example.com',
      containerId: 'clerk:user_existing',
    });

    await expect(getPlatformUserByClerkId(db, 'user_existing')).resolves.toMatchObject({
      handle: 'neo',
      displayName: 'Renamed Neo',
      email: 'new-neo@example.com',
    });
  });
});
