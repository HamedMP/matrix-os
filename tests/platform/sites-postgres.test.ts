import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformDb, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
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
