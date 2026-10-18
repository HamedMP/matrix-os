import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import * as contract from '@matrix-os/contracts/app-store';
import { buildPlatformVerificationToken, timingSafeTokenEquals } from '../platform-token.js';
import { withAccountDeletionOwnerLock } from '../account-deletion/admission.js';
import type { PrivatePreviewEligibility } from '../private-preview-eligibility.js';
import { HANDLE_PATTERN } from '../platform-route-utils.js';
import { getPlatformUserByClerkId, getRunningUserMachineByHandle, type PlatformDB } from '../db.js';
import { AppStoreError, storeFailure } from './errors.js';
import type { StoreActor } from './types.js';
import type { AppStoreRepository } from './repository.js';
import type { StoreObjects } from './object-store.js';
import type { createReviewService } from './review-service.js';
import type { readStoreConfiguration } from './reviewer-allowlist.js';
import { submissionSummary } from './repository-versions.js';
import type { createStoreIntake } from './intake.js';
export type StoreRouteEnv = { Variables: { storeActor: StoreActor; storeReviewer: boolean; storeOwnerTerms: string[] } };
export type StoreRouteDeps = {
  db: PlatformDB; platformSecret: string; config: ReturnType<typeof readStoreConfiguration>; repository: AppStoreRepository;
  privatePreviewEligibility?: PrivatePreviewEligibility; env?: NodeJS.ProcessEnv;
  objects?: StoreObjects; review?: ReturnType<typeof createReviewService>; finalize?: ReturnType<typeof createStoreIntake>;
};
export function parseStore<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new AppStoreError('invalid'); return parsed.data;
}
export async function storeBody(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch (error) { if (error instanceof SyntaxError) throw new AppStoreError('invalid'); throw error; }
}
export function storeId(c: Context, name = 'versionId') { return parseStore(contract.AppStoreIdSchema, c.req.param(name)); }
export function storeSlug(c: Context) { return parseStore(contract.AppStoreSlugSchema, c.req.param('slug')); }
export function requireStoreObjects(deps: StoreRouteDeps) { if (!deps.objects) throw new AppStoreError('unavailable'); return deps.objects; }
export function createStoreInternalRoutes(deps: StoreRouteDeps) {
  const app = new Hono<StoreRouteEnv>();
  const buckets = new Map<string, { at: number; count: number }>(); // Max 2048; TTL60s and oldest eviction below.
  const quotas = new Map<string, { at: number; count: number }>(); // Max2048 owner/action buckets, TTL1h; oldest eviction at cap.
  let inFlight = 0;
  app.onError((error, c) => storeFailure(c, error));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store, private'); c.header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(c.req.method)) return bodyLimit({ maxSize: 512 * 1024, onError: ctx => ctx.json({ error: 'limit' }, 413) })(c, next);
    await next();
  });
  app.use('*', async (c, next) => {
    const handle = parseStore(z.string().regex(HANDLE_PATTERN), c.req.param('handle'));
    if (!deps.platformSecret) throw new AppStoreError('unavailable');
    const token = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{1,256})$/)?.[1];
    if (!timingSafeTokenEquals(token, buildPlatformVerificationToken(handle, deps.platformSecret))) throw new AppStoreError('unauthorized');
    const time = Date.now();
    for (const [key, bucket] of buckets) if (time - bucket.at >= 60_000) buckets.delete(key);
    const key = handle; const bucket = buckets.get(key) ?? { at: time, count: 0 };
    if (bucket.count >= 120 || inFlight >= 4) throw new AppStoreError('limit');
    if (!buckets.has(key) && buckets.size >= 2048) buckets.delete(buckets.keys().next().value!);
    bucket.count++; buckets.set(key, bucket); inFlight++;
    try {
      // Handle HMAC does not authenticate a human on a shared/preview machine.
      // Check every authoritative exact-handle row before selecting customer primary.
      const machines = await deps.db.executor.selectFrom('user_machines').select(['provisioning_class', 'access_clerk_user_ids', 'clerk_user_id'])
        .where('handle', '=', handle).where('deleted_at', 'is', null).limit(17).execute();
      if (!machines.length || machines.length > 16 || machines.some(machine => !['customer', 'private-preview'].includes(machine.provisioning_class) || machine.access_clerk_user_ids.length > 0)) throw new AppStoreError('forbidden');
      const machine = await getRunningUserMachineByHandle(deps.db, handle);
      if (!machine || machines.some(row => row.clerk_user_id !== machine.clerkUserId)) throw new AppStoreError('forbidden');
      if (machine.provisioningClass === 'private-preview' && !(await deps.privatePreviewEligibility?.(machine))) throw new AppStoreError('forbidden');
      if (machine.provisioningClass === 'customer' && machines.some(row => row.provisioning_class !== 'customer')) throw new AppStoreError('forbidden');
      const user = machine ? await getPlatformUserByClerkId(deps.db, machine.clerkUserId) : null;
      if (!machine || !user || user.status !== 'active') throw new AppStoreError('forbidden');
      c.set('storeActor', { userId: user.clerkId, handle: user.handle }); c.set('storeReviewer', deps.config.reviewers.includes(user.clerkId));
      c.set('storeOwnerTerms', [user.email, user.displayName, user.handle].filter(Boolean));
      if (c.req.path.endsWith('/status') && c.req.method === 'GET') { await next(); return; }
      if (!deps.config.enabled) throw new AppStoreError('unavailable');
      const action = c.req.method === 'POST' && c.req.path.endsWith('/submissions') ? 'create'
        : ['PUT', 'DELETE'].includes(c.req.method) && c.req.path.endsWith('/install') ? 'install'
        : ['PUT', 'DELETE'].includes(c.req.method) && c.req.path.endsWith('/rating') ? 'rating' : null;
      if (action) {
        for (const [quotaKey, quota] of quotas) if (time - quota.at >= 3_600_000) quotas.delete(quotaKey);
        const quotaKey = `${user.clerkId}:${action}`; const quota = quotas.get(quotaKey) ?? { at: time, count: 0 };
        if (quota.count >= (action === 'create' ? 10 : 60)) throw new AppStoreError('limit');
        if (!quotas.has(quotaKey) && quotas.size >= 2048) quotas.delete(quotas.keys().next().value!);
        quota.count++; quotas.set(quotaKey, quota);
      }
      if (deps.env?.ACCOUNT_DELETION_SECRET !== undefined) {
        await withAccountDeletionOwnerLock(deps.db, user.clerkId, async (_trx, admission) => {
          const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
          if (admission.runtimeAccess === 'blocked' || mutation && !admission.newWorkAllowed) throw new AppStoreError('conflict');
          await next(); if (c.error) throw c.error;
        }, deps.env);
      } else await next();
    } finally { inFlight--; }
  });
  app.get('/status', c => c.json({ enabled: deps.config.enabled, reviewer: c.get('storeReviewer'), signingKeys: deps.config.signingKeys }));
  app.get('/listings', async c => c.json(await deps.repository.catalog(parseStore(contract.AppStoreCatalogQuerySchema, c.req.query()))));
  app.get('/listings/:slug', async c => c.json(await deps.repository.detail(storeSlug(c), c.get('storeActor').userId)));
  app.get('/listings/:slug/icon', async c => {
    const detail = await deps.repository.detail(storeSlug(c), c.get('storeActor').userId);
    if (!detail.currentVersion || !deps.review) throw new AppStoreError('not_found');
    const version = await deps.repository.getVersion(detail.currentVersion.id);
    const icon = version.manifest.icon; if (!icon) throw new AppStoreError('not_found');
    const files = await deps.review.files(version); const bytes = files.files.get(icon);
    if (!bytes || bytes.length > 256 * 1024) throw new AppStoreError('not_found');
    const png = icon.endsWith('.png') && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const svg = icon.endsWith('.svg') && /<svg[\s>]/i.test(bytes.toString('utf8'));
    if (!png && !svg) throw new AppStoreError('not_found');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    c.header('Content-Type', png ? 'image/png' : 'image/svg+xml'); return c.body(new Uint8Array(bytes));
  });
  app.post('/listings/:slug/download', async c => {
    const input = parseStore(contract.AppStoreDownloadRequestSchema, await storeBody(c));
    const version = await deps.repository.downloadVersion(storeSlug(c), c.get('storeActor').userId, input.versionId);
    if (!version.approval_key_id || !version.approval_signature) throw new AppStoreError('unavailable');
    return c.json({ versionId: version.id, version: version.version, source: { url: await requireStoreObjects(deps).download(version.source_object_key), sha256: version.source_sha256, size: version.source_size },
      approval: { keyId: version.approval_key_id, signature: version.approval_signature }, capabilities: version.capabilities, capabilitiesDigest: version.capabilities_digest, manifest: version.manifest });
  });
  app.put('/listings/:slug/install', async c => {
    const input = parseStore(contract.AppStoreDownloadRequestSchema, await storeBody(c));
    return c.json(await deps.repository.install(c.get('storeActor').userId, storeSlug(c), input.versionId));
  });
  app.delete('/listings/:slug/install', async c => c.json(await deps.repository.uninstall(c.get('storeActor').userId, storeSlug(c))));
  app.put('/listings/:slug/rating', async c => {
    const input = parseStore(contract.AppStoreRatingInputSchema, await storeBody(c));
    return c.json(await deps.repository.rate(c.get('storeActor').userId, storeSlug(c), input.stars));
  });
  app.delete('/listings/:slug/rating', async c => c.json(await deps.repository.rate(c.get('storeActor').userId, storeSlug(c), null)));
  app.post('/submissions', async c => {
    const objects = requireStoreObjects(deps);
    const input = parseStore(contract.AppStoreCreateSubmissionSchema, await storeBody(c));
    const version = await deps.repository.createSubmission(c.get('storeActor'), input);
    if (version.status === 'awaiting_upload' && Date.parse(version.created_at) + 86_400_000 <= Date.now()) throw new AppStoreError('conflict');
    return c.json({ versionId: version.id, status: version.status, ...(version.status === 'awaiting_upload' ? { upload: { url: await objects.upload(version.source_object_key, version.source_size), expiresAt: new Date(Date.now() + 900_000).toISOString() } } : {}) }, 201);
  });
  app.get('/submissions', async c => {
    const query = parseStore(z.strictObject({ cursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional() }), c.req.query());
    return c.json(await deps.repository.submissions(c.get('storeActor').userId, query.cursor));
  });
  app.post('/submissions/:versionId/finalize', async c => {
    const id = storeId(c); if (!deps.finalize) throw new AppStoreError('unavailable');
    const version = await deps.finalize(c.get('storeActor').userId, id, c.get('storeOwnerTerms'));
    const listing = await deps.db.executor.selectFrom('app_store_listings').select('slug').where('id', '=', version.listing_id).executeTakeFirstOrThrow();
    return c.json(submissionSummary(version, listing.slug));
  });
  app.post('/submissions/:versionId/withdraw', async c => {
    const version = await deps.repository.withdraw(c.get('storeActor').userId, storeId(c));
    const listing = await deps.db.executor.selectFrom('app_store_listings').select('slug').where('id', '=', version.listing_id).executeTakeFirstOrThrow();
    return c.json(submissionSummary(version, listing.slug));
  });
  return app;
}
