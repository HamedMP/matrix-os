import { createHash } from 'node:crypto';
import { ChatRunContextSchema, CanonicalOwnerScopeSchema, CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatQueuedTurnIdSchema } from '@matrix-os/contracts';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod/v4';
import type { ChatDatabase } from '../../chat/database.js';
import type { ChatOwner } from '../../chat/records.js';
import type { AssistantDeltaExecutor, AssistantDeltaTransact } from '../../chat/assistant-delta-repository.js';
import type { ChatContextWriteKey } from '../../chat/context-write-hook.js';
import { createGoogleModelHistoryStore, type GoogleModelHistory } from '../runtime/model-history.js';
import { createGoogleProvenanceStore } from './store.js';
import { boundedProvenanceTransaction } from './transaction.js';
import { GoogleProvenanceUnavailable, originKey, type GoogleCopy, type PurgeHandlers } from './contracts.js';
import type { GoogleActivityQuiescenceAuthority } from './activity-copies.js';
import { matchingOrdinaryCopyReceipt, recordOrdinaryCopyReceipts, retireOrdinaryCopyReceipt } from './ordinary-copy-receipts.js';

export const runContextEntityRef = (id: string) => `grc_${CanonicalChatRunIdSchema.parse(id)}`;
export const queueContextEntityRef = (id: string) => `gqc_${CanonicalChatQueuedTurnIdSchema.parse(id)}`;
export interface ContextSnapshotKey { owner: ChatOwner; chatId: string; kind: 'run' | 'queue'; id: string }
export interface GoogleQueueContextAdmission {
  /** Trusted durable owner/source admission must fence and drain queue claims until work settles. */
  withStoppedQueue<T>(key: { ownerId: string; chatId: string; queuedTurnId: string; signal?: AbortSignal }, work: () => Promise<T>): Promise<T | null>;
}
function deny(): never { throw new GoogleProvenanceUnavailable(); }
const check = (signal?: AbortSignal) => { if (signal?.aborted) deny(); };
const active = ['accepted', 'running', 'waiting_for_input', 'waiting_for_approval'];
const ref = (key: ContextSnapshotKey) => key.kind === 'run' ? runContextEntityRef(key.id) : queueContextEntityRef(key.id);
function fromRef(ownerId: string, entityRef: string): Omit<ContextSnapshotKey, 'chatId'> | null {
  const owner = CanonicalOwnerScopeSchema.parse({ type: 'personal', ownerId });
  if (entityRef.startsWith('grc_')) return { owner, kind: 'run', id: CanonicalChatRunIdSchema.parse(entityRef.slice(4)) };
  if (entityRef.startsWith('gqc_')) return { owner, kind: 'queue', id: CanonicalChatQueuedTurnIdSchema.parse(entityRef.slice(4)) };
  return null;
}
interface SnapshotRow { id: string; chat_id: string; status: string; claimed_run_id: string | null; collaboration_scope_id: string | null;
  has_context: boolean; context: unknown; canonical: string | null; redacted_hash: string | null; token: string }
