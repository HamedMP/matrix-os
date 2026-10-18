import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createPrivatePreviewEligibility, type PrivatePreviewEligibility } from '../../packages/platform/src/private-preview-eligibility.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { ensurePlatformUser, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createConfiguredAppStoreRuntime } from '../../packages/platform/src/app-store/startup.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { encodeAppBundle, bundleDigest } from '../../packages/contracts/src/app-store-bundle.js';
import { AppStoreDownloadGrantSchema, AppStoreReviewDetailSchema, AppStoreStatusSchema, AppStoreSubmissionSummarySchema } from '../../packages/contracts/src/app-store.js';
import { verifyStoreApproval } from '../../packages/contracts/src/app-store-signing.js';
const secret = 'test-platform-secret-for-app-store';
const pair = generateKeyPairSync('ed25519');
const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const manifest = { name: 'Garden', slug: 'garden', description: 'Sample garden', version: '1.0.0', runtime: 'vite', permissions: [] };
function bundle(extra?: string) {
  return encodeAppBundle('source', new Map([
    ['matrix.json', Buffer.from(JSON.stringify(manifest))], ['package.json', Buffer.from(JSON.stringify({ name: 'garden', dependencies: { vite: '7.0.0', react: '19.0.0' } }))],
    ['pnpm-lock.yaml', Buffer.from('lockfileVersion: 9')], ['index.html', Buffer.from('<html>Garden</html>')], ['src/main.tsx', Buffer.from(extra ?? 'export const title = "Garden";')],
  ]));
}
function submission(bytes = bundle()) { return { submissionKey: 'publisher:draft:1.0.0', listing: { slug: 'garden', name: 'Garden', tagline: 'Grow habits', description: 'Sample garden', category: 'utilities' },
  version: '1.0.0', changelog: '', license: 'MIT', manifest, source: { sha256: bundleDigest(bytes), size: bytes.length }, generalizationReport: { ai: 'completed', changes: [] } }; }
