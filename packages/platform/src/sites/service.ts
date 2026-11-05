import { randomUUID } from 'node:crypto';
import {
    SITE_ACCESS_LINK_CLAIM_TTL_MS, SITE_PUBLISH_TIMEOUT_MS,
    SITE_VIEWER_SESSION_TTL_MS, SiteAccessClaimSchema, SiteAccessLinkCreateRequestSchema,
    SiteAccessLinkCreateResponseSchema, SiteAccessLinkSummarySchema, SiteAccessLinksQuerySchema,
    SiteAccessLinksResponseSchema,
    SiteDeploymentSchema, SiteIdSchema, SiteMetadataSchema, SiteRecordSchema, SitePublishingSchema,
    type SiteAccessLinkSummary, type SiteRecord,
} from '@matrix-os/contracts';
import type { PlatformDB } from '../db.js';
import type { CustomerVpsObjectStore } from '../customer-vps-r2.js';
import { SiteError, type SiteOwner, type SitesTable } from './types.js';
import { sql, type Selectable, type Updateable } from 'kysely';
import { siteOwnerPrefix, withSiteOwnerAdmission, siteOwnerCanServe } from './account-lifecycle.js';
import { assertCurrentPublishingRuntime, createPublishAdmission } from './publish-admission.js';
import { loadSiteAsset } from './asset-stream.js';
import {
    buildSiteViewerCookie, createSiteAccessSecret, hashSiteAccessSecret,
    readSiteViewerCookie, siteAccessSecretMatches,
} from './access-links.js';
import { packagePrivateSiteHtml } from './private-package.js';
import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';
import { emitSiteTelemetry, type SiteTelemetryCapture } from './telemetry.js';
type Storage = Omit<CustomerVpsObjectStore, 'getObject'> & {
    getObject(key: string, options?: { signal?: AbortSignal }): Promise<{ body: unknown; etag?: string; contentLength?: number }>;
    deleteObject?(key: string, options?: {
        signal?: AbortSignal;
    }): Promise<void>;
};
const key = (owner: string, site: string, version: string, path: string) => `${siteOwnerPrefix(owner)}${site}/${version}/${path}`;
function ownership(db: PlatformDB, owner: SiteOwner) {
    return db.executor.selectFrom('public_sites').selectAll().where('owner_id', '=', owner.ownerId).where('machine_id', '=', owner.machineId).where('app_slug', '=', owner.appSlug);
}
async function project(db: PlatformDB, row: Selectable<SitesTable>): Promise<SiteRecord> {
    const versions = await db.executor.selectFrom('public_site_versions').select(['id', 'created_at']).where('site_id', '=', row.id).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(50).execute();
    const active = row.active_version ? await db.executor.selectFrom('public_site_versions').select('config').where('id', '=', row.active_version).where('site_id', '=', row.id).executeTakeFirst() : undefined;
    return SiteRecordSchema.parse({ id: row.id, appSlug: row.app_slug, title: row.title, description: row.description, slug: row.slug,
        url: `https://matrix.page/${row.slug ?? row.id}`, revision: row.revision, status: row.status, accessMode: row.access_mode,
        activeVersion: row.active_version,
        versions: versions.map(v => ({ id: v.id, createdAt: v.created_at })), config: active?.config ?? SitePublishingSchema.parse({}) });
}
function accessLinkSummary(row: import('./types.js').SiteAccessLinksTable, now = Date.now()): SiteAccessLinkSummary {
    const expired = Date.parse(row.claimed_at ? row.session_expires_at! : row.claim_expires_at) <= now;
    return SiteAccessLinkSummarySchema.parse({
        id: row.id,
        status: expired ? 'expired' : row.claimed_at ? 'claimed' : 'unclaimed',
        createdAt: row.created_at,
        claimExpiresAt: row.claim_expires_at,
        claimedAt: row.claimed_at,
        sessionExpiresAt: row.session_expires_at,
    });
}
async function claimAlias(db: PlatformDB, siteId: string, slug: string | null | undefined) {
    if (!slug)
        return;
    await db.executor.insertInto('public_site_aliases').values({ slug, site_id: siteId }).onConflict(oc => oc.column('slug').doNothing()).execute();
    const claimed = await db.executor.selectFrom('public_site_aliases').selectAll().where('slug', '=', slug).executeTakeFirst();
    if (claimed?.site_id !== siteId)
        throw new SiteError('conflict');
}
export function createSitesService(options: {
    db: PlatformDB;
    storage?: Storage;
    env?: NodeJS.ProcessEnv;
    captureEvent?: SiteTelemetryCapture;
}) {
    const { db, storage } = options;
    const captureEvent = options.captureEvent;
    const env = options.env ?? process.env;
    // Share four long-lived transaction slots across publishing and public submissions.
    // One owner cannot queue lock waiters; lifecycle work retains pool capacity.
    const writeAdmission = createPublishAdmission();
    // Separate bounded management capacity keeps revocation available while
    // publication/submission slots are occupied, without queuing owner waiters.
    const managementAdmission = createPublishAdmission();
    const privateFrames = new Map<string, { expiresAt: number; value: Promise<string> }>();
    const PRIVATE_FRAME_CACHE_MAX = 4;
    const PRIVATE_FRAME_CACHE_TTL_MS = 5 * 60_000;
    async function get(owner: SiteOwner) { await db.ready; const row = await ownership(db, owner).executeTakeFirst(); return row ? project(db, row) : null; }
    async function resolve(reference: string, scoped = db) {
        await scoped.ready;
        const row = await scoped.executor.selectFrom('public_sites').selectAll().where(eb => eb.or([
            eb('id', '=', reference), eb('id', 'in', scoped.executor.selectFrom('public_site_aliases').select('site_id').where('slug', '=', reference)),
        ])).where('status', '=', 'published')
            .where(eb => eb.exists(eb.selectFrom('user_machines').select('machine_id')
                .whereRef('user_machines.machine_id', '=', 'public_sites.machine_id')
                .whereRef('user_machines.clerk_user_id', '=', 'public_sites.owner_id')
                .where('deleted_at', 'is', null).where('status', '!=', 'deleted')))
            .executeTakeFirst();
        return row && await siteOwnerCanServe(scoped, row.owner_id, env) ? project(scoped, row) : null;
    }
    async function deploy(owner: SiteOwner, input: unknown, publication: { deadlineAt?: number; signal?: AbortSignal } = {}) {
        const now = Date.now();
        const deadlineAt = publication.deadlineAt ?? now + SITE_PUBLISH_TIMEOUT_MS;
        if (!Number.isSafeInteger(deadlineAt) || deadlineAt > now + SITE_PUBLISH_TIMEOUT_MS)
            throw new SiteError('invalid_request');
        const check = () => {
            if (publication.signal?.aborted || Date.now() >= deadlineAt)
                throw new SiteError('unavailable');
        };
        check();
        return writeAdmission(owner.ownerId, () => deployAdmitted(owner, input, deadlineAt, check, publication.signal));
    }
    async function deployAdmitted(owner: SiteOwner, input: unknown, deadlineAt: number, check: () => void, callerSignal?: AbortSignal) {
        if (!storage)
            throw new SiteError('unavailable');
        const parsed = SiteDeploymentSchema.safeParse(input);
        if (!parsed.success)
            throw new SiteError('invalid_request');
        const request = parsed.data;
        const version = randomUUID();
        const uploaded: string[] = [];
        let activationCompleted = false;
        check();
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(25000, deadlineAt - Date.now())));
        const uploadSignal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
        // Commit owner inventory before any external upload. A rolled-back first
        // publication must still block account erasure if its bytes cannot be checked.
        await withSiteOwnerAdmission(db, owner.ownerId, async (trx) => {
            check();
            await assertCurrentPublishingRuntime(trx, owner);
            await trx.executor.insertInto('public_sites').values({ id: randomUUID(), owner_id: owner.ownerId, machine_id: owner.machineId, app_slug: owner.appSlug,
                title: request.title, description: request.description, slug: null, revision: 0, status: 'unpublished',
                access_mode: request.accessMode ?? 'public', active_version: null, created_at: new Date().toISOString(),
            }).onConflict(oc => oc.columns(['owner_id', 'machine_id', 'app_slug']).doNothing()).execute();
            check();
        }, env);
        try {
            let operation: 'first_publish' | 'update' | 'republish' = 'first_publish';
            const result = await withSiteOwnerAdmission(db, owner.ownerId, async (trx) => {
                check(); // The owner lock may have consumed the remaining publication budget.
                await sql `SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
                await sql `SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
                await assertCurrentPublishingRuntime(trx, owner);
                check();
                const row = await ownership(trx, owner).forUpdate().executeTakeFirstOrThrow();
                operation = row.active_version
                    ? row.status === 'unpublished' ? 'republish' : 'update'
                    : 'first_publish';
                check();
                if (request.baseRevision !== undefined && row.revision !== request.baseRevision)
                    throw new SiteError('conflict');
                await claimAlias(trx, row.id, request.slug);
                if (await trx.executor.selectFrom('public_site_versions').select('id').where('site_id', '=', row.id).limit(50).execute().then(v => v.length >= 50))
                    throw new SiteError('conflict');
                check();
                const files = [];
                for (const file of request.files) {
                    check();
                    const bytes = Buffer.from(file.body, 'base64');
                    const objectKey = key(owner.ownerId, row.id, version, file.path);
                    uploaded.push(objectKey);
                    await storage.putObject(objectKey, bytes, { signal: uploadSignal });
                    check();
                    files.push({ path: file.path, contentType: file.contentType, bytes: bytes.length });
                }
                await trx.executor.insertInto('public_site_versions').values({ id: version, site_id: row.id, created_at: new Date().toISOString(), config: sql `${JSON.stringify(request.config)}::jsonb`, files: sql `${JSON.stringify(files)}::jsonb` }).execute();
                check();
                if (request.accessMode === 'public' && row.access_mode === 'private_link')
                    await trx.executor.deleteFrom('public_site_access_links').where('site_id', '=', row.id).execute();
                const changed = await trx.executor.updateTable('public_sites').set({ title: request.title, description: request.description,
                    ...(request.slug !== undefined ? { slug: request.slug } : {}),
                    ...(request.accessMode !== undefined ? { access_mode: request.accessMode } : {}),
                    active_version: version, status: 'published', revision: row.revision + 1 }).where('id', '=', row.id).where('revision', '=', row.revision).returningAll().executeTakeFirst();
                check();
                if (!changed)
                    throw new SiteError('conflict');
                const result = await project(trx, changed);
                check(); // Roll back activation if any awaited DB work crossed the deadline.
                activationCompleted = true;
                return result;
            }, env);
            emitSiteTelemetry(captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_PUBLISHED,
                { access_mode: result.accessMode, operation }, owner.ownerId);
            return result;
        }
        catch (error) {
            const cleanupSignal = AbortSignal.timeout(5000);
            // A completed callback may have committed even if its acknowledgement failed.
            // Preserve these owner-scoped bytes for account cleanup rather than risk live assets.
            if (!activationCompleted && storage.deleteObject)
                await Promise.all(uploaded.map(async (objectKey) => {
                    try {
                        await storage.deleteObject!(objectKey, { signal: cleanupSignal });
                    }
                    catch (cleanupError) {
                        console.warn('[sites] candidate cleanup failed', cleanupError instanceof Error ? cleanupError.name : 'UnknownError');
                    }
                }));
            throw error;
        }
    }
    async function mutate(owner: SiteOwner, revision: number | undefined, apply: (trx: PlatformDB, row: Selectable<SitesTable>) => Promise<Updateable<SitesTable>>) {
        return managementAdmission(owner.ownerId, () => withSiteOwnerAdmission(db, owner.ownerId, async (trx) => {
            await sql `SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
            await sql `SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
            await assertCurrentPublishingRuntime(trx, owner);
            const row = await ownership(trx, owner).forUpdate().executeTakeFirst();
            if (!row)
                throw new SiteError('not_found');
            if (revision !== undefined && row.revision !== revision)
                throw new SiteError('conflict');
            const changes = await apply(trx, row);
            const next = await trx.executor.updateTable('public_sites').set({ ...changes, revision: row.revision + 1 }).where('id', '=', row.id).where('revision', '=', row.revision).returningAll().executeTakeFirst();
            if (!next)
                throw new SiteError('conflict');
            return project(trx, next);
        }, env));
    }
    async function patch(owner: SiteOwner, input: unknown) {
        const parsed = SiteMetadataSchema.safeParse(input);
        if (!parsed.success)
            throw new SiteError('invalid_request');
        const request = parsed.data;
        let previousAccessMode: SiteRecord['accessMode'] | undefined;
        const result = await mutate(owner, request.baseRevision, async (trx, row) => {
            previousAccessMode = row.access_mode;
            await claimAlias(trx, row.id, request.slug);
            if (request.accessMode === 'public' && row.access_mode === 'private_link')
                await trx.executor.deleteFrom('public_site_access_links').where('site_id', '=', row.id).execute();
            const { baseRevision: _, accessMode, ...changes } = request;
            return { ...changes, ...(accessMode !== undefined ? { access_mode: accessMode } : {}) };
        });
        const accessModeChanged = previousAccessMode !== undefined && previousAccessMode !== result.accessMode;
        emitSiteTelemetry(captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_SETTINGS_UPDATED,
            { access_mode: result.accessMode, access_mode_changed: accessModeChanged }, owner.ownerId);
        if (accessModeChanged) emitSiteTelemetry(captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_ACCESS_MODE_CHANGED,
            { previous_access_mode: previousAccessMode!, access_mode: result.accessMode }, owner.ownerId);
        return result;
    }
    async function unpublish(owner: SiteOwner, revision?: number) {
        const result = await mutate(owner, revision, async (trx, row) => {
            await trx.executor.deleteFrom('public_site_access_links').where('site_id', '=', row.id).execute();
            return { status: 'unpublished' };
        });
        emitSiteTelemetry(captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_UNPUBLISHED,
            { access_mode: result.accessMode }, owner.ownerId);
        return result;
    }
    async function rollback(owner: SiteOwner, versionId: string, revision?: number) {
        const result = await mutate(owner, revision, async (trx, row) => {
            const version = await trx.executor.selectFrom('public_site_versions').select('id').where('site_id', '=', row.id).where('id', '=', versionId).executeTakeFirst();
            if (!version)
                throw new SiteError('not_found');
            return { active_version: versionId, status: 'published' };
        });
        emitSiteTelemetry(captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_ROLLED_BACK,
            { access_mode: result.accessMode }, owner.ownerId);
        return result;
    }
    async function asset(reference: string, version: string, path: string) {
        if (!storage)
            throw new SiteError('unavailable');
        const site = await resolve(reference);
        if (!site)
            throw new SiteError('not_found');
        const row = await db.executor.selectFrom('public_site_versions').selectAll().where('site_id', '=', site.id).where('id', '=', version).executeTakeFirst();
        const file = row?.files.find(f => f.path === path);
        if (!row || !file)
            throw new SiteError('not_found');
        const ownerRow = await db.executor.selectFrom('public_sites').select('owner_id').where('id', '=', site.id).executeTakeFirst();
        if (!ownerRow)
            throw new SiteError('not_found');
        const body = await loadSiteAsset(signal => storage.getObject(key(ownerRow.owner_id, site.id, version, path), { signal }), file.bytes);
        return { body, contentType: file.contentType, site: { ...site, activeVersion: version, config: SitePublishingSchema.parse(row.config) } };
    }
    async function privateFrame(reference: string, version: string, path: string) {
        if (!storage)
            throw new SiteError('unavailable');
        const site = await resolve(reference);
        if (!site || site.accessMode !== 'private_link' || site.activeVersion !== version)
            throw new SiteError('not_found');
        const cacheKey = `${site.id}:${version}:${path}`;
        const cached = privateFrames.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            privateFrames.delete(cacheKey);
            privateFrames.set(cacheKey, cached);
            return cached.value;
        }
        if (cached) privateFrames.delete(cacheKey);
        const value = (async () => {
            const row = await db.executor.selectFrom('public_site_versions').select('files')
                .where('site_id', '=', site.id).where('id', '=', version).executeTakeFirst();
            if (!row || row.files.length < 1 || row.files.length > 200
                || row.files.reduce((sum, file) => sum + file.bytes, 0) > 10 * 1024 * 1024)
                throw new SiteError('unavailable');
            const owner = await db.executor.selectFrom('public_sites').select('owner_id').where('id', '=', site.id).executeTakeFirst();
            if (!owner) throw new SiteError('not_found');
            const loaded: Array<{ path: string; contentType: string; body: Buffer }> = new Array(row.files.length);
            let cursor = 0;
            await Promise.all(Array.from({ length: Math.min(8, row.files.length) }, async () => {
                while (true) {
                    const index = cursor++;
                    const file = row.files[index];
                    if (!file) return;
                    loaded[index] = { ...file, body: await loadSiteAsset(
                        signal => storage.getObject(key(owner.owner_id, site.id, version, file.path), { signal }), file.bytes) };
                }
            }));
            return packagePrivateSiteHtml(loaded, path);
        })();
        privateFrames.set(cacheKey, { expiresAt: Date.now() + PRIVATE_FRAME_CACHE_TTL_MS, value });
        while (privateFrames.size > PRIVATE_FRAME_CACHE_MAX) privateFrames.delete(privateFrames.keys().next().value!);
        try { return await value; }
        catch (error) { privateFrames.delete(cacheKey); throw error; }
    }
    async function admitted<T>(reference: string, work: (site: SiteRecord, trx: PlatformDB) => Promise<T>, cookieHeader?: string) {
        const initial = await resolve(reference);
        if (!initial)
            throw new SiteError('not_found');
        const ownerRow = await db.executor.selectFrom('public_sites').select('owner_id').where('id', '=', initial.id).executeTakeFirst();
        if (!ownerRow)
            throw new SiteError('not_found');
        return writeAdmission(ownerRow.owner_id, () => withSiteOwnerAdmission(db, ownerRow.owner_id, async (trx) => {
            const site = await resolve(reference, trx);
            if (!site)
                throw new SiteError('not_found');
            const locked = await trx.executor.selectFrom('public_sites').selectAll().where('id', '=', site.id).forUpdate().executeTakeFirst();
            if (!locked || locked.status !== 'published')
                throw new SiteError('not_found');
            const projected = await project(trx, locked);
            if (projected.accessMode === 'private_link') {
                const credential = readSiteViewerCookie(cookieHeader, projected.id);
                const link = credential ? await trx.executor.selectFrom('public_site_access_links').selectAll()
                    .where('id', '=', credential.linkId).where('site_id', '=', projected.id).executeTakeFirst() : undefined;
                if (!credential || !link?.claimed_at || !link.session_token_hash || !link.session_expires_at
                    || Date.parse(link.session_expires_at) <= Date.now()
                    || !siteAccessSecretMatches(credential.token, link.session_token_hash)) throw new SiteError('not_found');
            }
            return work(projected, trx);
        }, env));
    }
    async function authorizeCredential(reference: string, cookieHeader: string | undefined,
        readCredential: typeof readSiteViewerCookie, scoped = db) {
        const site = await resolve(reference, scoped);
        if (!site || site.accessMode === 'public') return site;
        const credential = readCredential(cookieHeader, site.id);
        if (!credential) return null;
        const row = await scoped.executor.selectFrom('public_site_access_links').selectAll()
            .where('id', '=', credential.linkId).where('site_id', '=', site.id).executeTakeFirst();
        if (!row?.claimed_at || !row.session_token_hash || !row.session_expires_at
            || Date.parse(row.session_expires_at) <= Date.now()
            || !siteAccessSecretMatches(credential.token, row.session_token_hash)) return null;
        return site;
    }
    async function authorize(reference: string, cookieHeader?: string, scoped = db) {
        return authorizeCredential(reference, cookieHeader, readSiteViewerCookie, scoped);
    }
    async function listAccessLinks(owner: SiteOwner, input: unknown = {}) {
        const parsed = SiteAccessLinksQuerySchema.safeParse(input);
        if (!parsed.success) throw new SiteError('invalid_request');
        await db.ready;
        const site = await ownership(db, owner).executeTakeFirst();
        if (!site) throw new SiteError('not_found');
        let query = db.executor.selectFrom('public_site_access_links').selectAll()
            .where('site_id', '=', site.id);
        if (parsed.data.cursor) {
            const [createdAt, id] = parsed.data.cursor.split('|');
            query = query.where(sql<boolean>`(created_at, id) < (${createdAt}, ${id})`);
        }
        const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc')
            .limit(parsed.data.limit + 1).execute();
        const page = rows.slice(0, parsed.data.limit);
        const last = page.at(-1);
        return SiteAccessLinksResponseSchema.parse({
            links: page.map(row => accessLinkSummary(row)),
            nextCursor: rows.length > parsed.data.limit && last ? `${last.created_at}|${last.id}` : null,
        });
    }
    async function createAccessLink(owner: SiteOwner, input: unknown) {
        const parsed = SiteAccessLinkCreateRequestSchema.safeParse(input);
        if (!parsed.success) throw new SiteError('invalid_request');
        const result = await managementAdmission(owner.ownerId, () => withSiteOwnerAdmission(db, owner.ownerId, async trx => {
            await assertCurrentPublishingRuntime(trx, owner);
            const site = await ownership(trx, owner).forUpdate().executeTakeFirst();
            if (!site || site.status !== 'published' || site.access_mode !== 'private_link') throw new SiteError('not_found');
            if (site.revision !== parsed.data.baseRevision) throw new SiteError('conflict');
            const now = new Date();
            const id = randomUUID();
            const token = createSiteAccessSecret();
            const row = {
                id, site_id: site.id, claim_token_hash: hashSiteAccessSecret(token), session_token_hash: null,
                created_at: now.toISOString(), claim_expires_at: new Date(now.getTime() + SITE_ACCESS_LINK_CLAIM_TTL_MS).toISOString(),
                claimed_at: null, session_expires_at: null,
            };
            await trx.executor.insertInto('public_site_access_links').values(row).execute();
            return SiteAccessLinkCreateResponseSchema.parse({
                link: accessLinkSummary(row),
                url: `https://matrix.page/${site.id}#access=${id}.${token}`,
            });
        }, env));
        emitSiteTelemetry(captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_LINK_CREATED,
            { access_mode: 'private_link' }, owner.ownerId);
        return result;
    }
    async function revokeAccessLink(owner: SiteOwner, linkId: string) {
        const id = SiteIdSchema.safeParse(linkId);
        if (!id.success) throw new SiteError('invalid_request');
        await managementAdmission(owner.ownerId, () => withSiteOwnerAdmission(db, owner.ownerId, async trx => {
            await assertCurrentPublishingRuntime(trx, owner);
            const site = await ownership(trx, owner).forUpdate().executeTakeFirst();
            if (!site) throw new SiteError('not_found');
            const deleted = await trx.executor.deleteFrom('public_site_access_links').where('site_id', '=', site.id)
                .where('id', '=', id.data).returning('id').executeTakeFirst();
            if (!deleted) throw new SiteError('not_found');
        }, env));
        emitSiteTelemetry(captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_LINK_REVOKED,
            { access_mode: 'private_link' }, owner.ownerId);
    }
    async function claimAccessLink(reference: string, input: unknown) {
        const parsed = SiteAccessClaimSchema.safeParse(input);
        if (!parsed.success) throw new SiteError('invalid_request');
        const initial = await resolve(reference);
        if (!initial || initial.accessMode !== 'private_link') throw new SiteError('not_found');
        const ownerRow = await db.executor.selectFrom('public_sites').select('owner_id').where('id', '=', initial.id).executeTakeFirst();
        if (!ownerRow) throw new SiteError('not_found');
        const result = await managementAdmission(ownerRow.owner_id, () => withSiteOwnerAdmission(db, ownerRow.owner_id, async trx => {
            const current = await resolve(reference, trx);
            if (!current || current.id !== initial.id) throw new SiteError('not_found');
            const site = await trx.executor.selectFrom('public_sites').selectAll().where('id', '=', current.id).forUpdate().executeTakeFirst();
            if (!site || site.status !== 'published' || site.access_mode !== 'private_link') throw new SiteError('not_found');
            const link = await trx.executor.selectFrom('public_site_access_links').selectAll()
                .where('id', '=', parsed.data.linkId).where('site_id', '=', site.id).forUpdate().executeTakeFirst();
            if (!link || link.claimed_at || Date.parse(link.claim_expires_at) <= Date.now()
                || !siteAccessSecretMatches(parsed.data.token, link.claim_token_hash)) throw new SiteError('not_found');
            const sessionToken = createSiteAccessSecret();
            const claimedAt = new Date();
            const changed = await trx.executor.updateTable('public_site_access_links').set({
                claimed_at: claimedAt.toISOString(), session_token_hash: hashSiteAccessSecret(sessionToken),
                session_expires_at: new Date(claimedAt.getTime() + SITE_VIEWER_SESSION_TTL_MS).toISOString(),
            }).where('id', '=', link.id).where('claimed_at', 'is', null).returningAll().executeTakeFirst();
            if (!changed) throw new SiteError('not_found');
            return { cookie: buildSiteViewerCookie(site.id, link.id, sessionToken), link: accessLinkSummary(changed) };
        }, env));
        emitSiteTelemetry(captureEvent, MATRIX_TELEMETRY_EVENTS.MATRIX_PAGE_LINK_CLAIMED,
            { access_mode: 'private_link' }, ownerRow.owner_id);
        return result;
    }
    return { get, resolve, authorize, deploy, patch, unpublish, rollback, asset, privateFrame, admitted,
        listAccessLinks, createAccessLink, revokeAccessLink, claimAccessLink };
}
export type SitesService = ReturnType<typeof createSitesService>;
