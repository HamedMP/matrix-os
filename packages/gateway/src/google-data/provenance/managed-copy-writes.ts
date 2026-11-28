import { createHash } from 'node:crypto';
import { CanonicalChatIdSchema } from '@matrix-os/contracts';
import { sql, type Kysely } from 'kysely';
import { BOT_SESSION_MAX_BYTES } from '../../bots/repositories/sessions.js';
import type { OwnerBotDatabase } from '../../bots/database.js';
import type { BotExecutor } from '../../bots/repositories/shared.js';
import type { ManagedPiSessionDataHooks, ManagedPiSessionKey } from '../../chat/managed-pi-sessions.js';
import { createGoogleModelHistoryStore, type GoogleModelHistory } from '../runtime/model-history.js';
import { originKey, validateOpaque, GoogleProvenanceUnavailable, type GoogleCopy, type GoogleOrigin, type PurgeHandlers } from './contracts.js';
import { createGoogleProvenanceStore } from './store.js';
import { boundedProvenanceTransaction } from './transaction.js';
import { matchingOrdinaryCopyReceipt, recordOrdinaryCopyReceipt, retireOrdinaryCopyReceipt } from './ordinary-copy-receipts.js';

const MAX_HASH_BYTES = BOT_SESSION_MAX_BYTES * 2 + 32_768;
const encoder = new TextEncoder();
function deny(): never { throw new GoogleProvenanceUnavailable(); }
class CopyCancelled extends Error { constructor() { super('Copy cancelled'); this.name = 'CopyCancelled'; } }
function check(signal?: AbortSignal) { if (signal?.aborted) throw new CopyCancelled(); }
function subject(key: ManagedPiSessionKey) {
  validateOpaque(key.ownerId); CanonicalChatIdSchema.parse(key.chatId);
  return { type: 'personal' as const, ownerId: key.ownerId };
}
export function managedPiSessionEntityRef(chatId: string) { return `mpi_${CanonicalChatIdSchema.parse(chatId)}`; }
interface SessionHashRow { session_id: string; revision: number | string; canonical: string; valid: boolean }
/** Hash the same exact persisted SQL JSONB projection everywhere. Do not parse its numbers through JS.
 * PostgreSQL normalizes object keys; row revision binds even an equal-content replacement to a new hash. */
async function lockedSession<DB>(tx: Kysely<DB>, key: ManagedPiSessionKey): Promise<SessionHashRow | null> {
  return (await sql<SessionHashRow>`SELECT session_id,revision,jsonb_build_object(
    'version',1,'ownerId',owner_id,'chatId',chat_id,'sessionId',session_id,'revision',revision,
    'messages',messages,'compactedThroughSeq',compacted_through_seq,'needsRecompaction',needs_recompaction,
    'tokenEstimate',token_estimate,'runtimeVersions',runtime_versions)::text AS canonical,
    (jsonb_typeof(messages)='array' AND jsonb_typeof(runtime_versions)='object' AND revision>0
      AND token_estimate>=0 AND needs_recompaction IS NOT NULL AND (compacted_through_seq IS NULL OR compacted_through_seq>=0)) AS valid
    FROM managed_pi_sessions WHERE owner_id=${key.ownerId} AND chat_id=${key.chatId} FOR UPDATE`.execute(tx)).rows[0] ?? null;
}
function hash(row: SessionHashRow): string {
  if (row.valid !== true || typeof row.canonical !== 'string' || !row.canonical.length || encoder.encode(row.canonical).byteLength > MAX_HASH_BYTES
    || typeof row.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(row.session_id)
    || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1) deny();
  return createHash('sha256').update('managed-pi-jsonb-v1\0').update(row.canonical).digest('hex');
}
function available(value: GoogleModelHistory) {
  if (value.classification === 'unknown' || (value.classification === 'google' && value.googleContext.availability !== 'available')) deny();
  return value;
}
function origins(value: ReturnType<typeof available>): GoogleOrigin[] {
  return value.classification === 'ordinary' ? [] : value.googleContext.sources.map(source => ({
    connectionId: source.originId, profileId: source.profileId, profileRevision: source.profileRevision, purpose: source.purposeId,
  }));
}
function match(copy: GoogleCopy, context: ReturnType<typeof available>, row: SessionHashRow | null, now: Date) {
  const allowed = origins(context);
  if (!row || copy.state !== 'active' || new Date(copy.retentionDeadline) <= now || copy.contentHash !== hash(row)
    || context.classification !== 'google' || copy.origins.some(origin => !allowed.some(candidate => originKey(candidate) === originKey(origin)))) deny();
}

/** Trusted composition only. Classification and provenance do not approve the actual broker/provider route.
 * Lock order is context -> provenance-global -> copy -> content; pool and outer transactions remain host-owned. */
