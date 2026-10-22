import { CanonicalChatIdSchema, CanonicalOwnerScopeSchema } from '@matrix-os/contracts';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod/v4';
import { consumeServerChatInsertReceipt, type ServerChatInsertReceipt } from '../../chat/creation-repository.js';
import type { ChatOwner } from '../../chat/records.js';
import { boundedProvenanceTransaction } from '../provenance/transaction.js';
import { createGoogleContextStore, type GoogleContext } from './contexts.js';
import { lockGoogleContexts } from './contexts-schema.js';
import { migrateOrdinaryCopyReceipts } from '../provenance/ordinary-copy-receipts.js';

export type GoogleModelHistory = { classification: 'unknown'; googleContext?: GoogleContext }
  | { classification: 'ordinary' } | { classification: 'google'; googleContext: GoogleContext };
export interface GoogleModelHistoryOptions { now?: () => Date; maxBirths?: number; maxBirthsPerOwner?: number }
export class GoogleModelHistoryUnavailable extends Error {
  constructor() { super('Saved context unavailable'); this.name = 'GoogleModelHistoryUnavailable'; }
}
const deny = (): never => { throw new GoogleModelHistoryUnavailable(); };
const revisionSchema = z.number().int().min(1).max(2_147_483_647).optional();

/** Private trusted composition, not a client approval API. Birth proves only the server-created empty
 * history boundary; it never qualifies a provider/opaque session or approves onward processing.
 * Pass an actual caller transaction to join content writes atomically. Host owns the database. */
