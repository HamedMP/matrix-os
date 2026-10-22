import { CanonicalChatIdSchema } from '@matrix-os/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';
import { lockGoogleContexts } from '../runtime/contexts-schema.js';
import { GoogleProvenanceUnavailable, validateOpaque } from './contracts.js';

export interface OrdinaryCopyKey { ownerId: string; chatId: string; kind: 'session' | 'derived'; entityRef: string }
type ReceiptExecutor<DB> = Kysely<DB> | Transaction<DB>;
function validate<DB>(tx: ReceiptExecutor<DB>, key: OrdinaryCopyKey, hash?: string): asserts tx is Transaction<DB> {
  if (!tx.isTransaction || !['session', 'derived'].includes(key.kind) || (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash))) throw new GoogleProvenanceUnavailable();
  validateOpaque(key.ownerId); CanonicalChatIdSchema.parse(key.chatId); validateOpaque(key.entityRef);
}

/** Called after the birth table is created, under its context lock. Metadata only;
 * deletion of a birth/Chat cascades receipts, and expiry cleanup is bounded. */
export async function migrateOrdinaryCopyReceipts<DB>(tx: ReceiptExecutor<DB>): Promise<void> {
  if (!tx.isTransaction) throw new GoogleProvenanceUnavailable();
  await sql`CREATE TABLE IF NOT EXISTS google_ordinary_copy_receipts (
    owner_id TEXT NOT NULL, chat_id TEXT NOT NULL REFERENCES google_model_history_births(chat_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('session','derived')), entity_ref TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(owner_id,kind,entity_ref))`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS google_ordinary_copy_receipts_expiry ON google_ordinary_copy_receipts(expires_at)`.execute(tx);
}

/** Trusted writer only: context -> provenance -> content locks must ALREADY be
 * held before calling. Issuance is atomic with the actual ordinary content write;
 * neither null markers nor caller booleans can certify unknown/old content. */
export async function recordOrdinaryCopyReceipt<DB>(tx: ReceiptExecutor<DB>, key: OrdinaryCopyKey, hash: string): Promise<void> {
  validate(tx, key, hash);
  await lockGoogleContexts(tx);
  await sql`SELECT pg_advisory_xact_lock(551035503)`.execute(tx);
  const ordinary = await sql`SELECT b.chat_id FROM google_model_history_births b JOIN chats c ON c.id=b.chat_id
    WHERE b.chat_id=${key.chatId} AND b.owner_type='personal' AND b.owner_id=${key.ownerId}
    AND c.owner_type=b.owner_type AND c.owner_id=b.owner_id
    AND NOT EXISTS(SELECT 1 FROM google_context_markers m WHERE m.owner_id=b.owner_id AND m.chat_id=b.chat_id)`.execute(tx);
  if (!ordinary.rows.length) throw new GoogleProvenanceUnavailable();
  // Lazy bounded cleanup; never evict live proof or pretend expired proof matches.
  await sql`DELETE FROM google_ordinary_copy_receipts WHERE ctid IN
    (SELECT ctid FROM google_ordinary_copy_receipts WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100)`.execute(tx);
  const saved = await sql`INSERT INTO google_ordinary_copy_receipts(owner_id,chat_id,kind,entity_ref,content_hash,expires_at)
    SELECT ${key.ownerId},${key.chatId},${key.kind},${key.entityRef},${hash},clock_timestamp()+interval '30 days'
    WHERE EXISTS(SELECT 1 FROM google_ordinary_copy_receipts WHERE owner_id=${key.ownerId} AND kind=${key.kind} AND entity_ref=${key.entityRef})
      OR ((SELECT count(*) FROM google_ordinary_copy_receipts)<200000 AND
          (SELECT count(*) FROM google_ordinary_copy_receipts WHERE owner_id=${key.ownerId})<10000)
    ON CONFLICT(owner_id,kind,entity_ref) DO UPDATE SET content_hash=EXCLUDED.content_hash,expires_at=EXCLUDED.expires_at
      WHERE google_ordinary_copy_receipts.chat_id=EXCLUDED.chat_id RETURNING entity_ref`.execute(tx);
  if (!saved.rows.length) throw new GoogleProvenanceUnavailable();
}

/** Proof is historical classification only, never provider/consent authority.
 * Caller rechecks current Google availability after waits and atomically records
 * Google lineage before returning any adopted read/write. */
export async function matchingOrdinaryCopyReceipt<DB>(tx: ReceiptExecutor<DB>, key: OrdinaryCopyKey, hash: string): Promise<string | null> {
  validate(tx, key, hash);
  const result = await sql<{ expires_at: Date }>`SELECT r.expires_at FROM google_ordinary_copy_receipts r
    JOIN google_model_history_births b ON b.chat_id=r.chat_id AND b.owner_id=r.owner_id AND b.owner_type='personal'
    WHERE r.owner_id=${key.ownerId} AND r.chat_id=${key.chatId} AND r.kind=${key.kind} AND r.entity_ref=${key.entityRef}
      AND r.content_hash=${hash} AND r.expires_at>clock_timestamp() FOR UPDATE OF r`.execute(tx);
  return result.rows[0]?.expires_at.toISOString() ?? null;
}

export async function retireOrdinaryCopyReceipt<DB>(tx: ReceiptExecutor<DB>, key: OrdinaryCopyKey): Promise<void> {
  validate(tx, key);
  await sql`DELETE FROM google_ordinary_copy_receipts WHERE owner_id=${key.ownerId} AND chat_id=${key.chatId}
    AND kind=${key.kind} AND entity_ref=${key.entityRef}`.execute(tx);
}
