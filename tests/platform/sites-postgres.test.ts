import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformDb, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { withSiteOwnerAdmission, eraseOwnerSites, eraseOwnerSiteRegistry } from '../../packages/platform/src/sites/account-lifecycle.js';
import { SiteError } from '../../packages/platform/src/sites/types.js';
import { migrateSites } from '../../packages/platform/src/sites/migration.js';
const postgresUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const postgres = postgresUrl ? describe : describe.skip;
postgres('public sites independent PostgreSQL sessions', () => {
    const schema = `sites_${randomUUID().replaceAll('-', '')}`;
    let admin: pg.Pool;
    let dbA: PlatformDB;
    let dbB: PlatformDB;
    const owner = { ownerId: 'user_public_sites', machineId: 'sites-runtime', appSlug: 'event' };
    function connectionUrl(name: string) {
        const url = new URL(postgresUrl!);
        if (!url.pathname.includes('test'))
            throw Error('Test database required');
        url.searchParams.set('options', `-c search_path=${schema},public -c statement_timeout=5000`);
        url.searchParams.set('application_name', name);
        return url.toString();
    }
    beforeAll(async () => { admin = new pg.Pool({ connectionString: postgresUrl, max: 1 }); await admin.query(`CREATE SCHEMA "${schema}"`); dbA = createPlatformDb(connectionUrl('sites-admit')); await dbA.ready; dbB = createPlatformDb(connectionUrl('sites-revoke')); await dbB.ready;
        await insertUserMachine(dbA, { machineId: owner.machineId, clerkUserId: owner.ownerId, handle: 'sites-owner', status: 'running', provisionedAt: new Date().toISOString() });
    });
    afterAll(async () => {
        await Promise.all([dbA?.destroy(), dbB?.destroy()]);
        if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
        }
    });
    it('upgrades existing publications to generation 3 without changing old access and enforces invitation state', async () => {
        const id = randomUUID();
        await sql`INSERT INTO public_sites (id, owner_id, machine_id, app_slug, title, description, slug, revision, status, active_version, created_at)
            VALUES (${id}, 'legacy_owner', 'legacy_machine', 'legacy_app', 'Legacy', '', NULL, 0, 'published', NULL, '2026-11-12T00:00:00.000Z')`.execute(dbA.kysely);
        await sql`ALTER TABLE public_sites DROP CONSTRAINT public_sites_access_mode_check`.execute(dbA.kysely);
        await sql`ALTER TABLE public_sites ADD CONSTRAINT public_sites_access_mode_check
            CHECK (access_mode IN ('public','private_link'))`.execute(dbA.kysely);
        await migrateSites(dbA.kysely);
        await migrateSites(dbB.kysely);
        const legacy = await sql<{ access_mode: string }>`SELECT access_mode FROM public_sites WHERE id = ${id}`.execute(dbA.kysely);
        expect(legacy.rows[0]?.access_mode).toBe('public');
        const check = await sql<{ definition: string }>`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conrelid = 'public_sites'::regclass AND conname = 'public_sites_access_mode_check'`.execute(dbA.kysely);
        expect(check.rows).toHaveLength(1);
        expect(check.rows[0]?.definition).toContain('private_email');
        const tableNames = [
            'public_site_email_invitations', 'public_site_viewer_grants', 'public_site_viewer_sessions',
            'public_site_invitation_deliveries', 'public_site_access_audit_events',
            'public_site_recipient_lifecycle', 'public_site_clerk_session_terminations',
        ];
        for (const table of tableNames) {
            const found = await sql<{ name: string | null }>`SELECT to_regclass(${table})::text AS name`.execute(dbA.kysely);
            expect(found.rows[0]?.name, table).toBe(table);
        }
        const indexes = await sql<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`.execute(dbA.kysely);
        const names = new Set(indexes.rows.map(row => row.indexname));
        for (const name of ['public_site_email_invitations_site_email_key', 'public_site_email_invitations_inventory_idx',
            'public_site_viewer_grants_one_active_identity_idx', 'public_site_viewer_sessions_clerk_session_idx',
            'public_site_invitation_deliveries_claim_idx']) expect(names.has(name), name).toBe(true);
        const invitationId = randomUUID();
        await sql`INSERT INTO public_site_email_invitations
            (id, site_id, normalized_email, display_email, generation, state, delivery_state,
             invited_by_clerk_user_id, created_at, issued_at, expires_at, updated_at, revision)
            VALUES (${invitationId}, ${id}, 'recipient@example.com', 'recipient@example.com', 1,
                    'pending', 'queued', 'owner', now(), now(), now() + interval '7 days', now(), 0)`.execute(dbA.kysely);
        await expect(sql`UPDATE public_site_email_invitations SET state = 'accepted' WHERE id = ${invitationId}`.execute(dbA.kysely)).rejects.toThrow();
    });
    it('allows exactly one claim across separate services and independent PostgreSQL connections', async () => {
        const claimant = { ownerId: 'user_private_claim_race', machineId: 'private-claim-race-runtime', appSlug: 'event' };
        await insertUserMachine(dbA, { machineId: claimant.machineId, clerkUserId: claimant.ownerId, handle: claimant.machineId, status: 'running', provisionedAt: new Date().toISOString() });
        const storage = { async putObject() { return {}; }, async getObject() { return { body: null }; } };
        const serviceA = createSitesService({ db: dbA, storage });
        const serviceB = createSitesService({ db: dbB, storage });
        const site = await serviceA.deploy(claimant, { title: 'Private race', accessMode: 'private_link', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('private').toString('base64') }] });
        const link = await serviceA.createAccessLink(claimant, { baseRevision: site.revision });
        const token = link.url.split('.').at(-1)!;
        const outcomes = await Promise.allSettled([
            serviceA.claimAccessLink(site.id, { linkId: link.link.id, token }),
            serviceB.claimAccessLink(site.id, { linkId: link.link.id, token }),
        ]);
        expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
        const rejected = outcomes.find(outcome => outcome.status === 'rejected');
        if (rejected?.status !== 'rejected') throw new Error('missing rejected claim');
        expect(rejected.reason).toMatchObject({ code: 'not_found' });
    });
    it('revoke waits on admitted form lock and all later admissions fail', async () => {
        const storage = { async putObject() { return {}; }, async getObject() { return { body: null }; } };
        const a = createSitesService({ db: dbA, storage });
        const b = createSitesService({ db: dbB, storage });
        const site = await a.deploy(owner, { title: 'Event', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('<h1>Event</h1>').toString('base64') }] });
        const began = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const admission = a.admitted(site.id, async () => { began.resolve(); await finish.promise; return { accepted: true }; });
        await began.promise;
        let revoked = false;
        const revoke = b.unpublish(owner, site.revision).then(() => { revoked = true; });
        try {
            const deadline = Date.now() + 2000;
            let blocked = false;
            while (Date.now() < deadline) {
                const result = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='sites-revoke' AND wait_event_type='Lock'");
                if (result.rows[0].count > 0) {
                    blocked = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 10));
            }
            expect(blocked).toBe(true);
            expect(revoked).toBe(false);
        }
        finally {
            finish.resolve();
            await admission;
            await revoke;
        }
        await expect(a.admitted(site.id, async () => ({ accepted: true }))).rejects.toThrow('not_found');
    });
    it('rejects same-owner submissions before they exhaust the pool and keeps unrelated unpublish responsive', async () => {
        const publisher = { ownerId: 'user_form_admission', machineId: 'form-admission-runtime', appSlug: 'event' };
        const unrelated = { ownerId: 'user_form_unrelated', machineId: 'form-unrelated-runtime', appSlug: 'event' };
        for (const o of [publisher, unrelated]) await insertUserMachine(dbA, { machineId: o.machineId, clerkUserId: o.ownerId, handle: o.machineId, status: 'running', provisionedAt: new Date().toISOString() });
        const service = createSitesService({ db: dbA, storage: { async putObject() { return {}; }, async getObject() { return { body: null }; } } });
        const input = { title: 'Admission', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Admission').toString('base64') }] };
        const site = await service.deploy(publisher, input);
        const other = await service.deploy(unrelated, input);
        const began = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
        const first = service.admitted(site.id, async () => { began.resolve(); await finish.promise; return true; });
        await began.promise;
        let denied = 0;
        const flood = Array.from({ length: 9 }, () => service.admitted(site.id, async () => true).then(() => 'accepted', error => { if (error instanceof SiteError && error.code === 'unavailable') { denied++; return 'denied'; } throw error; }));
        let unpublish: Promise<string> | undefined;
        try {
            const deadline = Date.now() + 2000;
            while (denied !== 9 && Date.now() < deadline) {
                const blocked = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='sites-admit' AND wait_event_type='Lock'");
                if (blocked.rows[0].count >= 9) break;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            unpublish = service.unpublish(unrelated, other.revision).then(() => 'unpublished');
            const lifecycle = await Promise.race([unpublish, new Promise(resolve => setTimeout(() => resolve('pool blocked'), 300))]);
            expect({ denied, lifecycle }).toEqual({ denied: 9, lifecycle: 'unpublished' });
        } finally { finish.resolve(); await Promise.allSettled([first, ...flood, ...(unpublish ? [unpublish] : [])]); }
        expect(await service.admitted(site.id, async () => 'after')).toBe('after');
    });
    it('shares four total transaction admissions between publication and distinct-owner submissions', async () => {
        const owners = Array.from({ length: 5 }, (_, i) => ({ ownerId: `user_shared_admit_${i}`, machineId: `shared-admit-runtime-${i}`, appSlug: 'event' }));
        for (const o of owners) await insertUserMachine(dbA, { machineId: o.machineId, clerkUserId: o.ownerId, handle: o.machineId, status: 'running', provisionedAt: new Date().toISOString() });
        let holdUploads = false;
        const finish = Promise.withResolvers<void>(), uploadBegan = Promise.withResolvers<void>();
        const service = createSitesService({ db: dbA, storage: { async putObject() { if (holdUploads) { uploadBegan.resolve(); await finish.promise; } return {}; }, async getObject() { return { body: null }; } } });
        const input = { title: 'Admission', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Admission').toString('base64') }] };
        const sites = [];
        for (const o of owners) sites.push(await service.deploy(o, input));
        const began = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
        const active = sites.slice(0, 3).map((site, i) => service.admitted(site.id, async () => { began[i]!.resolve(); await finish.promise; return true; }));
        await Promise.all(began.map(b => b.promise));
        holdUploads = true;
        const publication = service.deploy({ ...owners[4]!, appSlug: 'other-app' }, input);
        await uploadBegan.promise;
        try {
            const extra = await service.admitted(sites[3]!.id, async () => true).then(() => 'accepted', error => { if (error instanceof SiteError && error.code === 'unavailable') return 'denied'; throw error; });
            expect(extra).toBe('denied');
        } finally { finish.resolve(); await Promise.allSettled([...active, publication]); }
        await expect(service.admitted(sites[3]!.id, async () => { throw new Error('submission failed'); })).rejects.toThrow('submission failed');
        expect(await service.admitted(sites[3]!.id, async () => 'recovered')).toBe('recovered');
    });
    it.each(['patch', 'rollback', 'unpublish'] as const)('bounds %s waiters before transactions and reserves unrelated unpublish access', async action => {
        const publisher = { ownerId: `user_mgmt_${action}`, machineId: `mgmt-${action}`, appSlug: 'event' };
        const unrelated = { ownerId: `user_mgmt_other_${action}`, machineId: `mgmt-other-${action}`, appSlug: 'event' };
        for (const o of [publisher, unrelated]) await insertUserMachine(dbA, { machineId: o.machineId, clerkUserId: o.ownerId, handle: o.machineId, status: 'running', provisionedAt: new Date().toISOString() });
        const service = createSitesService({ db: dbA, storage: { async putObject() { return {}; }, async getObject() { return { body: null }; } } });
        const input = { title: 'Management', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Management').toString('base64') }] };
        const site = await service.deploy(publisher, input), other = await service.deploy(unrelated, input);
        const began = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
        const active = service.admitted(site.id, async () => { began.resolve(); await finish.promise; });
        await began.promise;
        let denied = 0;
        const flood = Array.from({ length: 9 }, () => {
            const work = action === 'patch' ? service.patch(publisher, { title: 'Changed', baseRevision: site.revision }) : action === 'rollback' ? service.rollback(publisher, site.activeVersion!, site.revision) : service.unpublish(publisher, site.revision);
            return work.then(() => 'accepted', error => { if (error instanceof SiteError && error.code === 'unavailable') { denied++; return 'denied'; } throw error; });
        });
        let revoke: Promise<string> | undefined;
        try {
            const deadline = Date.now() + 2000;
            while (denied !== 8 && Date.now() < deadline) {
                const blocked = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='sites-admit' AND wait_event_type='Lock'");
                if (blocked.rows[0].count >= 9) break;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            revoke = service.unpublish(unrelated, other.revision).then(() => 'unpublished');
            const result = await Promise.race([revoke, new Promise(resolve => setTimeout(() => resolve('pool blocked'), 300))]);
            expect({ denied, result }).toEqual({ denied: 8, result: 'unpublished' });
        } finally { finish.resolve(); await Promise.allSettled([active, ...flood, ...(revoke ? [revoke] : [])]); }
        const current = await service.get(publisher);
        expect((await service.unpublish(publisher, current!.revision)).status).toBe('unpublished');
    });
    it('rechecks the publication deadline after waiting for the real owner lock', async () => {
        const delayedOwner = { ownerId: 'user_delayed_publication', machineId: 'delayed-publish-runtime', appSlug: 'event' };
        await insertUserMachine(dbA, { machineId: delayedOwner.machineId, clerkUserId: delayedOwner.ownerId, handle: delayedOwner.machineId, status: 'running', provisionedAt: new Date().toISOString() });
        const began = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        const env = { ACCOUNT_DELETION_SECRET: 'sites-delayed-publication-lock-secret' };
        const holder = withSiteOwnerAdmission(dbB, delayedOwner.ownerId, async () => { began.resolve(); await release.promise; }, env);
        await began.promise;
        const putObject = vi.fn(async () => ({}));
        const service = createSitesService({ db: dbA, env, storage: { putObject, async getObject() { return { body: null }; } } });
        const expiresAt = Date.now() + 5000;
        const outcome = service.deploy(delayedOwner, { title: 'Delayed', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Delayed').toString('base64') }] }, { deadlineAt: expiresAt }).then(() => 'published', error => { if (error instanceof SiteError && error.code === 'unavailable') return 'expired'; throw error; });
        try {
            const pollUntil = Date.now() + 2000;
            let blocked = false;
            while (Date.now() < pollUntil) {
                const locks = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='sites-admit' AND wait_event_type='Lock'");
                if (locks.rows[0].count > 0) { blocked = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(blocked).toBe(true);
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(expiresAt + 1);
            release.resolve(); await holder;
            expect(await outcome).toBe('expired');
            expect(putObject).not.toHaveBeenCalled();
            expect(await service.get(delayedOwner)).toBeNull();
        } finally { release.resolve(); await Promise.allSettled([holder, outcome]); vi.useRealTimers(); }
    });
    it('retains failed first-upload inventory across independent PostgreSQL sessions until erasure succeeds', async () => {
        const publisher = { ownerId: 'user_failed_first_upload', machineId: 'failed-first-runtime', appSlug: 'event' };
        await insertUserMachine(dbA, { machineId: publisher.machineId, clerkUserId: publisher.ownerId, handle: publisher.machineId, status: 'running', provisionedAt: new Date().toISOString() });
        const objects = new Map<string, Uint8Array>();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const storage = { async putObject(key: string, bytes: unknown) { objects.set(key, bytes as Uint8Array); throw Error('upload acknowledgement lost'); }, async deleteObject() { throw Error('cleanup unavailable'); }, async getObject() { return { body: null }; } };
        try {
            await expect(createSitesService({ db: dbA, storage }).deploy(publisher, { title: 'Failed first upload', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('candidate').toString('base64') }] })).rejects.toThrow('upload acknowledgement lost');
            const reader = createSitesService({ db: dbB });
            expect(await reader.get(publisher)).toMatchObject({ status: 'unpublished', activeVersion: null, versions: [] });
            expect(objects.size).toBe(1);
            await expect(eraseOwnerSites(dbB, publisher.ownerId, undefined)).rejects.toThrow('Sites storage cleanup unavailable');
            expect(await reader.get(publisher)).not.toBeNull();
            await eraseOwnerSites(dbB, publisher.ownerId, { async listObjects(prefix) { return { keys: [...objects.keys()].filter(key => key.startsWith(prefix)), nextCursor: null }; }, async deleteObject(key) { objects.delete(key); }, async abortOwnerMultipartUploads() {} });
            expect(objects.size).toBe(0);
            await eraseOwnerSiteRegistry(dbB, publisher.ownerId);
            expect(await reader.get(publisher)).toBeNull();
        } finally { warning.mockRestore(); }
    });
    it('orders deletion acceptance behind publishing owner lock and blocks every later publication', async () => {
        const env = { ACCOUNT_DELETION_SECRET: 'sites-publishing-deletion-race-secret' };
        const raceOwner = { ...owner, appSlug: 'deletion-race' };
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const service = createSitesService({ db: dbA, env, storage: { async putObject() { started.resolve(); await finish.promise; return {}; }, async getObject() { return { body: null }; } } });
        const publish = service.deploy(raceOwner, { title: 'Race', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('<h1>Race</h1>').toString('base64') }] });
        await started.promise;
        const repository = new AccountDeletionRepository(dbB.kysely, { secret: env.ACCOUNT_DELETION_SECRET });
        let accepted = false;
        const deletion = repository.accept({ clerkUserId: owner.ownerId, appleTokens: [] }, false).then(() => { accepted = true; });
        try {
            const deadline = Date.now() + 2000;
            let blocked = false;
            while (Date.now() < deadline) {
                const result = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='sites-revoke' AND wait_event_type='Lock'");
                if (result.rows[0].count > 0) {
                    blocked = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 10));
            }
            expect(blocked).toBe(true);
            expect(accepted).toBe(false);
        }
        finally {
            finish.resolve();
            await publish;
            await deletion;
        }
        const site = await service.get(raceOwner);
        expect(site).not.toBeNull();
        expect(await service.resolve(site!.id)).toBeNull();
        await expect(service.deploy(raceOwner, { title: 'After deletion', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('later').toString('base64') }] })).rejects.toThrow('unavailable');
    });
});
