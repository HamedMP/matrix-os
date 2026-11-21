import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Kysely, sql, type KyselyPlugin } from 'kysely';
import { KyselyPGlite } from 'kysely-pglite';
import { JSDOM } from 'jsdom';
import type { SiteRecord } from '@matrix-os/contracts';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, type PlatformDatabase, type PlatformDB } from '../../packages/platform/src/db.js';
import { runPlatformStartupMigrations } from '../../packages/platform/src/database/run-migrations.js';
import { buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteManagementRoutes } from '../../packages/platform/src/sites/management-routes.js';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
import { sitePage } from '../../packages/platform/src/sites/renderer.js';

// Outcome: a link to a public Matrix.page app unfurls as a titled card with an
// optional image in chat/social apps, and the owner can customise it.
// Faults detected: missing or unescaped preview tags, an image that is not one
// of the site's own raster assets, previews leaking from link-gated sites,
// stale image references after a redeploy, and social edits bumping the site
// revision (which would make the open Share popover conflict).

const db = await createTestPlatformDb({ serializeTransactions: true });
const secret = 's'.repeat(40);
const edgeSecret = 'e'.repeat(40);
const machine = { machineId: 'social-runtime', handle: 'social', runtimeSlot: 'primary' };
const owner = { ownerId: 'user_social', machineId: machine.machineId, appSlug: 'launch' };
await insertUserMachine(db.db, { machineId: machine.machineId, clerkUserId: owner.ownerId, handle: machine.handle, runtimeTokenEpoch: 1, status: 'running', provisionedAt: new Date().toISOString() });
afterAll(() => destroyTestPlatformDb(db.db));
beforeEach(async () => {
  await db.db.executor.deleteFrom('public_site_access_links').execute();
  await db.db.executor.deleteFrom('public_site_versions').execute();
  await db.db.executor.deleteFrom('public_sites').execute();
  await db.db.executor.deleteFrom('public_site_aliases').execute();
});

const FILES = [
  { path: 'index.html', contentType: 'text/html', bytes: 10 },
  { path: 'og/card.png', contentType: 'image/png', bytes: 10 },
  { path: 'photo.jpg', contentType: 'image/jpeg', bytes: 10 },
  { path: 'hero.webp', contentType: 'image/webp', bytes: 10 },
  { path: 'logo.svg', contentType: 'image/svg+xml', bytes: 10 },
  { path: 'anim.gif', contentType: 'image/gif', bytes: 10 },
];

async function publishedSite(accessMode: 'public' | 'private_link' = 'public', files = FILES) {
  const siteId = randomUUID();
  const versionId = randomUUID();
  await db.db.executor.insertInto('public_sites').values({
    id: siteId, owner_id: owner.ownerId, machine_id: owner.machineId, app_slug: owner.appSlug,
    title: 'Launch <party>', description: 'Join "us" & friends', slug: 'launch-party', revision: 4, status: 'published',
    access_mode: accessMode, active_version: versionId, created_at: new Date().toISOString(),
  }).execute();
  await db.db.executor.insertInto('public_site_aliases').values({ slug: 'launch-party', site_id: siteId }).execute();
  await db.db.executor.insertInto('public_site_versions').values({
    id: versionId, site_id: siteId, created_at: new Date().toISOString(), config: { data: {}, forms: [] }, files,
  }).execute();
  return { siteId, versionId };
}

const service = () => createSitesService({ db: db.db, env: { NODE_ENV: 'test' } });
const meta = (html: string) => {
  const document = new JSDOM(html).window.document;
  const read = (key: string) => document.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.getAttribute('content') ?? null;
  return { read, count: document.querySelectorAll('meta[property^="og:"],meta[name^="twitter:"]').length };
};

describe('rendered social preview tags', () => {
  const site: SiteRecord = {
    id: 'a2fd72d0-0926-49d5-b45f-bbfb167e50d2', appSlug: 'launch', title: 'Launch <script>', description: 'A "quoted" & <b>bold</b> event',
    slug: 'launch-party', url: 'https://matrix.page/launch-party', revision: 1, status: 'published', accessMode: 'public',
    activeVersion: 'cd0a12e9-18a0-4b4e-9a10-269eb5697d4f', versions: [], config: { data: {}, forms: [] },
  };

  it('falls back to the site title and description with a text-only card', () => {
    const html = sitePage(site, { title: null, description: null, imagePath: null });
    const { read } = meta(html);
    expect(read('og:title')).toBe('Launch <script>');
    expect(read('og:description')).toBe('A "quoted" & <b>bold</b> event');
    expect(read('og:url')).toBe('https://matrix.page/launch-party');
    expect(read('og:type')).toBe('website');
    expect(read('og:site_name')).toBe('Matrix OS');
    expect(read('twitter:card')).toBe('summary');
    expect(read('og:image')).toBeNull();
    expect(html).not.toContain('<script>"');
    expect(html).not.toMatch(/content="[^"]*<b>/);
  });

  it('uses owner overrides and an absolute matrix.page image URL', () => {
    const { read } = meta(sitePage(site, { title: 'Party "tonight"', description: 'Bring snacks', imagePath: 'og/card.png' }));
    expect(read('og:title')).toBe('Party "tonight"');
    expect(read('og:description')).toBe('Bring snacks');
    expect(read('og:image')).toBe(`https://matrix.page/${site.id}/assets/${site.activeVersion}/og/card.png`);
    expect(read('og:image:alt')).toBe('Party "tonight"');
    expect(read('twitter:card')).toBe('summary_large_image');
  });

  it('never renders an image path that is not a raster site asset', () => {
    for (const imagePath of ['https://evil.example/x.png', '../x.png', 'logo.svg', 'a"onload=x.png']) {
      const { read } = meta(sitePage(site, { title: null, description: null, imagePath }));
      expect(read('og:image')).toBeNull();
      expect(read('twitter:card')).toBe('summary');
    }
  });

  it('omits social tags for link-gated sites and when no preview is supplied', () => {
    expect(meta(sitePage({ ...site, accessMode: 'private_link' }, { title: 'Secret', description: 'Hidden', imagePath: 'og/card.png' })).count).toBe(0);
    expect(meta(sitePage(site)).count).toBe(0);
  });
});

