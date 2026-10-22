import { createHash } from 'node:crypto';
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatRunActivitySchema, CanonicalOwnerScopeSchema } from '@matrix-os/contracts';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod/v4';
import type { ChatDatabase } from '../../chat/database.js';
import type { ChatActivityWriteKey } from '../../chat/activity-write-hook.js';
import type { AssistantDeltaExecutor, AssistantDeltaTransact } from '../../chat/assistant-delta-repository.js';
import { createGoogleModelHistoryStore, type GoogleModelHistory } from '../runtime/model-history.js';
import { boundedProvenanceTransaction } from './transaction.js';
import { createGoogleProvenanceStore } from './store.js';
import { GoogleProvenanceUnavailable, originKey, type PurgeHandlers } from './contracts.js';
import { recordOrdinaryCopyReceipts } from './ordinary-copy-receipts.js';
import { activityId, googleActivityEntityRef, isHashedActivityRef, mapActivityReferences, resolveActivitySource } from './activity-reference.js';
import { activityReceiptProofs, lockedActivityCopies, retireActivityReceipts } from './activity-copy-batch.js';
export { googleActivityEntityRef } from './activity-reference.js';

function deny(): never { throw new GoogleProvenanceUnavailable(); }
const check = (signal?: AbortSignal) => { if (signal?.aborted) deny(); };
type Available = Exclude<GoogleModelHistory, { classification: 'unknown' }>;
function available(value: GoogleModelHistory): Available {
  if (value.classification === 'unknown' || (value.classification === 'google' && value.googleContext.availability !== 'available')) deny();
  return value;
}
interface ActivityRow { id: string; event: unknown; run_seq: number; occurred_at: Date; canonical: string | null; token: string; redacted_hash: string | null; entity_ref: string | null }
async function payloads(tx: AssistantDeltaExecutor, key: Omit<ChatActivityWriteKey, 'activityIds'>, id?: string) {
  const bounded = sql`jsonb_typeof(e.event)='object' AND octet_length(e.event::text)<=65536
    AND (SELECT COALESCE(SUM(octet_length(b.event::text)),0) FROM chat_run_events b
      WHERE b.chat_id=${key.chatId} AND b.run_id=${key.runId} ${id ? sql`AND b.id=${id}` : sql``})<=8388608`;
  const rows = (await sql<ActivityRow>`SELECT e.id,CASE WHEN ${bounded} THEN e.event ELSE NULL END AS event,
    e.run_seq,e.occurred_at,e.xmin::text AS token,e.google_redacted_hash AS redacted_hash,e.google_activity_entity_ref AS entity_ref,
    CASE WHEN ${bounded} THEN jsonb_build_object('version',1,
      'ownerId',${key.owner.ownerId}::text,'chatId',e.chat_id,'runId',e.run_id,'id',e.id,'sequence',e.run_seq,
      'occurredAt',e.occurred_at,'event',e.event)::text ELSE NULL END AS canonical
    FROM chat_run_events e WHERE e.chat_id=${key.chatId} AND e.run_id=${key.runId}
      ${id ? sql`AND e.id=${id}` : sql``} ORDER BY e.id LIMIT 501 FOR UPDATE OF e`.execute(tx)).rows;
  if (rows.length > 500) deny();
  return rows.map(row => {
    const parsed = CanonicalChatRunActivitySchema.safeParse(row.event);
    if (!parsed.success || parsed.data.id !== row.id || parsed.data.chatId !== key.chatId || parsed.data.runId !== key.runId
      || parsed.data.sequence !== Number(row.run_seq) || Date.parse(parsed.data.occurredAt) !== new Date(row.occurred_at).getTime()
      || typeof row.canonical !== 'string' || Buffer.byteLength(row.canonical) > 128 * 1024) deny();
    return { ...row, activity: parsed.data, hash: createHash('sha256').update('google-activity-jsonb-v1\0').update(row.canonical).digest('hex') };
  });
}

/** Trusted host must verify durable owner/source purge admission, stop and drain dispatch, and
 * prevent new work before invoking work. Hold admission until its SQL transaction settles. */
