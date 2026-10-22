import { z } from 'zod/v4';
import { sql, type Kysely } from 'kysely';
import type { ChatDatabase } from '../chat/database.js';
import type { ManagedPiStoppedRunReceipt } from '../chat/managed-pi-quiescence.js';
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema } from '@matrix-os/contracts';
import { boundedProvenanceTransaction } from '../google-data/provenance/transaction.js';
import { GoogleProvenanceUnavailable } from '../google-data/provenance/contracts.js';
const keySchema = z.strictObject({ ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/), chatId: CanonicalChatIdSchema, runId: CanonicalChatRunIdSchema });
const receiptSchema = keySchema.extend({ version: z.literal(1), runtimeHandle: z.string().regex(/^runtime_[a-f0-9]{32}$/), executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), stoppedAt: z.iso.datetime() }).strict();
const deny = (): never => { throw new GoogleProvenanceUnavailable(); };
/** Only the actual managed runtime's awaited onStopped sink calls record. Persisted status alone is never proof. */
export function createGoogleStoppedRunReceipts(database: Kysely<ChatDatabase>, ownerId: string) {
    keySchema.shape.ownerId.parse(ownerId);
    return {
        cleanup: () => boundedProvenanceTransaction(database, tx => sql`DELETE FROM google_managed_stop_receipts WHERE (owner_id,run_id) IN
          (SELECT owner_id,run_id FROM google_managed_stop_receipts WHERE stopped_at<now()-interval '35 days' ORDER BY stopped_at LIMIT 100)`.execute(tx)),
        migrate: () => boundedProvenanceTransaction(database, async (tx) => {
            await sql `CREATE TABLE IF NOT EXISTS google_managed_stop_receipts(owner_id TEXT NOT NULL,chat_id TEXT NOT NULL,
        run_id TEXT NOT NULL,runtime_handle TEXT NOT NULL,execution_generation TEXT NOT NULL,stopped_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY(owner_id,run_id),FOREIGN KEY(run_id) REFERENCES chat_runs(id) ON DELETE CASCADE)`.execute(tx);
        }),
        async record(input: ManagedPiStoppedRunReceipt) {
            const value = receiptSchema.parse(input);
            const at = Date.parse(value.stoppedAt);
            if (value.ownerId !== ownerId || at > Date.now() + 1000 || at < Date.now() - 60000)
                deny();
            await boundedProvenanceTransaction(database, async (tx) => {
                await sql `SELECT pg_advisory_xact_lock(551035506)`.execute(tx);
                const run = await tx.selectFrom('chat_runs as r').innerJoin('chats as c', 'c.id', 'r.chat_id').select('r.id')
                    .where('r.id', '=', value.runId).where('r.chat_id', '=', value.chatId).where('r.driver_kind', '=', 'matrix_pi')
                    .where('c.owner_type', '=', 'personal').where('c.owner_id', '=', ownerId).where('c.collaboration', 'is', null).executeTakeFirst();
                if (!run)
                    deny();
                await sql `DELETE FROM google_managed_stop_receipts WHERE (owner_id,run_id) IN (SELECT owner_id,run_id FROM google_managed_stop_receipts
          WHERE stopped_at<now()-interval '35 days' ORDER BY stopped_at LIMIT 100)`.execute(tx);
                const prior = (await sql<{
                    runtime_handle: string;
                    execution_generation: string;
                    chat_id: string;
                }> `SELECT * FROM google_managed_stop_receipts
          WHERE owner_id=${ownerId} AND run_id=${value.runId} FOR UPDATE`.execute(tx)).rows[0];
                if (prior) {
                    if (prior.runtime_handle !== value.runtimeHandle || prior.execution_generation !== value.executionGeneration || prior.chat_id !== value.chatId)
                        deny();
                    return;
                }
                const count = (await sql<{
                    count: number;
                }> `SELECT count(*)::int AS count FROM google_managed_stop_receipts`.execute(tx)).rows[0]!.count;
                if (count >= 10000)
                    deny();
                await sql `INSERT INTO google_managed_stop_receipts(owner_id,chat_id,run_id,runtime_handle,execution_generation,stopped_at)
          VALUES(${ownerId},${value.chatId},${value.runId},${value.runtimeHandle},${value.executionGeneration},${value.stoppedAt}::timestamptz) ON CONFLICT DO NOTHING`.execute(tx);
            });
        },
        async get(input: {
            ownerId: string;
            chatId: string;
            runId: string;
        }): Promise<ManagedPiStoppedRunReceipt | null> {
            const key = keySchema.parse(input);
            if (key.ownerId !== ownerId)
                deny();
            return boundedProvenanceTransaction(database, async (tx) => {
                const row = (await sql<{
                    runtime_handle: string;
                    execution_generation: string;
                    stopped_at: Date;
                }> `SELECT s.runtime_handle,s.execution_generation,s.stopped_at
          FROM google_managed_stop_receipts s JOIN chat_runs r ON r.id=s.run_id AND r.chat_id=s.chat_id JOIN chats c ON c.id=r.chat_id
          WHERE s.owner_id=${ownerId} AND s.chat_id=${key.chatId} AND s.run_id=${key.runId} AND c.owner_type='personal' AND c.owner_id=${ownerId}
          AND c.collaboration IS NULL AND r.driver_kind='matrix_pi' AND s.stopped_at<=clock_timestamp() AND s.stopped_at>clock_timestamp()-interval '35 days'`.execute(tx)).rows[0];
                return row ? receiptSchema.parse({ ...key, version: 1, runtimeHandle: row.runtime_handle, executionGeneration: row.execution_generation, stoppedAt: row.stopped_at.toISOString() }) : null;
            });
        },
    };
}
