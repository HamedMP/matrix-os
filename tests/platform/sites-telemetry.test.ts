import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MATRIX_TELEMETRY_EVENTS } from '../../packages/observability/src/events.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

let db: PlatformDB;
const owner = { ownerId: 'user_site_telemetry', machineId: 'site-telemetry-machine', appSlug: 'launch' };
const deployment = {
  title: 'Private launch title', description: 'Private launch description', slug: 'private-launch-slug',
  config: { data: {}, forms: [] },
  files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('<h1>Launch</h1>').toString('base64') }],
};

beforeAll(async () => {
  db = (await createTestPlatformDb()).db;
  await insertUserMachine(db, { machineId: owner.machineId, clerkUserId: owner.ownerId, handle: 'site-telemetry', status: 'running', provisionedAt: new Date().toISOString() });
});
beforeEach(async () => {
  await db.executor.deleteFrom('public_site_access_links').execute();
  await db.executor.deleteFrom('public_site_versions').execute();
  await db.executor.deleteFrom('public_sites').execute();
  await db.executor.deleteFrom('public_site_aliases').execute();
});
afterAll(async () => destroyTestPlatformDb(db));

describe('Matrix.page product telemetry', () => {
  it('records an access-mode change made through publish update', async () => {
    const captureEvent = vi.fn();
    const service = createSitesService({ db, captureEvent, storage: {
      async putObject() { return {}; }, async getObject() { return { body: null }; },
    } });

    const first = await service.deploy(owner, deployment);
    captureEvent.mockClear();
    await service.deploy(owner, { ...deployment, accessMode: 'private_link', baseRevision: first.revision });

    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_ACCESS_MODE_CHANGED,
      { previous_access_mode: 'public', access_mode: 'private_link' }, { distinctId: owner.ownerId });
  });

  it('records successful owner and link lifecycle outcomes without content or credentials', async () => {
    const captureEvent = vi.fn();
    const service = createSitesService({ db, captureEvent, storage: {
      async putObject() { return {}; }, async getObject() { return { body: null }; },
    } });

    const first = await service.deploy(owner, deployment);
    const updated = await service.deploy(owner, { ...deployment, baseRevision: first.revision });
    const privateSite = await service.patch(owner, { accessMode: 'private_link', baseRevision: updated.revision });
    const created = await service.createAccessLink(owner, { baseRevision: privateSite.revision });
    const claimed = await service.claimAccessLink(privateSite.id, { linkId: created.link.id, token: created.url.split('.').at(-1)! });
    await service.revokeAccessLink(owner, created.link.id);
    const rolledBack = await service.rollback(owner, first.activeVersion!, privateSite.revision);
    await service.unpublish(owner, rolledBack.revision);

    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_PUBLISHED,
      { access_mode: 'public', operation: 'first_publish' }, { distinctId: owner.ownerId });
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_PUBLISHED,
      { access_mode: 'public', operation: 'update' }, { distinctId: owner.ownerId });
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_SETTINGS_UPDATED,
      { access_mode: 'private_link', access_mode_changed: true }, { distinctId: owner.ownerId });
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_ACCESS_MODE_CHANGED,
      { previous_access_mode: 'public', access_mode: 'private_link' }, { distinctId: owner.ownerId });
    for (const event of [
      MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_LINK_CREATED,
      MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_LINK_CLAIMED,
      MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_LINK_REVOKED,
      MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_ROLLED_BACK,
      MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_UNPUBLISHED,
    ]) expect(captureEvent).toHaveBeenCalledWith(event, { access_mode: 'private_link' }, { distinctId: owner.ownerId });

    const serialized = JSON.stringify(captureEvent.mock.calls);
    for (const privateValue of [deployment.title, deployment.description, deployment.slug, privateSite.id, created.link.id, created.url, claimed.cookie]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('emits nothing when a publication mutation fails', async () => {
    const captureEvent = vi.fn();
    const service = createSitesService({ db, captureEvent });
    await expect(service.createAccessLink(owner, { baseRevision: 1 })).rejects.toThrow();
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it('keeps successful publication independent from telemetry delivery', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const service = createSitesService({ db, captureEvent() { throw new Error('posthog unavailable'); }, storage: {
        async putObject() { return {}; }, async getObject() { return { body: null }; },
      } });
      await expect(service.deploy(owner, deployment)).resolves.toMatchObject({ status: 'published' });
      expect(warning).toHaveBeenCalledWith('[sites] telemetry capture failed', 'Error');
    } finally { warning.mockRestore(); }
  });
});
