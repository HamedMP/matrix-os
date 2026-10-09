import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from '../db.js';
import type { AccountDeletionObjectStore } from '../account-deletion/storage.js';
import { getAccountDeletionAdmission, withAccountDeletionOwnerLock } from '../account-deletion/admission.js';
import { SiteError } from './types.js';
export function siteOwnerPrefix(owner: string): string {
    z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(owner);
    return `sites/owners/${owner}/`;
}
/** Owner advisory lock precedes every site row lock and stays through the write. */
export async function withSiteOwnerAdmission<T>(db: PlatformDB, owner: string, work: (trx: PlatformDB) => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
    return db.transaction(async (trx) => {
        await sql `SET LOCAL lock_timeout = '10s'`.execute(trx.executor);
        await sql `SET LOCAL statement_timeout = '10s'`.execute(trx.executor);
        return withAccountDeletionOwnerLock(trx, owner, async (locked, admission) => {
            if (!admission.newWorkAllowed)
                throw new SiteError('unavailable');
            return work(locked);
        }, env);
    });
}
export async function siteOwnerCanServe(db: PlatformDB, owner: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return (await getAccountDeletionAdmission(db, owner, env)).newWorkAllowed;
}
async function registryExists(db: PlatformDB): Promise<boolean> {
    const result = await sql<{
        present: boolean;
    }> `SELECT to_regclass('public_sites') IS NOT NULL AS present`.execute(db.executor);
    return result.rows[0]?.present === true;
}
/** Revoke first; keep DB inventory until private object erasure succeeds so retries remain safe. */
export async function eraseOwnerSites(db: PlatformDB, owner: string, store: AccountDeletionObjectStore | undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const present = await registryExists(db);
    await withAccountDeletionOwnerLock(db, owner, async (trx) => {
        if (present)
            await trx.executor.updateTable('public_sites').set({ status: 'unpublished', revision: sql `revision + 1` }).where('owner_id', '=', owner).where('status', '=', 'published').execute();
    }, env);
    const known = present ? await db.executor.selectFrom('public_sites').select('id').where('owner_id', '=', owner).limit(1).executeTakeFirst() : undefined;
    if (!store) {
        if (known)
            throw Error('Sites storage cleanup unavailable');
        return;
    }
    const prefix = siteOwnerPrefix(owner);
    await store.abortOwnerMultipartUploads(prefix);
    const deadline = Date.now() + 20000;
    for (let batch = 0; batch < 100; batch++) {
        if (Date.now() > deadline)
            throw Error('Sites storage cleanup pending');
        const page = await store.listObjects(prefix);
        if (page.keys.length > 1000 || page.keys.some(key => !key.startsWith(prefix)))
            throw Error('Sites storage ownership mismatch');
        if (!page.keys.length) {
            if (page.nextCursor)
                throw Error('Sites storage inventory incomplete');
            return;
        }
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(8, page.keys.length) }, async () => {
            for (;;) {
                const current = index++;
                if (current >= page.keys.length)
                    return;
                if (Date.now() > deadline)
                    throw Error('Sites storage cleanup pending');
                await store.deleteObject(page.keys[current]!);
            }
        }));
    }
    throw Error('Sites storage cleanup pending');
}
/** The deletion data step runs this inside its existing owner-locked transaction.
 * Account erasure retains only anonymous slug reservations; the FK clears every site/owner link. */
export async function eraseOwnerSiteRegistry(db: PlatformDB, owner: string): Promise<void> {
    if (await registryExists(db))
        await db.executor.deleteFrom('public_sites').where('owner_id', '=', owner).execute();
}
