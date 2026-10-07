import { sql, type Kysely } from 'kysely';
import { mailTransaction, validateScope } from './reading.js';
import { MailArchiveError, type MailConsumerScope } from './types.js';
export interface MailRetentionRequest extends MailConsumerScope {
    mode: 'keep' | 'purge';
}
/** Pausing is independent from source OAuth and retained-content authorization. */
export async function changeMailRetention(db: Kysely<unknown>, input: MailRetentionRequest, now: Date) {
    validateScope(input);
    if (input.appId !== 'edition' || !['keep', 'purge'].includes(input.mode))
        throw new MailArchiveError('denied');
    return mailTransaction(db, async (trx) => {
        // Match importer lock order: account first, then grants and message rows.
        const source = await sql `SELECT 1 FROM mail_sources WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} FOR UPDATE`.execute(trx);
        if (!source.rows.length)
            throw new MailArchiveError('denied');
        // Readers hold grant locks before message locks. Purge must fence every
        // consumer before touching content, including Folio/Atlas active reads.
        const grants = await sql<{
            app_id: string;
            revoked: boolean;
        }> `SELECT app_id,revoked FROM mail_consumer_grants
   WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}
   ${input.mode === 'keep' ? sql `AND app_id='edition'` : sql ``} ORDER BY app_id
   ${input.mode === 'purge' ? sql `FOR UPDATE` : sql `FOR SHARE`}`.execute(trx);
        if (!grants.rows.some(grant => grant.app_id === 'edition' && !grant.revoked))
            throw new MailArchiveError('denied');
        await sql `UPDATE mail_sources SET paused=true,revision=revision+1 ${input.mode === 'purge' ? sql `,used_bytes=0` : sql ``} WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx);
        await sql `UPDATE mail_sync_jobs SET status='completed',token=NULL,worker_id=NULL,lease_until=NULL WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx);
        if (input.mode === 'purge') {
            // Erase legacy tombstone payloads too, retaining only identity/suppression.
            // Existing deletion timestamps stay unchanged; clean tombstones are skipped.
            await sql `UPDATE mail_messages SET deleted_at=COALESCE(deleted_at,${now}),object=NULL,size_bytes=0,metadata='{}'::jsonb,correction=NULL,revision=revision+1
    WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}
     AND (deleted_at IS NULL OR object IS NOT NULL OR size_bytes<>0 OR metadata<>'{}'::jsonb OR correction IS NOT NULL)`.execute(trx);
            await sql `DELETE FROM mail_reading WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx);
            await sql `DELETE FROM mail_classifications WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx);
            await sql `DELETE FROM mail_classification_deferrals WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx);
            await sql `UPDATE mail_consumer_grants SET revoked=true WHERE owner_id=${input.ownerId} AND account_id=${input.accountId}`.execute(trx);
        }
        return { paused: true, purged: input.mode === 'purge' };
    });
}