describe('owner social settings', () => {
  it('lists only png, jpeg and webp assets of the active version and defaults every field', async () => {
    await publishedSite();
    expect(await service().social(owner)).toEqual({ title: null, description: null, imagePath: null, imageOptions: ['hero.webp', 'og/card.png', 'photo.jpg'] });
  });

  it('saves overrides atomically without changing the site revision', async () => {
    const { siteId } = await publishedSite();
    const saved = await service().updateSocial(owner, { title: '  Party  ', description: 'Bring snacks', imagePath: 'og/card.png' });
    expect(saved).toMatchObject({ title: 'Party', description: 'Bring snacks', imagePath: 'og/card.png' });
    const row = await db.db.executor.selectFrom('public_sites').selectAll().where('id', '=', siteId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ revision: 4, social_title: 'Party', social_description: 'Bring snacks', social_image_path: 'og/card.png' });
    expect(await service().updateSocial(owner, { title: null, description: null, imagePath: null })).toMatchObject({ title: null, description: null, imagePath: null });
  });

  it('rejects images outside the active build, vector images and external URLs', async () => {
    await publishedSite();
    for (const imagePath of ['missing.png', 'logo.svg', 'anim.gif', 'https://evil.example/x.png', '../index.png']) {
      await expect(service().updateSocial(owner, { title: null, description: null, imagePath })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(service().updateSocial(owner, { title: 'x', description: null, imagePath: null, extra: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service().updateSocial(owner, { title: 'x'.repeat(201), description: null, imagePath: null })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('keeps an already-saved image a redeploy dropped while other fields change', async () => {
    const { versionId } = await publishedSite();
    await service().updateSocial(owner, { title: null, description: null, imagePath: 'og/card.png' });
    await db.db.executor.updateTable('public_site_versions').set({ files: [FILES[0]!] }).where('id', '=', versionId).execute();
    expect(await service().updateSocial(owner, { title: 'Renamed', description: null, imagePath: 'og/card.png' }))
      .toEqual({ title: 'Renamed', description: null, imagePath: 'og/card.png', imageOptions: [] });
    await expect(service().updateSocial(owner, { title: 'Renamed', description: null, imagePath: 'photo.jpg' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await service().updateSocial(owner, { title: 'Renamed', description: null, imagePath: null })).toMatchObject({ imagePath: null });
  });

  it('is scoped to the owner app', async () => {
    await publishedSite();
    await expect(service().social({ ...owner, appSlug: 'other' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(service().updateSocial({ ...owner, appSlug: 'other' }, { title: 'x', description: null, imagePath: null })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('public page and management routes', () => {
  const publicApp = () => {
    const app = new Hono();
    app.route('/', createSitePublicRoutes({ service: service(), edgeSecret, submit: async () => ({ accepted: true }) }));
    return app;
  };
  const visit = (reference: string) => publicApp().request(`/${reference}`, { headers: { 'x-matrix-sites-edge': edgeSecret } });

  it('serves owner overrides on the public page and drops an image the active build no longer has', async () => {
    const { siteId, versionId } = await publishedSite();
    await service().updateSocial(owner, { title: 'Party', description: null, imagePath: 'og/card.png' });
    const first = meta(await (await visit('launch-party')).text());
    expect(first.read('og:title')).toBe('Party');
    expect(first.read('og:description')).toBe('Join "us" & friends');
    expect(first.read('og:url')).toBe('https://matrix.page/launch-party');
    expect(first.read('og:image')).toBe(`https://matrix.page/${siteId}/assets/${versionId}/og/card.png`);
    await db.db.executor.updateTable('public_site_versions').set({ files: [FILES[0]!] }).where('id', '=', versionId).execute();
    const after = meta(await (await visit(siteId)).text());
    expect(after.read('og:image')).toBeNull();
    expect(after.read('twitter:card')).toBe('summary');
  });

  it('never reads the build file list on a public page request, only a yes/no for the chosen image', async () => {
    // Largest allowed build: 200 file entries, the chosen image last.
    const files = [...Array.from({ length: 199 }, (_, index) => ({ path: `chunk-${index}.png`, contentType: 'image/png', bytes: 50_000 })),
      { path: 'og/card.png', contentType: 'image/png', bytes: 10 }];
    const { siteId, versionId } = await publishedSite('public', files);
    await service().updateSocial(owner, { title: null, description: null, imagePath: 'og/card.png' });
    const rows: Record<string, unknown>[] = [];
    const spy: KyselyPlugin = {
      transformQuery: args => args.node,
      transformResult: async args => { rows.push(...(args.result.rows as Record<string, unknown>[])); return args.result; },
    };
    const spied: PlatformDB = { ...db.db, executor: (db.db.executor as Kysely<PlatformDatabase>).withPlugin(spy) };
    const app = new Hono();
    app.route('/', createSitePublicRoutes({ service: createSitesService({ db: spied, env: { NODE_ENV: 'test' } }), edgeSecret, submit: async () => ({ accepted: true }) }));
    const html = await (await app.request(`/${siteId}`, { headers: { 'x-matrix-sites-edge': edgeSecret } })).text();
    expect(meta(html).read('og:image')).toBe(`https://matrix.page/${siteId}/assets/${versionId}/og/card.png`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter(row => 'files' in row)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain('chunk-');
  });

  it('follows rollbacks and builds that change the chosen image type', async () => {
    const { siteId, versionId } = await publishedSite();
    await service().updateSocial(owner, { title: null, description: null, imagePath: 'og/card.png' });
    const previous = randomUUID();
    await db.db.executor.insertInto('public_site_versions').values({ id: previous, site_id: siteId, created_at: new Date().toISOString(),
      config: { data: {}, forms: [] }, files: [FILES[0]!, { path: 'og/card.png', contentType: 'image/svg+xml', bytes: 10 }] }).execute();
    await db.db.executor.updateTable('public_sites').set({ active_version: previous }).where('id', '=', siteId).execute();
    expect(meta(await (await visit(siteId)).text()).read('og:image')).toBeNull();
    await db.db.executor.updateTable('public_sites').set({ active_version: versionId }).where('id', '=', siteId).execute();
    expect(meta(await (await visit(siteId)).text()).read('og:image')).toBe(`https://matrix.page/${siteId}/assets/${versionId}/og/card.png`);
  });

  it('keeps the unauthenticated link-gated response free of preview tags', async () => {
    const { siteId } = await publishedSite('private_link');
    await service().updateSocial(owner, { title: 'Secret party', description: 'Hidden', imagePath: 'og/card.png' });
    const html = await (await visit(siteId)).text();
    expect(meta(html).count).toBe(0);
    expect(html).not.toContain('Secret party');
  });

  it('exposes GET and PATCH social settings only to the machine owner', async () => {
    await publishedSite();
    const app = new Hono();
    app.route('/internal/containers/:handle/sites', createSiteManagementRoutes({ db: db.db, platformSecret: secret, service: service() }));
    const headers = { authorization: `Bearer ${buildPlatformSyncVerificationToken(machine, secret, 1)}`, 'content-type': 'application/json' };
    const path = '/internal/containers/social/sites/launch/social?runtimeSlot=primary';
    expect((await app.request(path)).status).toBe(401);
    expect(await (await app.request(path, { headers })).json()).toMatchObject({ imageOptions: ['hero.webp', 'og/card.png', 'photo.jpg'] });
    const saved = await app.request(path, { method: 'PATCH', headers, body: JSON.stringify({ title: 'Party', description: null, imagePath: 'hero.webp' }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ title: 'Party', imagePath: 'hero.webp' });
    expect((await app.request(path, { method: 'PATCH', headers, body: JSON.stringify({ title: null, description: null, imagePath: 'logo.svg' }) })).status).toBe(400);
    expect((await app.request(path, { method: 'PATCH', headers, body: 'x'.repeat(9000) })).status).toBe(413);
  });
});

describe('sites schema upgrade', () => {
  it('adds the social columns to a platform already at the private-links sites revision', async () => {
    const instance = await KyselyPGlite.create();
    const upgraded = new Kysely<PlatformDatabase>({ dialect: instance.dialect });
    try {
      await runPlatformStartupMigrations(upgraded);
      // Simulate a platform deployed before this change: columns absent, sites marker at generation 2.
      await sql`ALTER TABLE public_sites DROP COLUMN social_title, DROP COLUMN social_description, DROP COLUMN social_image_path`.execute(upgraded);
      await sql`UPDATE platform_schema_revisions SET generation = 2, fingerprint = 'public-app-sites-private-links-v2' WHERE scope = 'sites'`.execute(upgraded);
      await runPlatformStartupMigrations(upgraded);
      const columns = await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'public_sites' AND column_name LIKE 'social_%' ORDER BY column_name`.execute(upgraded);
      expect(columns.rows.map(row => row.column_name)).toEqual(['social_description', 'social_image_path', 'social_title']);
    } finally { await upgraded.destroy(); }
  }, 60_000);
});
