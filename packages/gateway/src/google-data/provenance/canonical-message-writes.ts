import { createHash } from 'node:crypto';
import { CanonicalChatIdSchema, CanonicalChatMessageIdSchema, CanonicalChatRunIdSchema, CanonicalOwnerScopeSchema } from '@matrix-os/contracts';
import { sql } from 'kysely';
import type { ChatDatabase } from '../../chat/database.js';
import type { AssistantDeltaExecutor, AssistantDeltaTransact, AssistantDeltaWriteHook, AssistantDeltaWriteKey } from '../../chat/assistant-delta-repository.js';
import { createGoogleModelHistoryStore, type GoogleModelHistory } from '../runtime/model-history.js';
import { GoogleProvenanceUnavailable, originKey, type GoogleCopy, type GoogleOrigin } from './contracts.js';
import { createGoogleProvenanceStore } from './store.js';
import { boundedProvenanceTransaction } from './transaction.js';

const MAX_HASH_BYTES = 512 * 1024;
function deny(): never { throw new GoogleProvenanceUnavailable(); }
function check(signal?: AbortSignal) { if (signal?.aborted) deny(); }
export const canonicalMessageEntityRef = (messageId: string) => `cm_${CanonicalChatMessageIdSchema.parse(messageId)}`;
type AvailableHistory = Exclude<GoogleModelHistory, { classification: 'unknown' }>;
function available(value: GoogleModelHistory): AvailableHistory {
  if (value.classification === 'unknown' || (value.classification === 'google' && value.googleContext.availability !== 'available')) deny();
  return value;
}
const origins = (context: AvailableHistory): GoogleOrigin[] => context.classification === 'ordinary' ? [] : context.googleContext.sources.map(source => ({
  connectionId: source.originId, profileId: source.profileId, profileRevision: source.profileRevision, purpose: source.purposeId,
}));

/** Caller already holds provenance copy -> chat -> run. Lock only the owned assistant and its bounded sidecars. */
async function payloadHash(tx: AssistantDeltaExecutor, key: AssistantDeltaWriteKey): Promise<string | null> {
  const row = (await tx.selectFrom('chat_messages').select(['id', 'run_id', 'role'])
    .where('id', '=', key.messageId).where('chat_id', '=', key.chatId).forUpdate().executeTakeFirst());
  if (!row) return null;
  if (row.role !== 'assistant' || row.run_id !== key.runId) deny();
  const sidecars = (await sql<{ owner_id: string; chat_id: string; run_id: string; valid: boolean }>`SELECT owner_id,chat_id,run_id,
    (jsonb_typeof(envelope)='object' AND octet_length(envelope::text)<=4096) AS valid FROM chat_credentials
    WHERE message_id=${key.messageId} ORDER BY safe_offset,id LIMIT 17 FOR UPDATE`.execute(tx)).rows;
  if (sidecars.length > 16 || sidecars.some(sidecar => !sidecar.valid || sidecar.owner_id !== key.owner.ownerId
    || sidecar.chat_id !== key.chatId || sidecar.run_id !== key.runId)) deny();
  const projection = (await sql<{ canonical: string | null }>`SELECT CASE WHEN jsonb_typeof(m.parts)='array'
    AND octet_length(m.parts::text)<=196608 AND octet_length(m.search_text)<=131072 AND m.byte_count BETWEEN 0 AND 131072
    THEN jsonb_build_object('version',1,'ownerId',${key.owner.ownerId}::text,'chatId',m.chat_id,'messageId',m.id,
      'runId',m.run_id,'turnId',m.turn_id,'seq',m.seq,'role',m.role,'purpose',m.purpose,
      'parts',m.parts,'search',m.search_text,'bytes',m.byte_count,'credentials',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',c.id,'ownerId',c.owner_id,'chatId',c.chat_id,'runId',c.run_id,
          'messageId',c.message_id,'offset',c.safe_offset,'length',c.placeholder_length,'envelope',c.envelope) ORDER BY c.safe_offset,c.id)
        FROM chat_credentials c WHERE c.message_id=m.id),'[]'::jsonb))::text ELSE NULL END AS canonical
    FROM chat_messages m WHERE m.id=${key.messageId} AND m.chat_id=${key.chatId} AND m.run_id=${key.runId} AND m.role='assistant'`.execute(tx)).rows[0]?.canonical;
  if (typeof projection !== 'string' || !projection.length || Buffer.byteLength(projection) > MAX_HASH_BYTES) deny();
  return createHash('sha256').update('canonical-message-jsonb-v1\0').update(projection).digest('hex');
}
function match(copy: GoogleCopy, context: AvailableHistory, hash: string | null, now: number) {
  const allowed = origins(context);
  if (context.classification !== 'google' || copy.state !== 'active' || Date.parse(copy.retentionDeadline) <= now || hash !== copy.contentHash
    || copy.origins.some(origin => !allowed.some(candidate => originKey(origin) === originKey(candidate)))) deny();
}

