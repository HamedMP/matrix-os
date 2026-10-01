import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { createApp } from '../../packages/platform/src/main.js';
import type { CustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import {
  insertUserMachine,
  type NewUserMachine,
  type PlatformDB,
  upsertHostBundleRelease,
} from '../../packages/platform/src/db.js';
import {
  bootstrapPlatformOrganizationDatabase,
  type OrganizationPlatformDatabase,
} from '../../packages/platform/src/organizations/database.js';
import { createOrganizationMembershipProjection } from '../../packages/platform/src/organizations/projection.js';
import { PlatformOrganizationRepository } from '../../packages/platform/src/organizations/repository.js';
import { membershipCheckFromProjection } from '../../packages/platform/src/private-preview-access.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { JWT_SECRET, stubOrchestrator } from './proxy-routing-test-utils.js';

const secret = 'platform-secret-123';
const org = 'org_internal';
const member = 'user_member';
const outsider = 'user_outsider';
const version = 'v2026.09.28-pr1907-1-1-abcdef0';
const machineId = '00000000-0000-4000-8000-000000001907';

function privatePreview(overrides: Partial<NewUserMachine> = {}): NewUserMachine {
  return {
    machineId,
    clerkUserId: member,
    handle: 'pv-1907-3fa91c2e',
    runtimeSlot: 'pv-1907-3fa91c2e',
    provisioningClass: 'private-preview',
    sourcePr: 1907,
    confirmedBundleVersion: version,
    status: 'running',
    provisionedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('Private Preview routes', () => {
  let db: PlatformDB;
  let service: {
    startPrivatePreview: ReturnType<typeof vi.fn>;
    updatePrivatePreview: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
    ({ db } = await createTestPlatformDb());
    service = {
      startPrivatePreview: vi.fn(async () => ({ machineId, handle: 'pv-1907-3fa91c2e', status: 'provisioning', etaSeconds: 300 })),
      updatePrivatePreview: vi.fn(async () => ({ machineId, status: 'updating' })),
      delete: vi.fn(async () => ({ machineId, status: 'deleted' })),
    };
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  async function seedMembership(
    actorId: string,
    state: 'active' | 'removed' = 'active',
    lifecycle: 'active' | 'deleted' = 'active',
    verifiedSecondsAgo = 0,
  ) {
    const kysely = db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformOrganizationDatabase(kysely);
    // The organization and its membership are related writes: seed them together.
    await kysely.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO organizations (organization_id, name, slug, ai_submission, lifecycle, source_updated_at, verified_at)
        VALUES (${org}, 'Internal', 'internal', 'owner_only', ${lifecycle}, now(), now() - make_interval(secs => ${verifiedSecondsAgo}))
        ON CONFLICT (organization_id) DO UPDATE SET lifecycle = EXCLUDED.lifecycle, verified_at = EXCLUDED.verified_at
      `.execute(trx);
      await sql`
        INSERT INTO organization_memberships (organization_id, actor_id, membership_id, role, state, membership_epoch, source_updated_at)
        VALUES (${org}, ${actorId}, ${`mem_${actorId}`}, 'org:member', ${state}, 1, now())
      `.execute(trx);
    });
  }

  // The real projection: it requires recent Clerk verification of the organization.
  function membership() {
    const repository = new PlatformOrganizationRepository(db.kysely as unknown as Kysely<OrganizationPlatformDatabase>);
    return membershipCheckFromProjection(createOrganizationMembershipProjection({ repository, startTimers: false }));
  }

  function app(orgId: string | null = org, withProjection = true) {
    return createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: secret,
      customerVpsService: service as unknown as CustomerVpsService,
      ...(withProjection ? { privatePreviewMembership: membership() } : {}),
      env: { ...process.env, MATRIX_INTERNAL_CLERK_ORG_ID: orgId ?? undefined },
    });
  }

  async function auth(actor: string) {
    const token = (await issueSyncJwt({
      secret: JWT_SECRET, clerkUserId: actor, handle: actor.replace('user_', ''), gatewayUrl: 'https://app.matrix-os.com',
    })).token;
    return { host: 'app.matrix-os.com', authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  }

  function post(path: string, headers: Record<string, string>, body: unknown) {
    return app().request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  it('fails closed when the internal organization is not configured', async () => {
    await seedMembership(member);
    const res = await app(null).request('/api/private-previews', { headers: await auth(member) });
    expect(res.status).toBe(503);
  });

  it('requires an authenticated actor', async () => {
    const res = await app().request('/api/private-previews', { headers: { host: 'app.matrix-os.com' } });
    expect(res.status).toBe(401);
  });

  it('fails closed when no organization projection is configured', async () => {
    await seedMembership(member);
    const res = await app(org, false).request('/api/private-previews', { headers: await auth(member) });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Private Preview unavailable' });
  });

  it('fails closed when the organization projection cannot be read', async () => {
    const res = await app().request('/api/private-previews', { headers: await auth(member) });
    expect(res.status).toBe(503);
  });

  it.each([
    ['a non-member', async () => seedMembership(outsider)],
    ['a removed member', async () => seedMembership(member, 'removed')],
    ['a member of a deleted organization', async () => seedMembership(member, 'active', 'deleted')],
    ['a member whose organization Clerk has not verified recently', async () => seedMembership(member, 'active', 'active', 300)],
  ])('gives %s the same generic 403 on every member route', async (_label, setup) => {
    await setup();
    const headers = await auth(member);
    for (const res of [
      await app().request('/api/private-previews', { headers }),
      await app().request('/api/private-previews/bundles?pr=1907', { headers }),
      await post('/api/private-previews', headers, { pr: 1907, bundleVersion: version }),
      await post(`/api/private-previews/${machineId}/deploy`, headers, { bundleVersion: version }),
    ]) {
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'Forbidden' });
    }
    expect(service.startPrivatePreview).not.toHaveBeenCalled();
    expect(service.updatePrivatePreview).not.toHaveBeenCalled();
  });

  it('shows a member the newest bundle for a PR', async () => {
    await seedMembership(member);
    await upsertHostBundleRelease(db, {
      version, gitCommit: 'c1598218', buildTime: '2026-09-28T00:00:00.000Z',
      bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`, sha256: 'a'.repeat(64), size: 1234,
      sourcePr: 1907, sourceAuthor: 'octo-dev',
    });
    const headers = await auth(member);
    const res = await app().request('/api/private-previews/bundles?pr=1907', { headers });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ pr: 1907, version, gitCommit: 'c1598218', author: 'octo-dev' });
    expect((await app().request('/api/private-previews/bundles?pr=1908', { headers })).status).toBe(404);
    for (const pr of ['0', 'abc', '1000000000', '']) {
      expect((await app().request(`/api/private-previews/bundles?pr=${pr}`, { headers })).status, pr).toBe(400);
    }
  });

  it('starts a Private Preview for the authenticated member', async () => {
    await seedMembership(member);
    const res = await post('/api/private-previews', await auth(member), { pr: 1907, bundleVersion: version });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ machineId, handle: 'pv-1907-3fa91c2e', status: 'provisioning' });
    expect(service.startPrivatePreview).toHaveBeenCalledWith(
      { clerkUserId: member, sourcePr: 1907, bundleVersion: version },
      { dispatch: 'detached' },
    );
  });

  it('validates start and update bodies at the route boundary', async () => {
    await seedMembership(member);
    const headers = await auth(member);
    for (const body of [{ pr: 1907 }, { pr: -1, bundleVersion: version }, { pr: 1907, bundleVersion: '../x' }, { pr: 1907, bundleVersion: version, clerkUserId: outsider }]) {
      expect((await post('/api/private-previews', headers, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post('/api/private-previews/not-a-uuid/deploy', headers, { bundleVersion: version })).status).toBe(400);
    const oversized = await post('/api/private-previews', headers, { pr: 1907, bundleVersion: version, pad: 'x'.repeat(2048) });
    expect(oversized.status).toBe(413);
  });

  it('maps service failures to safe responses', async () => {
    await seedMembership(member);
    const headers = await auth(member);
    service.startPrivatePreview.mockRejectedValueOnce(new CustomerVpsError(429, 'quota_exceeded', 'Private Preview capacity unavailable'));
    const quota = await post('/api/private-previews', headers, { pr: 1907, bundleVersion: version });
    expect(quota.status).toBe(429);
    await expect(quota.json()).resolves.toEqual({ error: 'Private Preview capacity unavailable' });

    service.startPrivatePreview.mockRejectedValueOnce(new Error('hetzner said: token=secret-value'));
    const failed = await post('/api/private-previews', headers, { pr: 1907, bundleVersion: version });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('secret-value');
  });

  it('updates only through the owner route with the authenticated actor', async () => {
    await seedMembership(member);
    const res = await post(`/api/private-previews/${machineId}/deploy`, await auth(member), { bundleVersion: version });
    expect(res.status).toBe(202);
    expect(service.updatePrivatePreview).toHaveBeenCalledWith({ clerkUserId: member, machineId, bundleVersion: version });
  });

  it('lists only the member\'s own Private Previews', async () => {
    await seedMembership(member);
    await insertUserMachine(db, privatePreview());
    await insertUserMachine(db, privatePreview({
      machineId: '00000000-0000-4000-8000-000000001908', clerkUserId: outsider,
      handle: 'pv-1907-0badf00d', runtimeSlot: 'pv-1907-0badf00d',
    }));
    const res = await app().request('/api/private-previews', { headers: await auth(member) });
    expect(res.status).toBe(200);
    const body = await res.json() as { privatePreviews: Array<Record<string, unknown>> };
    expect(body.privatePreviews).toHaveLength(1);
    expect(body.privatePreviews[0]).toMatchObject({
      machineId, handle: 'pv-1907-3fa91c2e', pr: 1907, confirmedBundleVersion: version, status: 'running',
      expiresAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('lets an owner destroy their own machine, even after losing membership', async () => {
    await seedMembership(member, 'removed');
    await insertUserMachine(db, privatePreview());
    const del = (actor: string) => auth(actor).then((headers) =>
      app().request(`/api/private-previews/${machineId}`, { method: 'DELETE', headers }));

    expect((await del(outsider)).status).toBe(404);
    expect(service.delete).not.toHaveBeenCalled();
    expect((await del(member)).status).toBe(202);
    expect(service.delete).toHaveBeenCalledWith(machineId);
  });

  it('tears down every Private Preview for a closed PR with the platform secret', async () => {
    await insertUserMachine(db, privatePreview());
    await insertUserMachine(db, privatePreview({
      machineId: '00000000-0000-4000-8000-000000001908', clerkUserId: outsider,
      handle: 'pv-1907-0badf00d', runtimeSlot: 'pv-1907-0badf00d',
    }));
    const teardown = (authorization?: string) => app().request('/vps/private-previews?pr=1907', {
      method: 'DELETE', headers: authorization ? { authorization } : {},
    });

    expect((await teardown()).status).toBe(401);
    expect((await teardown('Bearer wrong')).status).toBe(401);
    const res = await teardown(`Bearer ${secret}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ destroyed: 2, failed: 0 });
    expect(service.delete).toHaveBeenCalledTimes(2);
  });

  it('pages through more than one batch and still ends when a destroy fails', async () => {
    for (let n = 0; n < 55; n += 1) {
      const suffix = n.toString(16).padStart(8, '0');
      await insertUserMachine(db, privatePreview({
        machineId: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
        clerkUserId: `user_engineer${n}`,
        handle: `pv-1907-${suffix}`,
        runtimeSlot: `pv-1907-${suffix}`,
      }));
    }
    // Deletes are recorded but the rows stay active, as when provider deletion lags.
    service.delete.mockImplementation(async (id: string) => {
      if (id.endsWith('000000000007')) throw new Error('provider unavailable');
      return { machineId: id, status: 'deleted' };
    });
    const res = await app().request('/vps/private-previews?pr=1907', {
      method: 'DELETE', headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ destroyed: 54, failed: 1 });
    expect(service.delete).toHaveBeenCalledTimes(55);
  });
});