async function load(tx: AssistantDeltaExecutor, input: ContextSnapshotKey) {
  const owner = CanonicalOwnerScopeSchema.parse(input.owner); if (owner.type !== 'personal') deny();
  const kind = z.enum(['run', 'queue']).parse(input.kind);
  const key = { owner, kind, chatId: CanonicalChatIdSchema.parse(input.chatId), id: kind === 'run' ? CanonicalChatRunIdSchema.parse(input.id) : CanonicalChatQueuedTurnIdSchema.parse(input.id) };
  const table = key.kind === 'run' ? 'chat_runs' : 'chat_queued_turns';
  const bounded = sql`jsonb_typeof(t.context_snapshot)='object' AND octet_length(t.context_snapshot::text)<=81920`;
  const row = (await sql<SnapshotRow>`SELECT t.id,t.chat_id,t.status,
    ${key.kind === 'queue' ? sql`t.claimed_run_id,t.collaboration_scope_id` : sql`NULL::text AS claimed_run_id,NULL::text AS collaboration_scope_id`},
    t.context_snapshot IS NOT NULL AS has_context,CASE WHEN ${bounded} THEN t.context_snapshot ELSE NULL END AS context,
    t.google_context_redacted_hash AS redacted_hash,t.xmin::text AS token,
    CASE WHEN ${bounded} THEN jsonb_build_object('version',1,'ownerId',${key.owner.ownerId}::text,'chatId',t.chat_id,
      'kind',${key.kind}::text,'id',t.id,'context',t.context_snapshot)::text ELSE NULL END AS canonical
    FROM ${sql.table(table)} t JOIN chats c ON c.id=t.chat_id WHERE t.id=${key.id} AND t.chat_id=${key.chatId}
      AND c.owner_type='personal' AND c.owner_id=${key.owner.ownerId} FOR UPDATE OF t`.execute(tx)).rows[0];
  if (!row) return null;
  if (row.has_context && (!ChatRunContextSchema.safeParse(row.context).success || typeof row.canonical !== 'string' || Buffer.byteLength(row.canonical) > 96 * 1024)) deny();
  return { ...row, hash: row.has_context ? createHash('sha256').update('google-context-jsonb-v1\0').update(row.canonical!).digest('hex') : null };
}
/** Trusted composition: caller owns source/provenance/chat fences. Locks only the exact owned snapshot row. */
export async function contextSnapshotPayloadHash(tx: AssistantDeltaExecutor, key: ContextSnapshotKey): Promise<string | null> {
  return (await load(tx, key))?.hash ?? null;
}
async function privateChat(tx: AssistantDeltaExecutor, ownerId: string, chatId: string) {
  const chat = await tx.selectFrom('chats').select(['id', 'revision']).where('id', '=', chatId).where('owner_type', '=', 'personal')
    .where('owner_id', '=', ownerId).where('collaboration', 'is', null).forUpdate().executeTakeFirst();
  if (!chat) deny();
  const shared = await sql`SELECT id FROM collaboration_scopes WHERE owner_type='personal' AND owner_id=${ownerId}
    AND kind='chat' AND resource_id=${chatId} AND lifecycle NOT IN ('private','preparing') LIMIT 1`.execute(tx);
  if (shared.rows.length) deny(); return chat;
}
type Available = Exclude<GoogleModelHistory, { classification: 'unknown' }>;
function available(value: GoogleModelHistory): Available {
  if (value.classification === 'unknown' || (value.classification === 'google' && value.googleContext.availability !== 'available')) deny(); return value;
}
export function createGoogleContextSnapshotAdapter(db: Kysely<ChatDatabase>, options: { now?: () => Date;
  quiescence?: GoogleActivityQuiescenceAuthority; queueAdmission?: GoogleQueueContextAdmission } = {}) {
  const now = options.now ?? (() => new Date());
  const write = async <T>(input: ChatContextWriteKey, transact: AssistantDeltaTransact, content: (tx: AssistantDeltaExecutor) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const owner = Object.freeze(CanonicalOwnerScopeSchema.parse(input.owner)); const chatId = CanonicalChatIdSchema.parse(input.chatId);
    const runIds = z.array(CanonicalChatRunIdSchema).max(2).parse(input.runIds ?? []); const queueIds = z.array(CanonicalChatQueuedTurnIdSchema).max(20).parse(input.queueIds ?? []);
    const discoverQueued = input.discoverQueued === true; const requestId = z.string().min(1).max(200).optional().parse(input.requestId);
    if (owner.type !== 'personal') deny(); let deadline: number | undefined; let ordinaryProofDeadline: number | undefined;
    const capture = (value: string) => { const time = Date.parse(value); if (!Number.isFinite(time)) deny(); deadline = Math.min(deadline ?? time, time); };
    const live = () => { check(signal); const time = now().getTime(); if (!Number.isFinite(time) || (deadline !== undefined && time >= deadline)
      || (ordinaryProofDeadline !== undefined && time >= ordinaryProofDeadline)) deny(); check(signal); };
    live();
    const result = await transact(tx => boundedProvenanceTransaction<ChatDatabase, T>(tx, async current => {
      const history = createGoogleModelHistoryStore<ChatDatabase>(current, { now });
      const inspect = async () => { const result = available(await history.inspect(owner, chatId));
        if (result.classification === 'google') { capture(result.googleContext.retentionDeadline); result.googleContext.sources.forEach(source => capture(source.expiresAt)); } live(); return result; };
      await inspect(); await sql`SELECT pg_advisory_xact_lock(551035503)`.execute(current);
      const discover = async () => {
        const queued = discoverQueued ? await current.selectFrom('chat_queued_turns').select('id').where('chat_id', '=', chatId).where('status', '=', 'queued').orderBy('id').limit(21).execute() : [];
        const priorRuns = requestId ? await current.selectFrom('chat_runs').select('id').where('chat_id', '=', chatId).where('client_request_id', '=', requestId).orderBy('id').limit(3).execute() : [];
        const priorQueue = requestId ? await current.selectFrom('chat_queued_turns').select('id').where('chat_id', '=', chatId).where('client_request_id', '=', requestId).orderBy('id').limit(2).execute() : [];
        if (queued.length > 20 || priorRuns.length > 2 || priorQueue.length > 1) deny(); live();
        return { queued: queued.map(row => row.id), runs: priorRuns.map(row => row.id), priorQueue: priorQueue.map(row => row.id) };
      };
      const observed = await discover();
      const keys: ContextSnapshotKey[] = [
        ...[...new Set([...runIds, ...observed.runs])].map(id => ({ owner, chatId, kind: 'run' as const, id })),
        ...[...new Set([...queueIds, ...observed.queued, ...observed.priorQueue])].map(id => ({ owner, chatId, kind: 'queue' as const, id })),
      ].sort((a, b) => ref(a).localeCompare(ref(b))); // At most 45 transaction-local keys.
      const refs = keys.map(ref);
      if (refs.length) await sql`SELECT id FROM google_copy_registry WHERE owner_id=${owner.ownerId} AND kind='derived'
        AND entity_ref=ANY(${refs}::text[]) ORDER BY entity_ref FOR UPDATE`.execute(current);
      const store = createGoogleProvenanceStore<ChatDatabase>(current); const copies = new Map<string, GoogleCopy>();
      for (const key of keys) { const copy = await store.inspect(owner.ownerId, 'derived', ref(key)); if (copy) { copies.set(ref(key), copy); capture(copy.retentionDeadline); } live(); }
      await privateChat(current, owner.ownerId, chatId);
      if (JSON.stringify(await discover()) !== JSON.stringify(observed)) deny();
      // Existing run rows precede queue rows; immutable new run IDs have no row to lock yet.
      const ordered = [...keys].sort((a, b) => a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'run' ? -1 : 1);
      const context = await inspect();
      for (const key of ordered) {
        const row = await load(current, key); live(); const copy = copies.get(ref(key));
        if (row?.redacted_hash || row?.collaboration_scope_id) deny();
        if (copy && (context.classification !== 'google' || copy.state !== 'active' || copy.contentHash !== row?.hash)) deny();
        if (!copy && row?.hash) {
          const proof = await matchingOrdinaryCopyReceipt(current, { ownerId: owner.ownerId, chatId, kind: 'derived', entityRef: ref(key) }, row.hash);
          if (!proof) deny(); ordinaryProofDeadline = Math.min(ordinaryProofDeadline ?? Infinity, Date.parse(proof)); live();
        }
        if (copy && context.classification === 'google' && copy.origins.some(origin => !context.googleContext.sources.some(source => originKey(origin) === originKey({ connectionId: source.originId,
          profileId: source.profileId, profileRevision: source.profileRevision, purpose: source.purposeId })))) deny();
      }
      const result = await content(current); const fresh = await inspect();
      const receipts = [];
      for (const key of ordered) {
        const row = await load(current, key); live(); if (row?.redacted_hash || row?.collaboration_scope_id) deny();
        const copy = copies.get(ref(key)); if (copy && !row?.hash) deny();
        if (!row?.hash) continue;
        const receiptKey = { ownerId: owner.ownerId, chatId, kind: 'derived' as const, entityRef: ref(key) };
        if (fresh.classification === 'ordinary') { receipts.push({ key: receiptKey, hash: row.hash }); continue; }
        if (deadline === undefined) deny(); const origins = fresh.googleContext.sources.map(source => ({ connectionId: source.originId, profileId: source.profileId, profileRevision: source.profileRevision, purpose: source.purposeId }));
        const same = copy && copy.contentHash === row.hash && copy.origins.length === origins.length && origins.every(origin => copy.origins.some(previous => originKey(origin) === originKey(previous))) && Date.parse(copy.retentionDeadline) <= deadline;
        if (!same) { const decisions = fresh.googleContext.sources.map(source => [source.originId, source.consentId]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
          const saved = await store.record({ ownerId: owner.ownerId, kind: 'derived', entityRef: ref(key), contentHash: row.hash, origins,
            retention: { choice: 'until', deadline: new Date(deadline).toISOString(), decisionId: `gctx_${createHash('sha256').update(JSON.stringify([decisions, deadline])).digest('hex')}` }, ...(copy ? { baseRevision: copy.revision } : {}) }); capture(saved.retentionDeadline); }
        await inspect(); await retireOrdinaryCopyReceipt(current, receiptKey);
      }
      if (receipts.length) await recordOrdinaryCopyReceipts(current, receipts);
      live(); return result;
    }), () => { live(); return true; });
    live(); return result;
  };
  const deletion: NonNullable<PurgeHandlers['derived']> = async input => {
    check(input.signal); const key = fromRef(input.ownerId, input.entityRef); if (!key) return { status: 'unavailable' };
    if (!/^[a-f0-9]{64}$/.test(input.expectedHash)) deny();
    const result = await boundedProvenanceTransaction(db, async tx => {
      const table = key.kind === 'run' ? 'chat_runs' : 'chat_queued_turns';
      const source = (await sql<{ chat_id: string; claimed_run_id: string | null }>`SELECT t.chat_id,
        ${key.kind === 'run' ? sql`t.id` : sql`t.claimed_run_id`} AS claimed_run_id FROM ${sql.table(table)} t JOIN chats c ON c.id=t.chat_id
        WHERE t.id=${key.id} AND c.owner_type='personal' AND c.owner_id=${key.owner.ownerId}`.execute(tx)).rows[0];
      if (!source) return { status: 'missing' as const }; await privateChat(tx, key.owner.ownerId, source.chat_id);
      if (source.claimed_run_id) { const run = await tx.selectFrom('chat_runs').select('status').where('id', '=', source.claimed_run_id).where('chat_id', '=', source.chat_id).forUpdate().executeTakeFirst();
        if (!run || active.includes(run.status)) return { status: 'unavailable' as const }; }
      const row = await load(tx, { ...key, chatId: source.chat_id }); check(input.signal); if (!row) return { status: 'missing' as const };
      if (row.collaboration_scope_id || (key.kind === 'queue' && (row.status === 'queued' || row.claimed_run_id !== source.claimed_run_id
        || (row.status === 'claimed' && !row.claimed_run_id)))) return { status: 'unavailable' as const };
      if (!row.has_context && row.redacted_hash === input.expectedHash) return { status: 'deleted' as const };
      if (row.redacted_hash || row.hash !== input.expectedHash) return { status: 'modified' as const };
      const changed = await sql`UPDATE ${sql.table(table)} SET context_snapshot=NULL,google_context_redacted_hash=${input.expectedHash}
        WHERE id=${key.id} AND chat_id=${source.chat_id} AND xmin::text=${row.token} RETURNING id`.execute(tx); check(input.signal);
      return { status: changed.rows.length ? 'deleted' as const : 'modified' as const };
    }); check(input.signal); return result;
  };
  const quiesceCopy = async (ownerId: string, entityRef: string, signal?: AbortSignal) => {
    check(signal); const key = fromRef(ownerId, entityRef); if (!key) deny();
    if ((key.kind === 'run' && !options.quiescence) || (key.kind === 'queue' && !options.queueAdmission)) deny();
    const table = key.kind === 'run' ? 'chat_runs' : 'chat_queued_turns';
    const source = () => boundedProvenanceTransaction(db, async tx => (await sql<{ chat_id: string; claimed_run_id: string | null }>`SELECT t.chat_id,
      ${key.kind === 'run' ? sql`t.id` : sql`t.claimed_run_id`} AS claimed_run_id FROM ${sql.table(table)} t JOIN chats c ON c.id=t.chat_id
      WHERE t.id=${key.id} AND c.owner_type='personal' AND c.owner_id=${ownerId}`.execute(tx)).rows[0]);
    const initial = await source(); check(signal); if (!initial) return { quiesced: true as const, missing: true };
    let completed: { quiesced: true; missing: boolean } | undefined;
    const settle = async (currentSource: NonNullable<Awaited<ReturnType<typeof source>>>) => {
      completed = await boundedProvenanceTransaction(db, async tx => {
        await privateChat(tx, ownerId, currentSource.chat_id); check(signal); let changed = false;
        const run = currentSource.claimed_run_id ? await tx.selectFrom('chat_runs').select(['status', 'turn_id']).where('id', '=', currentSource.claimed_run_id)
          .where('chat_id', '=', currentSource.chat_id).forUpdate().executeTakeFirst() : undefined;
        if (currentSource.claimed_run_id && !run) deny();
        const queued = key.kind === 'queue' ? await tx.selectFrom('chat_queued_turns').select(['id', 'status', 'position', 'claimed_run_id', 'collaboration_scope_id'])
          .where('id', '=', key.id).where('chat_id', '=', currentSource.chat_id).forUpdate().executeTakeFirst() : undefined;
        if (key.kind === 'queue' && !queued) return { quiesced: true as const, missing: true };
        if (queued && (queued.collaboration_scope_id || queued.claimed_run_id !== currentSource.claimed_run_id
          || (queued.status === 'claimed' && !queued.claimed_run_id))) deny();
        check(signal);
        if (run && active.includes(run.status)) {
          await tx.updateTable('chat_runs').set({ status: 'aborted', outcome: 'aborted', completed_at: sql`now()`, updated_at: sql`now()` })
            .where('id', '=', currentSource.claimed_run_id!).where('chat_id', '=', currentSource.chat_id).where('status', '=', run.status).execute();
          await tx.updateTable('chat_turns').set({ status: 'aborted', updated_at: sql`now()` }).where('id', '=', run.turn_id).where('chat_id', '=', currentSource.chat_id).execute(); changed = true;
        }
        if (queued && ['queued', 'claimed'].includes(queued.status)) {
          await tx.updateTable('chat_queued_turns').set({ status: 'cancelled', cancelled_at: sql`now()`, updated_at: sql`now()` })
            .where('id', '=', queued.id).where('chat_id', '=', currentSource.chat_id).where('status', '=', queued.status).execute();
          if (queued.status === 'queued') await tx.updateTable('chat_queued_turns').set({ position: sql`position-1`, updated_at: sql`now()` })
            .where('chat_id', '=', currentSource.chat_id).where('status', '=', 'queued').where('position', '>', Number(queued.position)).execute(); changed = true;
        }
        if (changed) await tx.updateTable('chats').set({ revision: sql`revision+1`, attention: 'none', updated_at: sql`now()` }).where('id', '=', currentSource.chat_id).where('owner_id', '=', ownerId).execute();
        check(signal); return { quiesced: true as const, missing: false };
      }); check(signal); return completed;
    };
    const stopRun = async (currentSource: NonNullable<Awaited<ReturnType<typeof source>>>) => {
      check(signal);
      if (!currentSource.claimed_run_id) return settle(currentSource);
      if (!options.quiescence) deny();
      return options.quiescence.withStoppedRun({ ownerId, chatId: currentSource.chat_id, runId: currentSource.claimed_run_id, signal }, () => settle(currentSource));
    };
    const admitted = key.kind === 'queue' ? await options.queueAdmission!.withStoppedQueue({ ownerId, chatId: initial.chat_id, queuedTurnId: key.id, signal }, async () => {
      const fresh = await source(); check(signal); if (!fresh || fresh.chat_id !== initial.chat_id) deny(); return stopRun(fresh);
    }) : await stopRun(initial);
    check(signal); if (admitted === null || !completed) deny(); return completed;
  };
  return {
    migrate: () => boundedProvenanceTransaction(db, async tx => {
      await sql`ALTER TABLE chat_runs ADD COLUMN IF NOT EXISTS google_context_redacted_hash TEXT`.execute(tx);
      await sql`ALTER TABLE chat_queued_turns ADD COLUMN IF NOT EXISTS google_context_redacted_hash TEXT`.execute(tx);
    }),
    write, delete: deletion, quiesceCopy,
  };
}