/** Optional delta/snapshot writer foundation only. No startup install, redaction, or replay-delivery qualification. */
export function createGoogleCanonicalMessageWriteHook(options: { now?: () => Date } = {}): AssistantDeltaWriteHook {
  const now = options.now ?? (() => new Date());
  return {
    async write<T>(key: AssistantDeltaWriteKey, transact: AssistantDeltaTransact, content: (tx: AssistantDeltaExecutor) => Promise<T>, signal?: AbortSignal): Promise<T> {
      key = Object.freeze({ owner: Object.freeze(CanonicalOwnerScopeSchema.parse(key.owner)), chatId: CanonicalChatIdSchema.parse(key.chatId),
        runId: CanonicalChatRunIdSchema.parse(key.runId), messageId: CanonicalChatMessageIdSchema.parse(key.messageId) });
      if (key.owner.type !== 'personal') deny();
      const entityRef = canonicalMessageEntityRef(key.messageId);
      let deadline: number | undefined;
      const capture = (value: string) => { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) deny(); deadline = Math.min(deadline ?? parsed, parsed); };
      const live = () => { check(signal); const clock = now().getTime(); if (!Number.isFinite(clock) || (deadline !== undefined && deadline <= clock)) deny(); check(signal); };
      live();
      const result = await transact(tx => boundedProvenanceTransaction<ChatDatabase, T>(tx, async current => {
        const history = createGoogleModelHistoryStore<ChatDatabase>(current, { now });
        const inspect = async () => {
          check(signal);
          const context = available(await history.inspect(key.owner, key.chatId));
          if (context.classification === 'google') {
            capture(context.googleContext.retentionDeadline);
            for (const source of context.googleContext.sources) capture(source.expiresAt);
          }
          live();
          return context;
        };
        await inspect(); // Context/birth fence precedes all provenance and content row locks.
        await sql`SELECT pg_advisory_xact_lock(551035503)`.execute(current);
        await sql`SELECT id FROM google_copy_registry WHERE owner_id=${key.owner.ownerId} AND kind='derived' AND entity_ref=${entityRef} FOR UPDATE`.execute(current);
        const store = createGoogleProvenanceStore<ChatDatabase>(current);
        const copy = await store.inspect(key.owner.ownerId, 'derived', entityRef);
        if (copy) capture(copy.retentionDeadline);
        const chat = await current.selectFrom('chats').select('id').where('id', '=', key.chatId).where('owner_type', '=', 'personal')
          .where('owner_id', '=', key.owner.ownerId).where('collaboration', 'is', null).forUpdate().executeTakeFirst();
        if (!chat) deny();
        const shared = await sql`SELECT id FROM collaboration_scopes WHERE owner_type='personal' AND owner_id=${key.owner.ownerId}
          AND kind='chat' AND resource_id=${key.chatId} AND lifecycle NOT IN ('private','preparing') LIMIT 1`.execute(current);
        if (shared.rows.length) deny();
        const run = await current.selectFrom('chat_runs').select('id').where('id', '=', key.runId).where('chat_id', '=', key.chatId).forUpdate().executeTakeFirst();
        if (!run) deny();
        const before = await payloadHash(current, key);
        const context = await inspect();
        if (copy) match(copy, context, before, now().getTime());
        else if (context.classification === 'google' && before) deny();
        const result = await content(current);
        const fresh = await inspect();
        if (fresh.classification === 'google') {
          const hash = await payloadHash(current, key);
          if (!hash) deny();
          const after = await inspect();
          if (after.classification !== 'google' || deadline === undefined) deny();
          const approved = origins(after);
          const same = copy && hash === copy.contentHash && copy.origins.length === approved.length
            && approved.every(origin => copy.origins.some(previous => originKey(previous) === originKey(origin)))
            && Date.parse(copy.retentionDeadline) <= deadline;
          if (!same) {
            const decisions = after.googleContext.sources.map(source => [source.originId, source.consentId]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
            const registered = await store.record({ ownerId: key.owner.ownerId, kind: 'derived', entityRef, contentHash: hash, origins: approved,
              retention: { choice: 'until', deadline: new Date(deadline).toISOString(),
                decisionId: `cm_${createHash('sha256').update(JSON.stringify([decisions, deadline])).digest('hex')}` }, ...(copy ? { baseRevision: copy.revision } : {}) });
            capture(registered.retentionDeadline);
          }
          await inspect();
        }
        live();
        return result;
      }));
      // This fences returned-message release only. Existing live outbox flush is an explicit installation blocker.
      live();
      return result;
    },
  };
}
