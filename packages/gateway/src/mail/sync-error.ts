import { sql, type Kysely } from 'kysely';
import { z } from 'zod/v4';
import { bounded } from './reading.js';
import { MailArchiveError, type MailSourceKey } from './types.js';
export const mailSyncStateSchema = z.object({ revision: z.number().int().nonnegative(), phase: z.enum(['backfill', 'history']), from: z.number().int().nonnegative(), until: z.number().int().positive(), cursor: z.string().regex(/^\d{1,20}$/).optional(), startHistoryId: z.string().regex(/^\d{1,20}$/).optional(), pageToken: z.string().min(1).max(2048).optional(), pageOffset: z.number().int().min(0).max(500).optional(), pageFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), completedAt: z.iso.datetime().optional(), lastError: z.literal('sync_unavailable').optional(), failureAt: z.iso.datetime().optional() });
export interface MailSyncFailureInput extends MailSourceKey {
    token: string;
    baseRevision: number;
    checkpoint: Record<string, unknown>;
    failureAt: string;
}
/** Preserve resumability and release only the exact live worker lease. */
export async function recordMailSyncFailure(db: Kysely<unknown>, input: MailSyncFailureInput, now: Date): Promise<boolean> {
    bounded(input.ownerId);
    bounded(input.accountId);
    bounded(input.token);
    const failureAt = z.iso.datetime().parse(input.failureAt);
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || input.baseRevision >= Number.MAX_SAFE_INTEGER)
        throw new MailArchiveError('invalid');
    // Provider errors and arbitrary payload fields cannot become durable UI copy.
    const state = mailSyncStateSchema.parse({ ...input.checkpoint, lastError: undefined, failureAt: undefined });
    if (state.revision !== input.baseRevision)
        throw new MailArchiveError('invalid');
    const checkpoint = JSON.stringify({ ...state, revision: input.baseRevision + 1, lastError: 'sync_unavailable', failureAt });
    return (await sql `UPDATE mail_sync_jobs SET checkpoint=${checkpoint}::jsonb,status='pending',token=NULL,worker_id=NULL,lease_until=NULL
  WHERE owner_id=${input.ownerId} AND account_id=${input.accountId} AND token=${input.token} AND status='running' AND lease_until>${now}
   AND COALESCE((checkpoint->>'revision')::bigint,0)=${input.baseRevision} RETURNING id`.execute(db)).rows.length === 1;
}
