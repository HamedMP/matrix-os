import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertUserMachine, type NewUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { resolveCustomMcpUserIdForMachine } from '../../packages/platform/src/custom-mcp-route-registration.js';
import {
  bootstrapPlatformOrganizationDatabase,
  type OrganizationPlatformDatabase,
} from '../../packages/platform/src/organizations/database.js';
import { createOrganizationMembershipProjection } from '../../packages/platform/src/organizations/projection.js';
import { PlatformOrganizationRepository } from '../../packages/platform/src/organizations/repository.js';
import { membershipCheckFromProjection } from '../../packages/platform/src/private-preview-access.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

const secret = 'platform-secret-123';
const org = 'org_internal';
const owner = 'user_owner';
const handle = 'pv-1907-3fa91c2e';

function bearer(value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function signedFor(actorId: string) {
  return {
    authorization: `Bearer ${bearer(handle)}`,
    'x-platform-user-id': actorId,
    'x-platform-verified': createHmac('sha256', bearer(handle)).update(actorId).digest('hex'),
  };
}

function privatePreview(overrides: Partial<NewUserMachine> = {}): NewUserMachine {
  return {
    machineId: '00000000-0000-4000-8000-000000001907',
    clerkUserId: owner,
    handle,
    runtimeSlot: handle,
    provisioningClass: 'private-preview',
    sourcePr: 1907,
    confirmedBundleVersion: 'v2026.09.28-pr1907-1-1-abcdef0',
    status: 'running',
    provisionedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('Private Preview personal accounts (spec 537 P5)', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  async function seedOrg(members: Array<[string, 'active' | 'removed']>, verifiedSecondsAgo = 0) {
    const kysely = db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformOrganizationDatabase(kysely);
    // The organization and its memberships are related writes: seed them together.
    await kysely.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO organizations (organization_id, name, slug, ai_submission, lifecycle, source_updated_at, verified_at)
        VALUES (${org}, 'Internal', 'internal', 'owner_only', 'active', now(), now() - make_interval(secs => ${verifiedSecondsAgo}))
      `.execute(trx);
      for (const [actorId, state] of members) {
        await sql`
          INSERT INTO organization_memberships (organization_id, actor_id, membership_id, role, state, membership_epoch, source_updated_at)
          VALUES (${org}, ${actorId}, ${`mem_${actorId}`}, 'org:member', ${state}, 1, now())
        `.execute(trx);
      }
    });
  }

  function app(options: { projection?: boolean; orgId?: string } = {}) {
    const probe = new Hono();
    probe.get('/probe', (c) => c.json({ actorId: c.get('internalContainerClerkUserId') }));
    probe.get('/', (c) => c.json({ actorId: c.get('internalContainerClerkUserId') }));
    const repository = new PlatformOrganizationRepository(db.kysely as unknown as Kysely<OrganizationPlatformDatabase>);
    return createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: secret,
      internalIntegrationRoutes: probe,
      internalCustomMcpRoutes: probe,
      ...(options.projection === false ? {} : {
        privatePreviewMembership: membershipCheckFromProjection(
          createOrganizationMembershipProjection({ repository, startTimers: false }),
        ),
      }),
      env: { ...process.env, MATRIX_INTERNAL_CLERK_ORG_ID: options.orgId ?? org },
    });
  }

  const integrations = (headers: Record<string, string>, a = app()) =>
    a.request(`/internal/containers/${handle}/integrations/probe`, { headers });
  const customMcp = (headers: Record<string, string>, a = app()) =>
    a.request(`/internal/containers/${handle}/mcp-servers`, { headers });

  it('acts for the owner of an eligible Private Preview', async () => {
    await seedOrg([[owner, 'active']]);
    await insertUserMachine(db, privatePreview());

    const byBearer = await integrations({ authorization: `Bearer ${bearer(handle)}` });
    expect(byBearer.status).toBe(200);
    await expect(byBearer.json()).resolves.toEqual({ actorId: owner });
    expect((await integrations(signedFor(owner))).status).toBe(200);

    const mcp = await customMcp({ authorization: `Bearer ${bearer(handle)}` });
    expect(mcp.status).toBe(200);
    await expect(mcp.json()).resolves.toEqual({ actorId: owner });
  });

  it('never acts for anyone but the owner', async () => {
    await seedOrg([[owner, 'active'], ['user_other', 'active']]);
    await insertUserMachine(db, privatePreview());

    expect((await integrations(signedFor('user_other'))).status).toBe(403);
    expect((await customMcp(signedFor('user_other'))).status).toBe(403);
    expect((await customMcp(signedFor(owner))).status).toBe(200);
    // Only single-user customer machines accept the legacy unsigned owner header.
    expect((await integrations({ authorization: `Bearer ${bearer(handle)}`, 'x-platform-user-id': owner })).status).toBe(401);
  });

  it.each([
    ['the owner left the organization', async () => {
      await seedOrg([[owner, 'removed']]);
      await insertUserMachine(db, privatePreview());
    }],
    ['Clerk has not verified the organization recently', async () => {
      await seedOrg([[owner, 'active']], 300);
      await insertUserMachine(db, privatePreview());
    }],
    ['the machine expired', async () => {
      await seedOrg([[owner, 'active']]);
      await insertUserMachine(db, privatePreview({ provisionedAt: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString() }));
    }],
    ['the machine is not running', async () => {
      await seedOrg([[owner, 'active']]);
      await insertUserMachine(db, privatePreview({ status: 'provisioning' }));
    }],
  ])('denies personal accounts when %s', async (_label, setup) => {
    await setup();
    expect((await integrations({ authorization: `Bearer ${bearer(handle)}` })).status).toBe(403);
    expect((await customMcp({ authorization: `Bearer ${bearer(handle)}` })).status).toBe(403);
  });

  it('denies personal accounts when the provisioning time cannot be parsed', async () => {
    await seedOrg([[owner, 'active']]);
    await insertUserMachine(db, privatePreview({ provisionedAt: 'not-a-time' }));
    expect((await integrations({ authorization: `Bearer ${bearer(handle)}` })).status).toBe(403);
  });

  it('fails closed without an organization projection or organization ID', async () => {
    await seedOrg([[owner, 'active']]);
    await insertUserMachine(db, privatePreview());
    for (const a of [app({ projection: false }), app({ orgId: 'not-an-org' })]) {
      expect((await integrations({ authorization: `Bearer ${bearer(handle)}` }, a)).status).toBe(403);
      expect((await customMcp({ authorization: `Bearer ${bearer(handle)}` }, a)).status).toBe(403);
    }
  });

  it('never creates or renames the owner\'s Custom MCP account from a Private Preview handle', async () => {
    await insertUserMachine(db, privatePreview());
    const ensureUser = vi.fn(async () => ({ id: 'created' }));
    const missing = { getUserByClerkId: vi.fn(async () => null), ensureUser };
    await expect(resolveCustomMcpUserIdForMachine(db, missing, owner, handle)).resolves.toBeNull();

    const existing = { getUserByClerkId: vi.fn(async () => ({ id: 'mcp-user-1' })), ensureUser };
    await expect(resolveCustomMcpUserIdForMachine(db, existing, owner, handle)).resolves.toBe('mcp-user-1');
    expect(ensureUser).not.toHaveBeenCalled();
  });

  it('keeps shared previews denied', async () => {
    await seedOrg([[owner, 'active']]);
    await insertUserMachine(db, {
      machineId: '00000000-0000-4000-8000-000000001298',
      clerkUserId: owner,
      handle: 'pr-1298',
      runtimeSlot: 'pr-1298',
      provisioningClass: 'preview',
      status: 'running',
      provisionedAt: new Date().toISOString(),
    });
    const res = await app().request('/internal/containers/pr-1298/integrations/probe', {
      headers: { authorization: `Bearer ${bearer('pr-1298')}` },
    });
    expect(res.status).toBe(403);
  });
});
