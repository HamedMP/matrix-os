import { afterEach, describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { mailTestDatabase } from './mail-test-database.js';
import { MailArchiveRepository } from '../../packages/gateway/src/mail/repository.js';
const key = { ownerId: 'owner', accountId: 'account' };
const input = { ...key, provider: 'gmail' as const, connectionId: 'conn', email: 'reader@example.test', group: 'personal' as const };
let clean: (() => Promise<void>) | undefined, repository: MailArchiveRepository | undefined;
async function fixture() {
    const db = await mailTestDatabase();
    clean = db.cleanup;
    repository = new MailArchiveRepository(db.dialect);
    await repository.bootstrap();
    const source = await repository.registerSource(input);
    await repository.grantConsumer({ ...key, appId: 'edition' });
    await repository.grantConsumer({ ...key, appId: 'folio' });
    const message = { ...key, messageId: 'message', threadId: 'thread', subject: 'A letter', sender: 'Weekly', receivedAt: '2026-10-07T12:00:00Z', labels: ['INBOX', 'UNREAD'], object: { namespace: source.namespace, digest: 'a'.repeat(64), sizeBytes: 10 } };
    const saved = await repository.saveMessage(message);
    if (saved.kind !== 'saved')
        throw Error('Expected saved');
    return { repo: repository, message, saved: saved.message };
}
afterEach(async () => {
    await repository?.destroy();
    await clean?.();
    repository = undefined;
    clean = undefined;
});
describe('owner retention choices', () => {
    it('stops imports while keeping granted history and explicitly resumes through connect', async () => {
        const { repo, message, saved } = await fixture();
        await repo.changeRetention({ ...key, appId: 'edition', mode: 'keep' });
        expect(await repo.getSource(key)).toMatchObject({ paused: true, usedBytes: 10 });
        expect(await repo.readMessage({ ...key, appId: 'edition', id: saved.id })).not.toBeNull();
        await expect(repo.saveMessage({ ...message, messageId: 'new' })).rejects.toMatchObject({ code: 'denied' });
        await repo.registerSource(input);
        expect(await repo.getSource(key)).toMatchObject({ paused: false });
        await expect(repo.saveMessage({ ...message, messageId: 'new' })).resolves.toMatchObject({ kind: 'saved' });
    });
    it('purges retained history atomically, revokes consumers and suppresses replay without touching source labels', async () => {
        const { repo, message, saved } = await fixture();
        const range = { ...key, rangeFrom: '2026-07-01T00:00:00Z', rangeUntil: '2026-10-07T13:00:00Z' };
        await repo.enqueueSync(range);
        const lease = await repo.claimSync({ ...key, workerId: 'active' });
        await repo.saveReadingState({ ...key, appId: 'edition', id: saved.id, baseRevision: 0, saved: true, read: false, progress: .5 });
        await repo.changeRetention({ ...key, appId: 'edition', mode: 'purge' });
        expect(await repo.getSource(key)).toMatchObject({ paused: true, usedBytes: 0 });
        expect(await repo.listGrantedSources({ ownerId: 'owner', appId: 'edition' })).toEqual([]);
        expect(await repo.listGrantedSources({ ownerId: 'owner', appId: 'folio' })).toEqual([]);
        expect(await repo.getStoredMessage({ ...key, messageId: message.messageId })).toBeNull();
        expect(await repo.isSuppressed({ ...key, messageId: message.messageId })).toBe(true);
        expect(await repo.completeSync({ ...key, token: lease!.token })).toBe(false);
        await repo.registerSource(input);
        expect(await repo.saveMessage(message)).toEqual({ kind: 'suppressed' });
        expect(message.labels).toEqual(['INBOX', 'UNREAD']);
    });
    it('erases private headers, excerpts and corrections including legacy tombstones without refreshing deletion time', async () => {
        const { repo, message, saved } = await fixture();
        await repo.saveMessage({ ...message, textSnippet: 'Private retained excerpt' });
        await repo.setCorrection({ ...key, appId: 'edition', id: saved.id, baseRevision: 2, correction: 'newsletter' });
        const older = '2026-01-01T00:00:00Z';
        await sql `UPDATE mail_messages SET deleted_at=${older} WHERE owner_id=${key.ownerId} AND account_id=${key.accountId}`.execute(repo.kysely);
        await repo.changeRetention({ ...key, appId: 'edition', mode: 'purge' });
        const row = (await sql<{
            metadata: unknown;
            correction: unknown;
            object: unknown;
            size_bytes: string;
            deleted_at: Date;
        }> `SELECT metadata,correction,object,size_bytes,deleted_at FROM mail_messages WHERE owner_id=${key.ownerId} AND account_id=${key.accountId}`.execute(repo.kysely)).rows[0];
        expect(row.metadata).toEqual({});
        expect(row.correction).toBeNull();
        expect(row.object).toBeNull();
        expect(Number(row.size_bytes)).toBe(0);
        expect(new Date(row.deleted_at).toISOString()).toBe(new Date(older).toISOString());
    });
    it.skipIf(!process.env.MATRIX_MAIL_TEST_DATABASE_URL)('serializes purge with an active Folio message read without grant/message lock inversion', async () => {
        const { repo, saved } = await fixture();
        let allowRead!: () => void;
        const gate = new Promise<void>(resolve => allowRead = resolve);
        let ready!: () => void;
        const locked = new Promise<void>(resolve => ready = resolve);
        let purgePid: number | undefined;
        const reader = repo.withTransaction(async (tx) => {
            await sql `SELECT 1 FROM mail_consumer_grants WHERE owner_id=${key.ownerId} AND account_id=${key.accountId} AND app_id='folio' FOR SHARE`.execute(tx.kysely);
            ready();
            await gate;
            return tx.getReadingState({ ...key, appId: 'folio', id: saved.id });
        });
        await locked;
        const purge = repo.withTransaction(async (tx) => {
            purgePid = (await sql<{
                pid: number;
            }> `SELECT pg_backend_pid() pid`.execute(tx.kysely)).rows[0].pid;
            return tx.changeRetention({ ...key, appId: 'edition', mode: 'purge' });
        });
        // Attach handlers before provoking the old-order deadlock, so no rejection leaks.
        const settled = Promise.allSettled([reader, purge]);
        try {
            let blocked = false;
            for (let n = 0; n < 200; n++) {
                if (purgePid) {
                    const row = (await sql<{
                        blocked: boolean;
                    }> `SELECT cardinality(pg_blocking_pids(${purgePid}))>0 blocked`.execute(repo.kysely)).rows[0];
                    if (row.blocked) {
                        blocked = true;
                        break;
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(blocked).toBe(true);
        }
        finally {
            allowRead();
        }
        const results = await settled;
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(await repo.listGrantedSources({ ownerId: 'owner', appId: 'folio' })).toEqual([]);
    }, 10000);
    it('denies shared consumers and invalid choices before any retention change', async () => {
        const { repo, saved } = await fixture();
        await expect(repo.changeRetention({ ...key, appId: 'folio', mode: 'purge' })).rejects.toMatchObject({ code: 'denied' });
        await expect(repo.changeRetention({ ...key, appId: 'edition', mode: 'unknown' as never })).rejects.toMatchObject({ code: 'denied' });
        expect(await repo.getSource(key)).toMatchObject({ paused: false, usedBytes: 10 });
        expect(await repo.readMessage({ ...key, appId: 'edition', id: saved.id })).not.toBeNull();
    });
    it('requires the exact current Edition consent before changing retention', async () => {
        const { repo } = await fixture();
        await expect(repo.changeRetention({ ...key, ownerId: 'other', appId: 'edition', mode: 'purge' })).rejects.toMatchObject({ code: 'denied' });
        await repo.revokeConsumer({ ...key, appId: 'edition' });
        await expect(repo.changeRetention({ ...key, appId: 'edition', mode: 'keep' })).rejects.toMatchObject({ code: 'denied' });
    });
});
