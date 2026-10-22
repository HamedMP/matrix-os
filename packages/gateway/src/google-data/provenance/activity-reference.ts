import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod/v4';
import type { ChatDatabase } from '../../chat/database.js';
import { GoogleProvenanceUnavailable, validateOpaque } from './contracts.js';

export const activityId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
/** Double underscore is disjoint from legacy refs: valid IDs begin with alphanumeric. */
export function googleActivityEntityRef(value: string): string {
  const id = activityId.parse(value);
  return /^[A-Za-z0-9_-]+$/.test(id) ? `gae_${id}` : `gae__${createHash('sha256').update(id).digest('hex')}`;
}
export function isHashedActivityRef(ref: string): boolean { return /^gae__[a-f0-9]{64}$/.test(ref); }
export async function resolveActivitySource(db: Kysely<ChatDatabase>, ownerId: string, entityRef: string) {
  validateOpaque(ownerId); validateOpaque(entityRef);
  const hashed = isHashedActivityRef(entityRef);
  if (!hashed && (!entityRef.startsWith('gae_') || !activityId.safeParse(entityRef.slice(4)).success
    || googleActivityEntityRef(entityRef.slice(4)) !== entityRef)) throw new GoogleProvenanceUnavailable();
  const rows = (await sql<{ id: string; chat_id: string; run_id: string }>`SELECT e.id,e.chat_id,e.run_id
    FROM chat_run_events e JOIN chats c ON c.id=e.chat_id WHERE c.owner_type='personal' AND c.owner_id=${ownerId}
      AND ${hashed ? sql`e.google_activity_entity_ref=${entityRef}` : sql`e.id=${entityRef.slice(4)}`}
    LIMIT 2`.execute(db)).rows;
  if (rows.length > 1 || rows.some(row => googleActivityEntityRef(row.id) !== entityRef)) throw new GoogleProvenanceUnavailable();
  return rows[0];
}
/** Exact validated rows are already content-locked. Mapping is lookup metadata, never origin proof.
 * Missing mappings are created only AFTER existing-copy/ordinary-proof validation and the content CAS. */
export async function mapActivityReferences(db: Kysely<ChatDatabase>, chatId: string, runId: string,
  rows: readonly { id: string; entity_ref: string | null }[]): Promise<void> {
  if (!db.isTransaction || rows.length > 500) throw new GoogleProvenanceUnavailable();
  const incoming = rows.flatMap(row => {
    const ref = googleActivityEntityRef(row.id);
    if (row.entity_ref !== null && row.entity_ref !== ref) throw new GoogleProvenanceUnavailable();
    return isHashedActivityRef(ref) && row.entity_ref === null ? [{ id: row.id, ref }] : [];
  });
  if (!incoming.length) return;
  const result = await sql`UPDATE chat_run_events e SET google_activity_entity_ref=i.ref
    FROM jsonb_to_recordset(${JSON.stringify(incoming)}::jsonb) i(id TEXT,ref TEXT)
    WHERE e.id=i.id AND e.chat_id=${chatId} AND e.run_id=${runId} AND e.google_activity_entity_ref IS NULL RETURNING e.id`.execute(db);
  if (result.rows.length !== incoming.length) throw new GoogleProvenanceUnavailable();
}
