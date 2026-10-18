import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { sql } from 'kysely';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';
import { createAppStoreRepository } from '../../packages/platform/src/app-store/repository.js';
import { AppStoreCreateSubmissionSchema, AppStoreManifestSchema } from '../../packages/contracts/src/app-store.js';
import { verifyStoreApproval } from '../../packages/contracts/src/app-store-signing.js';

const manifest = AppStoreManifestSchema.parse({ name: 'Garden', description: 'A sample garden', version: '1.0.0', runtime: 'vite' });
const author = { userId: 'user_publisher', handle: 'publisher' };
const consumer = { userId: 'user_consumer', handle: 'consumer' };
const keys = generateKeyPairSync('ed25519');
const signing = { keyId: 'v1', privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
function input(version = '1.0.0', key = 'submission:one') {
  return AppStoreCreateSubmissionSchema.parse({ submissionKey: key,
    listing: { slug: 'garden', name: 'Garden', tagline: 'Grow sample habits', description: 'Sample garden', category: 'utilities' },
    version, changelog: '', license: 'MIT', manifest: { ...manifest, version }, source: { sha256: 'a'.repeat(64), size: 123 },
    generalizationReport: { ai: 'completed', changes: [] },
  });
}
describe('App Store repository', () => {
  let db: PlatformDB;
  let repository: ReturnType<typeof createAppStoreRepository>;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    if (!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL) {
      // PGlite has one session: its dialect otherwise interleaves unrelated BEGINs.
      // Serialize whole fallback transactions; native contention is verified below.
      const transaction = db.transaction.bind(db); let turn = Promise.resolve();
      db.transaction = async work => {
        const previous = turn; let release!: () => void;
        turn = new Promise<void>(resolve => { release = resolve; }); await previous;
        try { return await transaction(work); } finally { release(); }
      };
    }
    repository = createAppStoreRepository(db, { signing });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  async function reviewed(version = '1.0.0', key = 'submission:one') {
    const created = await repository.createSubmission(author, input(version, key));
    await repository.beginScan(author.userId, created.id);
    await repository.completeScan(created.id, { findings: [], blocking: false, truncated: false }, 'verified/source');
    return created;
  }
  async function published() { const created = await reviewed(); await repository.decide('user_reviewer', created.id, { type: 'approve' }); return created; }
  it('claims a slug and submission key idempotently without leaking another publisher submission', async () => {
    const first = await repository.createSubmission(author, input());
    expect((await repository.createSubmission(author, input())).id).toBe(first.id);
    await expect(repository.createSubmission(consumer, input('1.0.0', 'submission:two'))).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.createSubmission(author, { ...input(), source: { size: 124, sha256: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('refuses nonincreasing semver and records submitted events once', async () => {
    const first = await repository.createSubmission(author, input());
    await expect(repository.createSubmission(author, input('1.0.0', 'submission:duplicate'))).rejects.toMatchObject({ code: 'conflict' });
    expect((await repository.events(first.listing_id)).filter(event => event.action === 'submitted')).toHaveLength(1);
  });
  it('signs exact reviewed source and publishes atomically with audit', async () => {
    const first = await published(); const detail = await repository.detail('garden', consumer.userId);
    expect(detail.status).toBe('live'); expect(detail.currentVersion?.id).toBe(first.id);
    const version = await repository.getVersion(first.id);
    expect(verifyStoreApproval({ versionId: version.id, version: version.version, source: { sha256: version.source_sha256, size: version.source_size },
      capabilitiesDigest: version.capabilities_digest, manifest: version.manifest }, { keyId: version.approval_key_id!, signature: version.approval_signature! }, [{ keyId: 'v1', publicKey }])).toBe(true);
    expect((await repository.events(first.listing_id)).some(event => event.action === 'approve')).toBe(true);
  });
  it('fails approval closed without a configured signing key', async () => {
    const created = await reviewed(); const unsigned = createAppStoreRepository(db, {});
    await expect(unsigned.decide('reviewer', created.id, { type: 'approve' })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await repository.getVersion(created.id)).status).toBe('in_review');
  });
  it('CAS decisions only allow one result and never regress the published version', async () => {
    const first = await reviewed(); await repository.decide('reviewer', first.id, { type: 'approve' });
    await expect(repository.decide('reviewer', first.id, { type: 'reject', message: 'No' })).rejects.toMatchObject({ code: 'conflict' });
    const second = await reviewed('1.1.0', 'submission:second'); const third = await reviewed('1.2.0', 'submission:third');
    await repository.decide('reviewer', third.id, { type: 'approve' });
    await expect(repository.decide('reviewer', second.id, { type: 'approve' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await repository.getVersion(first.id)).status).toBe('superseded');
    expect((await repository.detail('garden', consumer.userId)).currentVersion?.id).toBe(third.id);
  });
  it('serializes concurrent decisions so exactly one decision and audit event wins', async () => {
    const created = await reviewed();
    const decisions = await Promise.allSettled([repository.decide('reviewer', created.id, { type: 'approve' }), repository.decide('reviewer', created.id, { type: 'reject', message: 'No' })]);
    expect(decisions.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await repository.events(created.listing_id)).filter(event => ['approve', 'reject'].includes(event.action))).toHaveLength(1);
  });
  it('always exercises concurrent install upserts and rating deltas on an approved fixture', async () => {
    let concurrentDb: PlatformDB | undefined;
    try {
      if (process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL) {
        // The native fixture manager leases one connection. Open this clone with
        // the production pool size so these requests really contend in Postgres.
        const result = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db.executor);
        const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL); url.pathname = `/${result.rows[0].name}`;
        concurrentDb = createPlatformDb(url.toString()); await concurrentDb.ready;
        repository = createAppStoreRepository(concurrentDb, { signing });
      }
      const created = await published();
      await Promise.all(Array.from({ length: 5 }, () => repository.install(consumer.userId, 'garden', created.id)));
      await Promise.all(Array.from({ length: 5 }, (_, i) => repository.rate(consumer.userId, 'garden', i + 1)));
      const detail = await repository.detail('garden', consumer.userId); expect(detail.installCount).toBe(1); expect(detail.activeInstallCount).toBe(1); expect(detail.ratingCount).toBe(1); expect(detail.ratingAverage).toBe(detail.myRating);
    } finally { await concurrentDb?.destroy(); }
  });
  it('accepts a first receipt for signed source superseded during the installer build without offering new old downloads', async () => {
    const first = await published();
    expect((await repository.downloadVersion('garden', consumer.userId, first.id)).id).toBe(first.id);
    const second = await reviewed('1.1.0', 'submission:next');
    await repository.decide('reviewer', second.id, { type: 'approve' });
    // A previous grant can finish building, but fresh old-version grants stay denied.
    await expect(repository.downloadVersion('garden', consumer.userId, first.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await repository.install(consumer.userId, 'garden', first.id)).toMatchObject({ installed: true, installCount: 1, activeInstallCount: 1 });
    expect(await repository.install(consumer.userId, 'garden', first.id)).toMatchObject({ installCount: 1, activeInstallCount: 1 });
    await expect(repository.downloadVersion('garden', 'user_new', first.id)).rejects.toMatchObject({ code: 'forbidden' });
    const pending = await reviewed('1.2.0', 'submission:pending');
    await expect(repository.install('user_new', 'garden', pending.id)).rejects.toMatchObject({ code: 'forbidden' });
    await repository.listingAction('reviewer', first.listing_id, { type: 'suspend', message: 'Review' });
    await expect(repository.install('user_new', 'garden', first.id)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('counts first installs and active reactivation exactly once', async () => {
    const created = await published();
    for (let i = 0; i < 3; i++) await repository.install(consumer.userId, 'garden', created.id);
    expect(await repository.uninstall(consumer.userId, 'garden')).toMatchObject({ installed: false, installCount: 1, activeInstallCount: 0 });
    await repository.uninstall(consumer.userId, 'garden');
    expect(await repository.install(consumer.userId, 'garden', created.id)).toMatchObject({ installed: true, installCount: 1, activeInstallCount: 1 });
  });
  it('requires a prior install, refuses self-rating, and applies change and delete deltas', async () => {
    const created = await published();
    await expect(repository.rate(consumer.userId, 'garden', 5)).rejects.toMatchObject({ code: 'forbidden' });
    await repository.install(consumer.userId, 'garden', created.id); await repository.install(author.userId, 'garden', created.id);
    await expect(repository.rate(author.userId, 'garden', 5)).rejects.toMatchObject({ code: 'forbidden' });
    await repository.rate(consumer.userId, 'garden', 4); expect(await repository.rate(consumer.userId, 'garden', 2)).toEqual({ myRating: 2, ratingAverage: 2, ratingCount: 1 });
    expect(await repository.rate(consumer.userId, 'garden', null)).toEqual({ myRating: null, ratingAverage: null, ratingCount: 0 });
  });
  it('returns only coarse removed metadata to prior installers of a delisted app', async () => {
    const first = await published(); await repository.install(consumer.userId, 'garden', first.id);
    await repository.listingAction('reviewer', first.listing_id, { type: 'delist', message: 'Retired' });
    expect(await repository.detail('garden', consumer.userId)).toMatchObject({ status: 'delisted', notice: 'removed', description: '', currentVersion: null, capabilities: null,
      myInstall: { versionId: first.id, active: true } });
    await expect(repository.detail('garden', 'user_new')).rejects.toMatchObject({ code: 'not_found' });
    await expect(repository.downloadVersion('garden', 'user_new', first.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await repository.catalog({ sort: 'new', limit: 50 })).listings).toEqual([]);
  });
  it('paginates all publisher listings even after their abandoned versions have been cleaned up', async () => {
    const first = await repository.createSubmission(author, input());
    const template = await db.executor.selectFrom('app_store_listings').selectAll().where('id', '=', first.listing_id).executeTakeFirstOrThrow();
    await db.executor.insertInto('app_store_listings').values(Array.from({ length: 104 }, (_, i) => ({ ...template, id: randomUUID(), slug: `garden-${i}` }))).execute();
    const firstPage = await repository.submissions(author.userId);
    expect(firstPage.listings).toHaveLength(100); expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await repository.submissions(author.userId, firstPage.nextCursor);
    expect(secondPage.listings).toHaveLength(5); expect(secondPage.nextCursor).toBeUndefined();
    expect(new Set([...firstPage.listings, ...secondPage.listings].map(row => row.id)).size).toBe(105);
    expect(firstPage.submissions).toHaveLength(1); expect(secondPage.submissions).toEqual([]);
    expect((await repository.submissions(consumer.userId)).listings).toEqual([]);
  });
  it.runIf(Boolean(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL))('enforces the owner pending quota across concurrent different slugs in native PostgreSQL', async () => {
    const first = await repository.createSubmission(author, input());
    const version = await repository.getVersion(first.id);
    await db.executor.insertInto('app_store_versions').values(Array.from({ length: 18 }, (_, i) => ({ ...version, id: randomUUID(), submission_key: `quota:seed:${i}`, version: `1.0.${i + 1}`, version_patch: i + 1 }))).execute();
    const result = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db.executor);
    const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL!); url.pathname = `/${result.rows[0].name}`;
    const concurrentDb = createPlatformDb(url.toString()); await concurrentDb.ready;
    try {
      // Delay the insert after admission so two independent sessions overlap at
      // the quota boundary. Each slug has a different listing row lock.
      await sql`CREATE FUNCTION app_store_quota_insert_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`.execute(db.executor);
      await sql`CREATE TRIGGER app_store_quota_insert_delay BEFORE INSERT ON app_store_versions FOR EACH ROW EXECUTE FUNCTION app_store_quota_insert_delay()`.execute(db.executor);
      const concurrent = createAppStoreRepository(concurrentDb, { signing });
      const create = (suffix: string) => { const value = input('1.0.0', `quota:new:${suffix}`); return concurrent.createSubmission(author, { ...value, listing: { ...value.listing, slug: `new-${suffix}` } }); };
      const outcomes = await Promise.allSettled([create('one'), create('two')]);
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'limit' }) })]);
      expect(await db.executor.selectFrom('app_store_versions').select('id').where('submitted_by_clerk_user_id', '=', author.userId).execute()).toHaveLength(20);
      expect(await db.executor.selectFrom('app_store_listings').select('id').where('slug', 'in', ['new-one', 'new-two']).execute()).toHaveLength(1);
    } finally { await concurrentDb.destroy(); }
  });
  it('hides nonlive listings, preserves removed notices, and does not reinstate on update approval', async () => {
    const first = await published(); await repository.install(consumer.userId, 'garden', first.id);
    await repository.listingAction('reviewer', first.listing_id, { type: 'suspend', message: 'Needs review' });
    expect((await repository.catalog({ sort: 'popular', limit: 24 })).listings).toHaveLength(0);
    expect(await repository.detail('garden', consumer.userId)).toMatchObject({ notice: 'removed' });
    await expect(repository.downloadVersion('garden', consumer.userId, first.id)).rejects.toMatchObject({ code: 'forbidden' });
    const second = await reviewed('1.1.0', 'submission:update'); await repository.decide('reviewer', second.id, { type: 'approve' });
    expect((await repository.detail('garden', author.userId)).status).toBe('suspended');
    await repository.listingAction('reviewer', first.listing_id, { type: 'reinstate', message: 'Cleared' });
    expect((await repository.catalog({ sort: 'new', limit: 1 })).listings).toHaveLength(1);
  });
});