export function createGoogleManagedPiCopyHooks(options: { now?: () => Date } = {}): ManagedPiSessionDataHooks {
  const now = options.now ?? (() => new Date());
  async function run<T>(executor: BotExecutor, key: ManagedPiSessionKey, signal: AbortSignal | undefined,
    content: (tx: BotExecutor) => Promise<T>, mode: 'load' | 'save'): Promise<T> {
    key = Object.freeze({ ownerId: key.ownerId, chatId: key.chatId });
    const owner = subject(key);
    const entityRef = managedPiSessionEntityRef(key.chatId);
    const receiptKey = { ...key, kind: 'session' as const, entityRef };
    check(signal);
    let releaseDeadline: number | undefined;
    const captureDeadline = (value: string) => {
      const deadline = Date.parse(value);
      if (!Number.isFinite(deadline)) deny();
      releaseDeadline = Math.min(releaseDeadline ?? deadline, deadline);
    };
    const live = () => {
      check(signal); const clock = now().getTime();
      if (!Number.isFinite(clock) || (releaseDeadline !== undefined && releaseDeadline <= clock)) deny();
      check(signal);
    };
    live();
    const result = await boundedProvenanceTransaction<OwnerBotDatabase, T>(executor, async tx => {
      const history = createGoogleModelHistoryStore<OwnerBotDatabase>(tx, { now });
      const inspect = async () => {
        check(signal);
        const context = available(await history.inspect(owner, key.chatId));
        if (context.classification === 'google') {
          captureDeadline(context.googleContext.retentionDeadline);
          for (const source of context.googleContext.sources) captureDeadline(source.expiresAt);
        }
        live();
        return context;
      };
      await inspect();
      await sql`SELECT pg_advisory_xact_lock(551035503)`.execute(tx);
      check(signal);
      await sql`SELECT id FROM google_copy_registry WHERE owner_id=${key.ownerId} AND kind='session' AND entity_ref=${entityRef} FOR UPDATE`.execute(tx);
      const store = createGoogleProvenanceStore<OwnerBotDatabase>(tx);
      const copy = await store.inspect(key.ownerId, 'session', entityRef);
      if (copy) captureDeadline(copy.retentionDeadline);
      const previous = await lockedSession<OwnerBotDatabase>(tx, key);
      const context = await inspect();
      if (copy) match(copy, context, previous, now());
      else if (previous) {
        const proof = await matchingOrdinaryCopyReceipt(tx, receiptKey, hash(previous));
        if (!proof) deny();
        captureDeadline(proof); live();
      }
      live();
      // Old opaque caches remain denied. Only an exact receipt issued by this
      // writer while the same born history was ordinary supports first taint.
      const result = await content(tx);
      check(signal);
      const current = await inspect();
      if ((mode === 'save' || (!copy && previous)) && current.classification === 'google') {
        const saved = await lockedSession<OwnerBotDatabase>(tx, key);
        check(signal);
        if (!saved) deny();
        const contentHash = hash(saved!);
        const fresh = await inspect();
        if (fresh.classification !== 'google') deny();
        const sourceDecisions = fresh.googleContext.sources.map(source => [source.originId, source.consentId]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
        const decisionId = `pi_${createHash('sha256').update(JSON.stringify([sourceDecisions, fresh.googleContext.retentionDeadline])).digest('hex')}`;
        const registered = await store.record({ ownerId: key.ownerId, kind: 'session', entityRef, contentHash, origins: origins(fresh),
          retention: { choice: 'until', deadline: fresh.googleContext.retentionDeadline, decisionId }, ...(copy ? { baseRevision: copy.revision } : {}) });
        captureDeadline(registered.retentionDeadline);
        await retireOrdinaryCopyReceipt(tx, receiptKey);
        check(signal);
        await inspect();
      } else if (mode === 'save' && current.classification === 'ordinary') {
        const saved = await lockedSession<OwnerBotDatabase>(tx, key);
        if (!saved) deny();
        await recordOrdinaryCopyReceipt(tx, receiptKey, hash(saved));
      }
      if (copy && new Date(copy.retentionDeadline) <= now()) deny();
      live();
      return result;
    });
    // COMMIT can wait after the final SQL check. Reuse the captured strict lease, never open a
    // fresh classification transaction here. An outer joined transaction owns its final release.
    check(signal);
    const releasedAt = now().getTime();
    if (!Number.isFinite(releasedAt) || (releaseDeadline !== undefined && releaseDeadline <= releasedAt)) deny();
    check(signal);
    return result;
  }
  return {
    aroundLoad: (executor, key, signal, read) => run(executor, key, signal, read, 'load'),
    aroundSave: (executor, key, signal, write) => run(executor, key, signal, write, 'save'),
  };
}

/** Cache-only adapter. Worker already holds the registry copy lock; never acquire context/registry here.
 * Canonical owner messages and every other saved-copy surface are deliberately outside this handler. */
export function createGoogleManagedPiSessionDeletionHandler<DB>(db: Kysely<DB>): NonNullable<PurgeHandlers['session']> {
  return async input => {
    const { ownerId, entityRef, expectedHash, signal } = input;
    validateOpaque(ownerId);
    if (!entityRef.startsWith('mpi_chat_') || !/^[a-f0-9]{64}$/.test(expectedHash)) return { status: 'unavailable' };
    const chatId = CanonicalChatIdSchema.safeParse(entityRef.slice(4));
    if (!chatId.success) return { status: 'unavailable' };
    try {
      check(signal);
      return await boundedProvenanceTransaction(db, async tx => {
        const row = await lockedSession<DB>(tx, { ownerId, chatId: chatId.data });
        check(signal);
        if (!row) return { status: 'missing' as const };
        if (hash(row) !== expectedHash) return { status: 'modified' as const };
        const deleted = await sql`DELETE FROM managed_pi_sessions WHERE owner_id=${ownerId} AND chat_id=${chatId.data}
          AND session_id=${row.session_id} AND revision=${row.revision} RETURNING session_id`.execute(tx);
        check(signal);
        return { status: deleted.rows.length === 1 ? 'deleted' as const : 'modified' as const };
      });
    } catch (error: unknown) {
      if (error instanceof CopyCancelled) return { status: 'unavailable' };
      if (error instanceof GoogleProvenanceUnavailable) return { status: 'modified' };
      throw error;
    }
  };
}