describe('App Store authenticated platform routes', () => {
  let db: PlatformDB;
  let objects: Map<string, Buffer>;
  let runtime: ReturnType<typeof createConfiguredAppStoreRuntime>;
  const env = { MATRIX_APP_STORE_ENABLED: 'true', MATRIX_APP_STORE_REVIEWER_CLERK_IDS: 'user_reviewer', MATRIX_APP_STORE_SIGNING_KEY_ID: 'review-v1', MATRIX_APP_STORE_SIGNING_PRIVATE_KEY: privateKey };
  function store() { return {
    getPresignedPutUrl: async (key: string, size: number) => `https://objects.example/upload/${key}?size=${size}`,
    getPresignedGetUrl: async (key: string) => `https://objects.example/download/${key}`,
    getObject: async (key: string) => { const bytes = objects.get(key); return { body: bytes ? new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) : null, contentLength: bytes?.length }; },
    putObject: async (key: string, bytes: Uint8Array) => { objects.set(key, Buffer.from(bytes)); return {}; },
    deleteObject: async (key: string) => { objects.delete(key); },
  }; }
  function app(overrides: Record<string, string> = {}, privatePreviewEligibility?: PrivatePreviewEligibility) { runtime = createConfiguredAppStoreRuntime({ db, env: { ...env, ...overrides }, platformSecret: secret, objectStore: store(), privatePreviewEligibility }); const result = new Hono(); result.route('/internal/containers/:handle/app-store', runtime.routes); return result; }
  function request(target: Hono, path: string, method = 'GET', body?: unknown, handle = 'publisher', token = buildPlatformVerificationToken(handle, secret)) {
    return target.request(`/internal/containers/${handle}/app-store${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); objects = new Map();
    for (const handle of ['publisher', 'reviewer', 'consumer']) {
      await ensurePlatformUser(db, { clerkId: `user_${handle}`, handle, displayName: handle, email: `${handle}@example.test`, containerId: `clerk:user_${handle}` });
      await insertUserMachine(db, { machineId: randomUUID(), clerkUserId: `user_${handle}`, handle, provisioningClass: 'customer', runtimeSlot: 'primary', status: 'running', provisionedAt: new Date().toISOString() });
    }
  });
  afterEach(async () => { await runtime?.shutdown(); await destroyTestPlatformDb(db); });
  async function create(target: Hono, bytes = bundle()) {
    const result = await request(target, '/submissions', 'POST', submission(bytes)); expect(result.status).toBe(201); const row = await result.json() as { versionId: string; upload: { url: string } };
    objects.set(`app-store/owners/user_publisher/uploads/${row.versionId}`, bytes); return row;
  }
  it('requires valid HMAC, authoritative active owner, and validates all boundaries', async () => {
    const target = app();
    expect((await request(target, '/status', 'GET', undefined, 'publisher', 'wrong')).status).toBe(401);
    expect((await request(target, '/status', 'GET', undefined, 'unknown')).status).toBe(403);
    expect((await request(target, '/listings?limit=999')).status).toBe(400);
    expect((await request(target, '/review/queue')).status).toBe(403);
    expect((await request(target, '/submissions', 'POST', { ...submission(), userId: 'user_other' })).status).toBe(400);
    expect((await request(target, '/submissions/not-an-id/finalize', 'POST')).status).toBe(400);
    expect((await request(target, '/listings/garden/rating', 'PUT', { stars: 6 })).status).toBe(400);
  });
  it('rejects shared or preview machine-only owner impersonation and inactive owners', async () => {
    const target = app();
    await db.executor.updateTable('user_machines').set({ access_clerk_user_ids: ['user_other'] }).where('handle', '=', 'publisher').execute();
    expect((await request(target, '/status')).status).toBe(403);
    await db.executor.updateTable('user_machines').set({ access_clerk_user_ids: [], provisioning_class: 'preview' }).where('handle', '=', 'publisher').execute();
    expect((await request(target, '/status')).status).toBe(403);
    await db.executor.updateTable('user_machines').set({ provisioning_class: 'customer' }).where('handle', '=', 'publisher').execute();
    await db.executor.updateTable('users').set({ status: 'deleted' }).where('clerk_id', '=', 'user_publisher').execute();
    expect((await request(target, '/status')).status).toBe(403);
  });
  it('admits only an eligible owner-only private preview and rechecks membership and TTL', async () => {
    const handle = 'pv-123-abcdef12';
    await insertUserMachine(db, { machineId: randomUUID(), clerkUserId: 'user_publisher', handle, runtimeSlot: handle, provisioningClass: 'private-preview', sourcePr: 123, confirmedBundleVersion: 'test-pr-123', status: 'running', provisionedAt: new Date().toISOString() });
    expect((await request(app(), '/status', 'GET', undefined, handle)).status).toBe(403);
    let member = true;
    const eligibility = createPrivatePreviewEligibility({ internalOrganizationId: 'org_internal', isMember: async () => member });
    const target = app({}, eligibility);
    expect((await request(target, '/status', 'GET', undefined, handle)).status).toBe(200);
    member = false; expect((await request(target, '/status', 'GET', undefined, handle)).status).toBe(403);
    member = true; await db.executor.updateTable('user_machines').set({ provisioned_at: new Date(Date.now() - 73 * 3600000).toISOString() }).where('handle', '=', handle).execute();
    expect((await request(target, '/status', 'GET', undefined, handle)).status).toBe(403);
    await db.executor.updateTable('user_machines').set({ provisioned_at: new Date().toISOString(), provisioning_class: 'preview', source_pr: null }).where('handle', '=', handle).execute();
    expect((await request(target, '/status', 'GET', undefined, handle)).status).toBe(403);
  });
  it('answers status while disabled, exposes only authenticated public signing keys', async () => {
    const target = app({ MATRIX_APP_STORE_ENABLED: 'false' });
    const status = AppStoreStatusSchema.parse(await (await request(target, '/status')).json());
    expect(status.enabled).toBe(false); expect(JSON.stringify(status)).not.toContain('PRIVATE KEY');
    expect((await request(target, '/listings')).status).toBe(503);
    const enabled = app(); expect(AppStoreStatusSchema.parse(await (await request(enabled, '/status', 'GET', undefined, 'reviewer')).json()).reviewer).toBe(true);
  });
  it('verifies source, isolates mutable uploads, reviews and signs a source-only download grant', async () => {
    const target = app(); const created = await create(target);
    const finalized = await request(target, `/submissions/${created.versionId}/finalize`, 'POST');
    expect(finalized.status).toBe(200); expect(AppStoreSubmissionSummarySchema.parse(await finalized.json()).status).toBe('in_review');
    const review = await request(target, `/review/versions/${created.versionId}`, 'GET', undefined, 'reviewer'); expect(review.status).toBe(200);
    expect(AppStoreReviewDetailSchema.parse(await review.json()).files.length).toBe(5);
    expect((await request(target, `/review/versions/${created.versionId}/file?path=../secrets`, 'GET', undefined, 'reviewer')).status).toBe(400);
    expect((await request(target, `/review/versions/${created.versionId}/decision`, 'POST', { type: 'approve' }, 'reviewer')).status).toBe(200);
    objects.set(`app-store/owners/user_publisher/uploads/${created.versionId}`, Buffer.from('replaced by author'));
    const response = await request(target, '/listings/garden/download', 'POST', { versionId: created.versionId }, 'consumer'); expect(response.status).toBe(200);
    const grant = AppStoreDownloadGrantSchema.parse(await response.json()); expect(grant.source.url).toContain('/sources/'); expect(grant).not.toHaveProperty('dist');
    const status = AppStoreStatusSchema.parse(await (await request(target, '/status', 'GET', undefined, 'consumer')).json());
    expect(verifyStoreApproval(grant, grant.approval, status.signingKeys)).toBe(true);
    expect((await request(target, '/listings/garden/install', 'PUT', { versionId: created.versionId }, 'consumer')).status).toBe(200);
    expect((await request(target, '/listings/garden/rating', 'PUT', { stars: 4 }, 'consumer')).status).toBe(200);
    expect((await request(target, `/review/versions/${created.versionId}/decision`, 'POST', { type: 'approve' }, 'reviewer')).status).toBe(409);
  });
  it('blocks secret source and hash mismatches with generic responses', async () => {
    const target = app(); const malicious = bundle('export const key = "sk-proj-Aa012345678901234567890123456789";'); const created = await create(target, malicious);
    const result = await request(target, `/submissions/${created.versionId}/finalize`, 'POST'); expect(result.status).toBe(200);
    expect(AppStoreSubmissionSummarySchema.parse(await result.json()).status).toBe('scan_failed');
    expect((await request(target, `/review/versions/${created.versionId}/decision`, 'POST', { type: 'approve' }, 'reviewer')).status).toBe(409);
  });
  it.each(['hash', 'size', 'format'])('refuses a source %s mismatch without exposing object keys or provider errors', async mode => {
    const target = app(); const created = await create(target, mode === 'format' ? Buffer.alloc(100) : bundle()); const bytes = objects.get(`app-store/owners/user_publisher/uploads/${created.versionId}`)!;
    objects.set(`app-store/owners/user_publisher/uploads/${created.versionId}`, mode === 'size' ? Buffer.concat([bytes, Buffer.from('x')]) : mode === 'format' ? bytes : Buffer.from(bytes).fill(0, 10, 11));
    const response = await request(target, `/submissions/${created.versionId}/finalize`, 'POST'); expect(response.status).toBe(200);
    const summary = AppStoreSubmissionSummarySchema.parse(await response.json()); expect(summary.status).toBe('scan_failed'); expect(JSON.stringify(summary)).not.toContain('app-store/uploads');
  });
  it('enforces owner-scoped hourly submission limits even for repeated idempotency keys', async () => {
    const target = app();
    for (let index = 0; index < 10; index++) expect((await request(target, '/submissions', 'POST', submission())).status).toBe(201);
    expect((await request(target, '/submissions', 'POST', submission())).status).toBe(429);
  });
  it('exposes only the publisher submissions and CAS withdrawal; every review route needs reviewer authority', async () => {
    const target = app(); const created = await create(target);
    const consumer = await request(target, '/submissions', 'GET', undefined, 'consumer'); expect((await consumer.json() as { submissions: unknown[] }).submissions).toHaveLength(0);
    const mine = await request(target, '/submissions'); expect((await mine.json() as { submissions: unknown[] }).submissions).toHaveLength(1);
    expect((await request(target, `/submissions/${created.versionId}/withdraw`, 'POST', undefined, 'consumer')).status).toBe(409);
    expect((await request(target, `/submissions/${created.versionId}/withdraw`, 'POST')).status).toBe(200);
    expect((await request(target, `/submissions/${created.versionId}/withdraw`, 'POST')).status).toBe(409);
    for (const [path, method, body] of [
      ['/review/queue', 'GET', undefined], [`/review/versions/${created.versionId}`, 'GET', undefined],
      [`/review/versions/${created.versionId}/file?path=matrix.json`, 'GET', undefined], [`/review/versions/${created.versionId}/decision`, 'POST', { type: 'approve' }],
      [`/review/listings/${created.versionId}/action`, 'POST', { type: 'suspend', message: 'Review' }],
    ] as const) expect((await request(target, path, method, body, 'consumer')).status).toBe(403);
  });
  it('applies mutation body limits before buffering large bodies', async () => {
    const target = app(); const response = await request(target, '/submissions', 'POST', { payload: 'x'.repeat(600000) }); expect(response.status).toBe(413);
  });
});
