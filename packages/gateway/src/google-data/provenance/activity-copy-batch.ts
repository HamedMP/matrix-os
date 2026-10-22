import { sql, type Kysely } from 'kysely';
import { CanonicalChatIdSchema } from '@matrix-os/contracts';
import { GoogleProvenanceUnavailable, validateOpaque, type GoogleCopy, type GoogleOrigin } from './contracts.js';

function validateBatch<DB>(tx: Kysely<DB>, ownerId: string, refs: readonly string[]): void {
  if (!tx.isTransaction || refs.length > 600 || new Set(refs).size !== refs.length) throw new GoogleProvenanceUnavailable();
  validateOpaque(ownerId); refs.forEach(validateOpaque);
}
/** Trusted context -> provenance-global locks precede this ONE sorted copy-lock read.
 * No authority cache or pool ownership; outputs live only through this transaction. */
export async function lockedActivityCopies<DB>(tx: Kysely<DB>, ownerId: string, refs: readonly string[]): Promise<GoogleCopy[]> {
  validateBatch(tx, ownerId, refs); if (!refs.length) return [];
  const rows = (await sql<{ id: string; owner_id: string; entity_ref: string; content_hash: string; origins: GoogleOrigin[];
    revision: number; retention_deadline: Date; retention_decision_id: string; state: GoogleCopy['state'] }>`
    SELECT * FROM google_copy_registry WHERE owner_id=${ownerId} AND kind='derived'
      AND entity_ref=ANY(${refs}::text[]) ORDER BY entity_ref FOR UPDATE`.execute(tx)).rows;
  if (rows.length > refs.length) throw new GoogleProvenanceUnavailable();
  return rows.map(row => ({ id: row.id, ownerId: row.owner_id, kind: 'derived', entityRef: row.entity_ref,
    contentHash: row.content_hash, origins: row.origins, revision: row.revision,
    retentionDeadline: row.retention_deadline.toISOString(), retentionDecisionId: row.retention_decision_id, state: row.state }));
}
/** Match exact current hashes under existing content locks; unknown/mismatched/expired receipts are absent. */
export async function activityReceiptProofs<DB>(tx: Kysely<DB>, ownerId: string, chatId: string,
  inputs: readonly { ref: string; hash: string }[]): Promise<Map<string, string>> {
  validateBatch(tx, ownerId, inputs.map(input => input.ref)); CanonicalChatIdSchema.parse(chatId);
  if (inputs.length > 500 || inputs.some(input => !/^[a-f0-9]{64}$/.test(input.hash))) throw new GoogleProvenanceUnavailable();
  if (!inputs.length) return new Map();
  const rows = (await sql<{ entity_ref: string; expires_at: Date }>`SELECT r.entity_ref,r.expires_at FROM google_ordinary_copy_receipts r
    JOIN google_model_history_births b ON b.chat_id=r.chat_id AND b.owner_id=r.owner_id AND b.owner_type='personal'
    JOIN jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb) i(ref TEXT,hash TEXT) ON r.entity_ref=i.ref AND r.content_hash=i.hash
    WHERE r.owner_id=${ownerId} AND r.chat_id=${chatId} AND r.kind='derived' AND r.expires_at>clock_timestamp()
    ORDER BY r.entity_ref FOR UPDATE OF r`.execute(tx)).rows;
  return new Map(rows.map(row => [row.entity_ref, row.expires_at.toISOString()]));
}
export async function retireActivityReceipts<DB>(tx: Kysely<DB>, ownerId: string, chatId: string, refs: readonly string[]): Promise<void> {
  validateBatch(tx, ownerId, refs); CanonicalChatIdSchema.parse(chatId); if (!refs.length) return;
  await sql`DELETE FROM google_ordinary_copy_receipts WHERE owner_id=${ownerId} AND chat_id=${chatId}
    AND kind='derived' AND entity_ref=ANY(${refs}::text[])`.execute(tx);
}
