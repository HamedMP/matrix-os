import { sql, type Kysely } from 'kysely';
import { bounded, json } from './reading.js';
import { MailArchiveError, type StoredCleanupPlan, type StoredCleanupEntry, type StoredCleanupOperation } from './types.js';
export interface MailCleanupRecoveryRequest {
    ownerId: string;
    appId: string;
    limit?: number;
}
export interface MailCleanupRecovery {
    operation: StoredCleanupOperation;
    messageIds: string[];
}
/** Recover only submitted receipts from currently granted content; never create a plan. */
export async function listRecoverableCleanupOperations(db: Kysely<unknown>, input: MailCleanupRecoveryRequest): Promise<MailCleanupRecovery[]> {
    bounded(input.ownerId);
    if (input.appId !== 'edition')
        throw new MailArchiveError('denied');
    const limit = Math.min(20, input.limit ?? 20);
    if (!Number.isSafeInteger(limit) || limit < 1)
        throw new MailArchiveError('invalid');
    const rows = (await sql<{
        id: string;
        payload: unknown;
        entries: unknown;
        message_ids: unknown;
    }> `
  SELECT o.id,p.payload,
   (SELECT jsonb_agg(e.payload ORDER BY e.message_id) FROM mail_cleanup_operation_entries e WHERE e.operation_id=o.id) AS entries,
   (SELECT jsonb_agg(m.id ORDER BY m.id) FROM mail_messages m
    JOIN mail_cleanup_operation_entries e ON e.operation_id=o.id AND e.message_id=m.message_id
    WHERE m.owner_id=o.owner_id AND m.account_id=o.account_id AND m.deleted_at IS NULL
    AND (g.range_from IS NULL OR m.received_at>=g.range_from) AND (g.range_until IS NULL OR m.received_at<=g.range_until)) AS message_ids
  FROM mail_cleanup_operations o
  JOIN mail_cleanup_plans p ON p.id=o.plan_id AND p.owner_id=o.owner_id AND p.account_id=o.account_id
  JOIN mail_consumer_grants g ON g.owner_id=o.owner_id AND g.account_id=o.account_id
  WHERE o.owner_id=${input.ownerId} AND g.app_id='edition' AND NOT g.revoked
   AND EXISTS(SELECT 1 FROM mail_cleanup_operation_entries e JOIN mail_messages m
    ON m.owner_id=o.owner_id AND m.account_id=o.account_id AND m.message_id=e.message_id AND m.deleted_at IS NULL
    WHERE e.operation_id=o.id AND e.state IN ('unknown','dispatching','undo_pending','confirmed')
    AND (g.range_from IS NULL OR m.received_at>=g.range_from) AND (g.range_until IS NULL OR m.received_at<=g.range_until))
  ORDER BY p.expires_at DESC,o.id DESC LIMIT ${limit}
 `.execute(db)).rows;
    return rows.map(row => ({ operation: { id: row.id, plan: json<StoredCleanupPlan>(row.payload), entries: json<StoredCleanupEntry[]>(row.entries) }, messageIds: json<string[]>(row.message_ids) }));
}