export function createGoogleModelHistoryStore<DB>(db: Kysely<DB>, options: GoogleModelHistoryOptions = {}) {
  const maxBirths = options.maxBirths ?? 200_000;
  const maxOwned = options.maxBirthsPerOwner ?? 10_000;
  if (![maxBirths, maxOwned].every(value => Number.isSafeInteger(value) && value > 0)
    || maxBirths > 200_000 || maxOwned > 10_000) deny();
  const contextOptions = options.now ? { now: options.now } : {};
  async function inspect(tx: Kysely<DB>, owner: ChatOwner, chatId: string): Promise<GoogleModelHistory> {
    // Google processing is currently personal-only. Organization IDs must never alias a personal identity.
    if (owner.type !== 'personal') return { classification: 'unknown' };
    const owned = (await sql<{ born: boolean }>`SELECT EXISTS(SELECT 1 FROM google_model_history_births b
      WHERE b.chat_id=c.id AND b.owner_type=c.owner_type AND b.owner_id=c.owner_id) AS born
      FROM chats c WHERE c.id=${chatId} AND c.owner_type=${owner.type} AND c.owner_id=${owner.ownerId}`.execute(tx)).rows[0];
    if (!owned) return { classification: 'unknown' };
    const googleContext = await createGoogleContextStore(tx, contextOptions).inspect(owner.ownerId, chatId);
    if (!owned.born) return { classification: 'unknown', ...(googleContext ? { googleContext } : {}) };
    return googleContext ? { classification: 'google', googleContext } : { classification: 'ordinary' };
  }
  return {
    async migrate() {
      await boundedProvenanceTransaction(db, async tx => {
        await createGoogleContextStore(tx, contextOptions).migrate();
        await lockGoogleContexts(tx);
        await sql`CREATE TABLE IF NOT EXISTS google_model_history_births (
          chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
          owner_type TEXT NOT NULL CHECK(owner_type='personal'), owner_id TEXT NOT NULL CHECK(char_length(owner_id) BETWEEN 1 AND 160),
          created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`.execute(tx);
        await sql`CREATE INDEX IF NOT EXISTS google_model_history_births_owner ON google_model_history_births(owner_type,owner_id)`.execute(tx);
        await migrateOrdinaryCopyReceipts(tx);
      });
    },
    /** Install only on successful canonical empty-chat INSERT, before its transaction commits.
     * A row updated/created in another transaction cannot receive a retrospective birth. */
    async recordServerCreatedEmptyChat<T>(tx: Kysely<T>, ownerInput: ChatOwner, chatIdInput: string, receipt: ServerChatInsertReceipt): Promise<void> {
      const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
      const chatId = CanonicalChatIdSchema.parse(chatIdInput);
      if (owner.type !== 'personal') return;
      if (!tx.isTransaction || !consumeServerChatInsertReceipt(receipt, tx, owner, chatId)) deny();
      await boundedProvenanceTransaction(tx, async executor => {
        await lockGoogleContexts(executor);
        const fresh = (await sql`SELECT 1 FROM chats c WHERE c.id=${chatId} AND c.owner_type=${owner.type}
          AND c.owner_id=${owner.ownerId} AND c.xmin=pg_current_xact_id()::xid
          AND c.revision=0 AND c.message_count=0 AND c.lifecycle='active' AND c.collaboration IS NULL
          AND c.fork_provenance IS NULL AND c.bound_driver_kind IS NULL AND c.bound_instance_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.chat_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM chat_runs r WHERE r.chat_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM chat_legacy_imports i WHERE i.chat_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM google_context_markers g WHERE g.owner_id=c.owner_id AND g.chat_id=c.id)`.execute(executor)).rows[0];
        if (!fresh) deny();
        const count = (await sql<{ total: number; owned: number }>`SELECT count(*)::int AS total,
          count(*) FILTER(WHERE owner_id=${owner.ownerId} AND owner_type=${owner.type})::int AS owned FROM google_model_history_births`.execute(executor)).rows[0]!;
        if (count.total >= maxBirths || count.owned >= maxOwned) deny();
        await sql`INSERT INTO google_model_history_births(chat_id,owner_type,owner_id)
          VALUES(${chatId},${owner.type},${owner.ownerId}) ON CONFLICT(chat_id) DO NOTHING`.execute(executor);
      });
    },
    async inspect(ownerInput: ChatOwner, chatIdInput: string): Promise<GoogleModelHistory> {
      const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
      const chatId = CanonicalChatIdSchema.parse(chatIdInput);
      return boundedProvenanceTransaction(db, async tx => {
        await lockGoogleContexts(tx);
        return inspect(tx, owner, chatId);
      });
    },
    /** Hold this transaction through the actual copied-content write. Revalidate after further awaits;
     * source classification alone grants neither recipient consent nor provider dispatch authority. */
    async inherit(ownerInput: ChatOwner, targetChatIdInput: string, sourceChatIdsInput: string[], expectedRevision?: number): Promise<GoogleModelHistory> {
      const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
      const targetChatId = CanonicalChatIdSchema.parse(targetChatIdInput);
      const sourceChatIds = CanonicalChatIdSchema.array().min(1).max(32).parse(sourceChatIdsInput);
      revisionSchema.parse(expectedRevision);
      return boundedProvenanceTransaction(db, async tx => {
        await lockGoogleContexts(tx);
        const target = await inspect(tx, owner, targetChatId);
        if (target.classification === 'unknown' || (target.classification === 'google'
          && (target.googleContext.availability !== 'available' || target.googleContext.revision !== expectedRevision))
          || (target.classification === 'ordinary' && expectedRevision !== undefined)) deny();
        const googleIds: string[] = [];
        for (const sourceId of new Set(sourceChatIds)) {
          const source = await inspect(tx, owner, sourceId);
          if (source.classification === 'unknown' || (source.classification === 'google' && source.googleContext.availability !== 'available')) deny();
          if (source.classification === 'google') googleIds.push(sourceId);
        }
        if (!googleIds.length) {
          const final = await inspect(tx, owner, targetChatId);
          if (final.classification === 'unknown' || (final.classification === 'google' && final.googleContext.availability !== 'available')) deny();
          return final;
        }
        const googleContext = await createGoogleContextStore(tx, contextOptions).inherit(owner.ownerId, targetChatId, googleIds, expectedRevision);
        return { classification: 'google', googleContext };
      });
    },
  };
}
