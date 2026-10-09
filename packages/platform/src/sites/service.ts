import { randomUUID } from 'node:crypto';
import { SiteDeploymentSchema, SiteMetadataSchema, SiteRecordSchema, SitePublishingSchema, type SiteRecord } from '@matrix-os/contracts';
import type { PlatformDB } from '../db.js';
import type { CustomerVpsObjectStore } from '../customer-vps-r2.js';
import { SiteError, type SiteOwner, type SitesTable } from './types.js';
import { sql } from 'kysely';
import { siteOwnerPrefix, withSiteOwnerAdmission, siteOwnerCanServe } from './account-lifecycle.js';
import { assertCurrentPublishingRuntime, createPublishAdmission } from './publish-admission.js';
type Storage = CustomerVpsObjectStore & {
    deleteObject?(key: string, options?: {
        signal?: AbortSignal;
    }): Promise<void>;
};
const key = (owner: string, site: string, version: string, path: string) => `${siteOwnerPrefix(owner)}${site}/${version}/${path}`;
function ownership(db: PlatformDB, owner: SiteOwner) {
    return db.executor.selectFrom('public_sites').selectAll().where('owner_id', '=', owner.ownerId).where('machine_id', '=', owner.machineId).where('app_slug', '=', owner.appSlug);
}
async function project(db: PlatformDB, row: SitesTable): Promise<SiteRecord> {
    const versions = await db.executor.selectFrom('public_site_versions').select(['id', 'created_at']).where('site_id', '=', row.id).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(50).execute();
    const active = row.active_version ? await db.executor.selectFrom('public_site_versions').select('config').where('id', '=', row.active_version).where('site_id', '=', row.id).executeTakeFirst() : undefined;
    return SiteRecordSchema.parse({ id: row.id, appSlug: row.app_slug, title: row.title, description: row.description, slug: row.slug,
        url: `https://matrix.page/${row.slug ?? row.id}`, revision: row.revision, status: row.status, activeVersion: row.active_version,
        versions: versions.map(v => ({ id: v.id, createdAt: v.created_at })), config: active?.config ?? SitePublishingSchema.parse({}) });
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
}) {
    const { db, storage } = options;
    const env = options.env ?? process.env;
    const publishAdmission = createPublishAdmission();
    async function get(owner: SiteOwner) { await db.ready; const row = await ownership(db, owner).executeTakeFirst(); return row ? project(db, row) : null; }
    async function resolve(reference: string, scoped = db) {
        await scoped.ready;
        const row = await scoped.executor.selectFrom('public_sites').selectAll().where(eb => eb.or([
            eb('id', '=', reference), eb('id', 'in', scoped.executor.selectFrom('public_site_aliases').select('site_id').where('slug', '=', reference)),
        ])).where('status', '=', 'published').executeTakeFirst();
        return row && await siteOwnerCanServe(scoped, row.owner_id, env) ? project(scoped, row) : null;
    }
    async function deploy(owner: SiteOwner, input: unknown) {
        return publishAdmission(owner.ownerId, () => deployAdmitted(owner, input));
    }
    async function deployAdmitted(owner: SiteOwner, input: unknown) {
        if (!storage)
            throw new SiteError('unavailable');
        const parsed = SiteDeploymentSchema.safeParse(input);
        if (!parsed.success)
            throw new SiteError('invalid_request');
        const request = parsed.data;
        const version = randomUUID();
        const uploaded: string[] = [];
        let activationCompleted = false;
        const uploadSignal = AbortSignal.timeout(25000);
        try {
            return await withSiteOwnerAdmission(db, owner.ownerId, async (trx) => {
                await sql `SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
                await sql `SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
                await assertCurrentPublishingRuntime(trx, owner);
                const freshId = randomUUID();
                await trx.executor.insertInto('public_sites').values({ id: freshId, owner_id: owner.ownerId, machine_id: owner.machineId, app_slug: owner.appSlug,
                    title: request.title, description: request.description, slug: null, revision: 0, status: 'unpublished', active_version: null, created_at: new Date().toISOString(),
                }).onConflict(oc => oc.columns(['owner_id', 'machine_id', 'app_slug']).doNothing()).execute();
                const row = await ownership(trx, owner).forUpdate().executeTakeFirstOrThrow();
                if (request.baseRevision !== undefined && row.revision !== request.baseRevision)
                    throw new SiteError('conflict');
                await claimAlias(trx, row.id, request.slug);
                if (await trx.executor.selectFrom('public_site_versions').select('id').where('site_id', '=', row.id).limit(50).execute().then(v => v.length >= 50))
                    throw new SiteError('conflict');
                const files = [];
                for (const file of request.files) {
                    const bytes = Buffer.from(file.body, 'base64');
                    const objectKey = key(owner.ownerId, row.id, version, file.path);
                    uploaded.push(objectKey);
                    await storage.putObject(objectKey, bytes, { signal: uploadSignal });
                    files.push({ path: file.path, contentType: file.contentType, bytes: bytes.length });
                }
                await trx.executor.insertInto('public_site_versions').values({ id: version, site_id: row.id, created_at: new Date().toISOString(), config: sql `${JSON.stringify(request.config)}::jsonb`, files: sql `${JSON.stringify(files)}::jsonb` }).execute();
                const changed = await trx.executor.updateTable('public_sites').set({ title: request.title, description: request.description, ...(request.slug !== undefined ? { slug: request.slug } : {}), active_version: version, status: 'published', revision: row.revision + 1 }).where('id', '=', row.id).where('revision', '=', row.revision).returningAll().executeTakeFirst();
                if (!changed)
                    throw new SiteError('conflict');
                const result = await project(trx, changed);
                activationCompleted = true;
                return result;
            }, env);
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
    async function mutate(owner: SiteOwner, revision: number | undefined, apply: (trx: PlatformDB, row: SitesTable) => Promise<Partial<SitesTable>>) {
        return withSiteOwnerAdmission(db, owner.ownerId, async (trx) => {
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
        }, env);
    }
    async function patch(owner: SiteOwner, input: unknown) {
        const parsed = SiteMetadataSchema.safeParse(input);
        if (!parsed.success)
            throw new SiteError('invalid_request');
        const request = parsed.data;
        return mutate(owner, request.baseRevision, async (trx, row) => { await claimAlias(trx, row.id, request.slug); const { baseRevision: _, ...changes } = request; return changes; });
    }
    async function unpublish(owner: SiteOwner, revision?: number) { return mutate(owner, revision, async () => ({ status: 'unpublished' })); }
    async function rollback(owner: SiteOwner, versionId: string, revision?: number) {
        return mutate(owner, revision, async (trx, row) => {
            const version = await trx.executor.selectFrom('public_site_versions').select('id').where('site_id', '=', row.id).where('id', '=', versionId).executeTakeFirst();
            if (!version)
                throw new SiteError('not_found');
            return { active_version: versionId, status: 'published' };
        });
    }
    async function asset(reference: string, version: string, path: string) {
        if (!storage)
            throw new SiteError('unavailable');
        const site = await resolve(reference);
        if (!site)
            throw new SiteError('not_found');
        const row = await db.executor.selectFrom('public_site_versions').selectAll().where('site_id', '=', site.id).where('id', '=', version).executeTakeFirst();
        const file = row?.files.find(f => f.path === path);
        if (!file)
            throw new SiteError('not_found');
        const ownerRow = await db.executor.selectFrom('public_sites').select('owner_id').where('id', '=', site.id).executeTakeFirst();
        if (!ownerRow)
            throw new SiteError('not_found');
        const object = await storage.getObject(key(ownerRow.owner_id, site.id, version, path), { signal: AbortSignal.timeout(30000) });
        if (!object.body)
            throw new SiteError('not_found');
        const reader = object.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done)
                    break;
                size += part.value.byteLength;
                if (size > file.bytes || size > 10 * 1024 * 1024) {
                    await reader.cancel();
                    throw new SiteError('unavailable');
                }
                chunks.push(part.value);
            }
        }
        finally {
            reader.releaseLock();
        }
        if (size !== file.bytes)
            throw new SiteError('unavailable');
        return { body: Buffer.concat(chunks), contentType: file.contentType };
    }
    async function admitted<T>(reference: string, work: (site: SiteRecord, trx: PlatformDB) => Promise<T>) {
        const initial = await resolve(reference);
        if (!initial)
            throw new SiteError('not_found');
        const ownerRow = await db.executor.selectFrom('public_sites').select('owner_id').where('id', '=', initial.id).executeTakeFirst();
        if (!ownerRow)
            throw new SiteError('not_found');
        return withSiteOwnerAdmission(db, ownerRow.owner_id, async (trx) => {
            const site = await resolve(reference, trx);
            if (!site)
                throw new SiteError('not_found');
            const locked = await trx.executor.selectFrom('public_sites').selectAll().where('id', '=', site.id).forUpdate().executeTakeFirst();
            if (!locked || locked.status !== 'published')
                throw new SiteError('not_found');
            return work(await project(trx, locked), trx);
        }, env);
    }
    return { get, resolve, deploy, patch, unpublish, rollback, asset, admitted };
}
export type SitesService = ReturnType<typeof createSitesService>;
