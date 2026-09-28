import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { insertUserMachine, type NewUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  bootstrapPlatformOrganizationDatabase,
  type OrganizationPlatformDatabase,
} from '../../packages/platform/src/organizations/database.js';
import { createPrivatePreviewSweep } from '../../packages/platform/src/private-preview-sweep.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const org = 'org_internal';
const now = new Date('2026-09-30T00:00:00.000Z');

function preview(n: number, clerkUserId: string, provisionedAt: string): NewUserMachine {
  const handle = `pv-19${n}-0000000${n}`;
  return {
    machineId: `00000000-0000-4000-8000-00000000000${n}`,
    clerkUserId,
    handle,
    runtimeSlot: handle,
    provisioningClass: 'private-preview',
    sourcePr: 1900 + n,
    confirmedBundleVersion: `v2026.09.28-pr19${n}-1-1-abcdef0`,
    status: 'running',
    provisionedAt,
  };
}

describe('Private Preview sweep', () => {
  let db: PlatformDB;
  let deleted: string[];
  const service = { delete: vi.fn(async (machineId: string) => { deleted.push(machineId); return { machineId, status: 'deleted' }; }) };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    deleted = [];
    service.delete.mockClear();
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  async function seedMembers(members: Array<[string, 'active' | 'removed']>) {
    const kysely = db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformOrganizationDatabase(kysely);
    await sql`
      INSERT INTO organizations (organization_id, name, slug, ai_submission, lifecycle, source_updated_at, verified_at)
      VALUES (${org}, 'Internal', 'internal', 'owner_only', 'active', now(), now())
    `.execute(kysely);
    for (const [actorId, state] of members) {
      await sql`
        INSERT INTO organization_memberships (organization_id, actor_id, membership_id, role, state, membership_epoch, source_updated_at)
        VALUES (${org}, ${actorId}, ${`mem_${actorId}`}, 'org:member', ${state}, 1, now())
      `.execute(kysely);
    }
  }

  function sweep(internalOrganizationId: string | null = org) {
    return createPrivatePreviewSweep({ db, service, internalOrganizationId, now: () => now });
  }

  it('destroys expired machines and machines whose owner left the organization', async () => {
    await seedMembers([['user_active', 'active'], ['user_removed', 'removed']]);
    await insertUserMachine(db, preview(1, 'user_active', '2026-09-26T23:59:59.000Z'));
    await insertUserMachine(db, preview(2, 'user_removed', '2026-09-29T12:00:00.000Z'));
    await insertUserMachine(db, preview(3, 'user_active', '2026-09-29T12:00:00.000Z'));
    await insertUserMachine(db, preview(4, 'user_never_member', '2026-09-29T12:00:00.000Z'));

    await expect(sweep()()).resolves.toEqual({ checked: 4, destroyed: 3, failed: 0 });
    expect(deleted.sort()).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000004',
    ]);
  });

  it('only removes expired machines when membership cannot be read', async () => {
    await insertUserMachine(db, preview(1, 'user_active', '2026-09-26T00:00:00.000Z'));
    await insertUserMachine(db, preview(2, 'user_active', '2026-09-29T12:00:00.000Z'));

    // No organization projection tables exist: a read failure is not a lost membership.
    await expect(sweep()()).resolves.toEqual({ checked: 2, destroyed: 1, failed: 0 });
    expect(deleted).toEqual(['00000000-0000-4000-8000-000000000001']);
  });

  it('only removes expired machines when the organization is not configured', async () => {
    await seedMembers([]);
    await insertUserMachine(db, preview(1, 'user_active', '2026-09-26T00:00:00.000Z'));
    await insertUserMachine(db, preview(2, 'user_active', '2026-09-29T12:00:00.000Z'));

    await expect(sweep(null)()).resolves.toEqual({ checked: 2, destroyed: 1, failed: 0 });
  });

  it('keeps going when one destroy fails', async () => {
    await seedMembers([]);
    await insertUserMachine(db, preview(1, 'user_a', '2026-09-26T00:00:00.000Z'));
    await insertUserMachine(db, preview(2, 'user_b', '2026-09-26T00:00:00.000Z'));
    service.delete.mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await sweep()();
    expect(result).toEqual({ checked: 2, destroyed: 1, failed: 1 });
  });

  it('runs at most once per interval', async () => {
    await seedMembers([]);
    await insertUserMachine(db, preview(1, 'user_a', '2026-09-26T00:00:00.000Z'));
    const run = sweep();
    await expect(run()).resolves.toMatchObject({ destroyed: 1 });
    await expect(run()).resolves.toEqual({ checked: 0, destroyed: 0, failed: 0 });
    expect(service.delete).toHaveBeenCalledTimes(1);
  });

  it('ignores every other machine class', async () => {
    await seedMembers([]);
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000000009',
      clerkUserId: 'user_customer',
      handle: 'alice',
      status: 'running',
      provisionedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(sweep()()).resolves.toEqual({ checked: 0, destroyed: 0, failed: 0 });
  });
});