export interface GoogleActivityQuiescenceAuthority {
  withStoppedRun<T>(key: { ownerId: string; chatId: string; runId: string; signal?: AbortSignal }, work: () => Promise<T>): Promise<T | null>;
}
/** Factory owns no pool/timer. Host migrates after Chat bootstrap and quiesces runs before purge execution. */
export function createGoogleActivityCopyAdapter(db: Kysely<ChatDatabase>, options: { now?: () => Date; quiescence?: GoogleActivityQuiescenceAuthority } = {}) {
  const now = options.now ?? (() => new Date());
  const write = async <T>(input: ChatActivityWriteKey, transact: AssistantDeltaTransact, content: (tx: AssistantDeltaExecutor) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const key = Object.freeze({ owner: Object.freeze(CanonicalOwnerScopeSchema.parse(input.owner)),
      chatId: CanonicalChatIdSchema.parse(input.chatId), runId: CanonicalChatRunIdSchema.parse(input.runId) });
    const requested = z.array(activityId).max(100).parse(input.activityIds);
    if (key.owner.type !== 'personal') deny();
    let deadline: number | undefined;
    let ordinaryProofDeadline: number | undefined;
    const capture = (value: string) => { const time = Date.parse(value); if (!Number.isFinite(time)) deny(); deadline = Math.min(deadline ?? time, time); };
    const live = () => { check(signal); const time = now().getTime(); if (!Number.isFinite(time) || (deadline !== undefined && time >= deadline)
      || (ordinaryProofDeadline !== undefined && time >= ordinaryProofDeadline)) deny(); check(signal); };
    live();
    const result = await transact(tx => boundedProvenanceTransaction<ChatDatabase, T>(tx, async current => {
      const history = createGoogleModelHistoryStore<ChatDatabase>(current, { now });
      const inspect = async () => {
        const context = available(await history.inspect(key.owner, key.chatId));
        if (context.classification === 'google') { capture(context.googleContext.retentionDeadline); context.googleContext.sources.forEach(source => capture(source.expiresAt)); }
        live(); return context;
      };
      await inspect(); await sql`SELECT pg_advisory_xact_lock(551035503)`.execute(current);
      const discover = async () => {
        const rows = await current.selectFrom('chat_run_events').select('id').where('chat_id', '=', key.chatId).where('run_id', '=', key.runId).orderBy('id').limit(501).execute();
        if (rows.length > 500) deny(); live(); return rows.map(row => row.id);
      };
      const observed = await discover();
      const ids = [...new Set([...observed, ...requested])].sort(); // Bounded to 600 for this transaction only.
      const refs = ids.map(googleActivityEntityRef);
      const store = createGoogleProvenanceStore<ChatDatabase>(current);
      const locked = await lockedActivityCopies<ChatDatabase>(current, key.owner.ownerId, refs);
      const copies = new Map(locked.map(copy => [copy.entityRef, copy])); // <=600; disposed with transaction.
      for (const copy of locked) capture(copy.retentionDeadline);
      live();
      const chat = await current.selectFrom('chats').select('id').where('id', '=', key.chatId).where('owner_type', '=', 'personal')
        .where('owner_id', '=', key.owner.ownerId).where('collaboration', 'is', null).forUpdate().executeTakeFirst();
      if (!chat) deny();
      const shared = await sql`SELECT id FROM collaboration_scopes WHERE owner_type='personal' AND owner_id=${key.owner.ownerId}
        AND kind='chat' AND resource_id=${key.chatId} AND lifecycle NOT IN ('private','preparing') LIMIT 1`.execute(current);
      if (shared.rows.length) deny();
      const run = await current.selectFrom('chat_runs').select('id').where('id', '=', key.runId).where('chat_id', '=', key.chatId).forUpdate().executeTakeFirst();
      if (!run || JSON.stringify(await discover()) !== JSON.stringify(observed)) deny();
      const before = await payloads(current, key); const context = await inspect();
      const proofs = await activityReceiptProofs<ChatDatabase>(current, key.owner.ownerId, key.chatId, before
        .filter(row => !copies.has(googleActivityEntityRef(row.id))).map(row => ({ ref: googleActivityEntityRef(row.id), hash: row.hash })));
      live();
      for (const row of before) {
        live();
        if (row.redacted_hash) deny();
        const copy = copies.get(googleActivityEntityRef(row.id));
        if (!copy) {
          const proof = proofs.get(googleActivityEntityRef(row.id));
          if (!proof || Date.parse(proof) <= now().getTime()) deny();
          ordinaryProofDeadline = Math.min(ordinaryProofDeadline ?? Infinity, Date.parse(proof)); live();
          continue;
        }
        if (context.classification !== 'google' || copy.state !== 'active' || copy.contentHash !== row.hash
          || copy.origins.some(origin => !context.googleContext.sources.some(source => originKey(origin) === originKey({
            connectionId: source.originId, profileId: source.profileId, profileRevision: source.profileRevision, purpose: source.purposeId })))) deny();
      }
      const result = await content(current); const after = await payloads(current, key); const fresh = await inspect();
      if (after.some(row => !ids.includes(row.id) || row.redacted_hash)) deny();
      await mapActivityReferences(current, key.chatId, key.runId, after); live();
      if (fresh.classification === 'google') for (const row of after) {
        const copy = copies.get(googleActivityEntityRef(row.id)); const origins = fresh.googleContext.sources.map(source => ({ connectionId: source.originId,
          profileId: source.profileId, profileRevision: source.profileRevision, purpose: source.purposeId }));
        if (deadline === undefined) deny();
        const same = copy && copy.contentHash === row.hash && copy.origins.length === origins.length
          && origins.every(origin => copy.origins.some(previous => originKey(origin) === originKey(previous))) && Date.parse(copy.retentionDeadline) <= deadline;
        if (!same) {
          const decisions = fresh.googleContext.sources.map(source => [source.originId, source.consentId]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
          const saved = await store.record({ ownerId: key.owner.ownerId, kind: 'derived', entityRef: googleActivityEntityRef(row.id), contentHash: row.hash, origins,
            retention: { choice: 'until', deadline: new Date(deadline).toISOString(), decisionId: `gae_${createHash('sha256').update(JSON.stringify([decisions, deadline])).digest('hex')}` },
            ...(copy ? { baseRevision: copy.revision } : {}) }); capture(saved.retentionDeadline);
        }
        live();
      }
      if (fresh.classification === 'google') await retireActivityReceipts<ChatDatabase>(current, key.owner.ownerId, key.chatId, after.map(row => googleActivityEntityRef(row.id)));
      else if (fresh.classification === 'ordinary') await recordOrdinaryCopyReceipts(current, after.map(row => ({
        key: { ownerId: key.owner.ownerId, chatId: key.chatId, kind: 'derived', entityRef: googleActivityEntityRef(row.id) }, hash: row.hash,
      })));
      await inspect(); live(); return result;
    }), () => { live(); return true; });
    live(); return result;
  };
  const deletion: NonNullable<PurgeHandlers['derived']> = async input => {
    check(input.signal);
    if (!input.entityRef.startsWith('gae_')) return { status: 'unavailable' };
    CanonicalOwnerScopeSchema.parse({ type: 'personal', ownerId: input.ownerId });
    if (!/^[a-f0-9]{64}$/.test(input.expectedHash)) deny();
    const result = await boundedProvenanceTransaction(db, async tx => {
      const source = await resolveActivitySource(tx, input.ownerId, input.entityRef);
      if (!source) return { status: isHashedActivityRef(input.entityRef) ? 'unavailable' as const : 'missing' as const };
      const id = source.id;
      const chat = await tx.selectFrom('chats').select('id').where('id', '=', source.chat_id).where('owner_type', '=', 'personal')
        .where('owner_id', '=', input.ownerId).where('collaboration', 'is', null).forUpdate().executeTakeFirst();
      if (!chat) return { status: 'unavailable' as const };
      const shared = await sql`SELECT id FROM collaboration_scopes WHERE owner_type='personal' AND owner_id=${input.ownerId}
        AND kind='chat' AND resource_id=${source.chat_id} AND lifecycle NOT IN ('private','preparing') LIMIT 1`.execute(tx);
      if (shared.rows.length) return { status: 'unavailable' as const };
      const run = await tx.selectFrom('chat_runs').select('status').where('id', '=', source.run_id).where('chat_id', '=', source.chat_id).forUpdate().executeTakeFirst();
      check(input.signal);
      if (!run || !['completed', 'failed', 'aborted'].includes(run.status)) return { status: 'unavailable' as const };
      const row = (await payloads(tx, { owner: { type: 'personal', ownerId: input.ownerId }, chatId: source.chat_id, runId: source.run_id }, id))[0];
      check(input.signal); if (!row) return { status: 'missing' as const };
      const tombstone = CanonicalChatRunActivitySchema.parse({ id, chatId: source.chat_id, runId: source.run_id,
        sequence: Number(row.run_seq), occurredAt: row.activity.occurredAt, type: 'run.status', status: run.status });
      if (row.redacted_hash === input.expectedHash && JSON.stringify(row.activity) === JSON.stringify(tombstone)) return { status: 'deleted' as const };
      if (row.redacted_hash || row.hash !== input.expectedHash) return { status: 'modified' as const };
      const changed = await sql`UPDATE chat_run_events SET event=${JSON.stringify(tombstone)}::jsonb,google_redacted_hash=${input.expectedHash}
        WHERE id=${id} AND chat_id=${source.chat_id} AND run_id=${source.run_id} AND xmin::text=${row.token} RETURNING id`.execute(tx);
      check(input.signal); return { status: changed.rows.length ? 'deleted' as const : 'modified' as const };
    });
    check(input.signal); return result;
  };
  const quiesceCopy = async (ownerId: string, entityRef: string, signal?: AbortSignal) => {
    check(signal); CanonicalOwnerScopeSchema.parse({ type: 'personal', ownerId });
    if (!options.quiescence || !entityRef.startsWith('gae_')) deny();
    // Discovery is metadata only. Never call this while executeClaim holds its registry copy lock.
    const source = await boundedProvenanceTransaction(db, tx => resolveActivitySource(tx, ownerId, entityRef));
    check(signal);
    if (!source) { if (isHashedActivityRef(entityRef)) deny(); return { quiesced: true as const, missing: true }; }
    let completed: { quiesced: true; missing: boolean } | undefined;
    const admitted = await options.quiescence.withStoppedRun({ ownerId, chatId: source.chat_id, runId: source.run_id, signal }, async () => {
      check(signal);
      completed = await boundedProvenanceTransaction(db, async tx => {
        const chat = await tx.selectFrom('chats').select('id').where('id', '=', source.chat_id).where('owner_type', '=', 'personal')
          .where('owner_id', '=', ownerId).where('collaboration', 'is', null).forUpdate().executeTakeFirst();
        if (!chat) deny();
        const shared = await sql`SELECT id FROM collaboration_scopes WHERE owner_type='personal' AND owner_id=${ownerId}
          AND kind='chat' AND resource_id=${source.chat_id} AND lifecycle NOT IN ('private','preparing') LIMIT 1`.execute(tx);
        if (shared.rows.length) deny();
        const run = await tx.selectFrom('chat_runs').select(['status', 'turn_id']).where('id', '=', source.run_id).where('chat_id', '=', source.chat_id).forUpdate().executeTakeFirst();
        check(signal); if (!run) return { quiesced: true as const, missing: true };
        if (['accepted', 'running', 'waiting_for_input', 'waiting_for_approval'].includes(run.status)) {
          await tx.updateTable('chat_runs').set({ status: 'aborted', outcome: 'aborted', completed_at: sql`now()`, updated_at: sql`now()` })
            .where('id', '=', source.run_id).where('chat_id', '=', source.chat_id).where('status', '=', run.status).execute();
          await tx.updateTable('chat_turns').set({ status: 'aborted', updated_at: sql`now()` }).where('id', '=', run.turn_id).where('chat_id', '=', source.chat_id).execute();
          await tx.updateTable('chats').set({ revision: sql`revision+1`, attention: 'none', updated_at: sql`now()` }).where('id', '=', source.chat_id).where('owner_id', '=', ownerId).execute();
        }
        check(signal); return { quiesced: true as const, missing: false };
      });
      check(signal); return completed;
    });
    check(signal); if (admitted === null || !completed) deny(); return completed;
  };
  return {
    migrate: () => boundedProvenanceTransaction(db, async tx => {
      await sql`ALTER TABLE chat_run_events ADD COLUMN IF NOT EXISTS google_redacted_hash TEXT`.execute(tx);
      await sql`ALTER TABLE chat_run_events ADD COLUMN IF NOT EXISTS google_activity_entity_ref TEXT`.execute(tx);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS google_activity_entity_lookup ON chat_run_events(google_activity_entity_ref) WHERE google_activity_entity_ref IS NOT NULL`.execute(tx);
    }),
    write,
    delete: deletion,
    quiesceCopy,
  };
}
