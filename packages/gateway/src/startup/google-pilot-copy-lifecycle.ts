import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { ChatDatabase } from '../chat/database.js';
import type { ChatRepository } from '../chat/repository.js';
import { toOutbox } from '../chat/records.js';
import { ManagedPiStopUnavailable, type ManagedPiStoppedRunReceipt, type ManagedPiStopInput } from '../chat/managed-pi-quiescence.js';
import type { BotRuntimeRegistry } from '../bots/runtime-registry.js';
import type { ExecutionAdmissionFence } from '../execution-admission-fence.js';
import type { GooglePilotStorage } from './google-pilot-storage.js';
import { createGoogleStoppedRunReceipts } from './google-stop-receipts.js';
import { createGoogleContextStore, googleContextRetentionExpired, type GoogleContextDeletionAuthority } from '../google-data/runtime/contexts.js';
import { boundedProvenanceTransaction } from '../google-data/provenance/transaction.js';
import { createGoogleCanonicalMessageDeletionHandler } from '../google-data/provenance/canonical-message-delete.js';
import { createGoogleManagedPiSessionDeletionHandler } from '../google-data/provenance/managed-copy-writes.js';
import { defaults as provenanceDefaults, GoogleProvenanceUnavailable, type PurgeHandlers } from '../google-data/provenance/contracts.js';
const commandSchema = z.strictObject({ ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/), googleAccountId: z.uuid().transform(v => v.toLowerCase()),
    commandId: z.uuid().transform(v => v.toLowerCase()), revision: z.number().int().positive().max(2147483647),
    originId: z.string().regex(/^[a-f0-9]{64}$/).optional(), consentId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).optional() });
export type GooglePilotPurgeCommand = z.infer<typeof commandSchema>;
export interface GooglePilotPurgeReceipt {
    complete: boolean;
    pending: number;
    unresolved: number;
    coverage: 'registered-copies-only';
    requestIds: string[];
}
const receiptSchema = z.strictObject({ complete: z.boolean(), pending: z.number().int().nonnegative(), unresolved: z.number().int().nonnegative(), coverage: z.literal('registered-copies-only'), requestIds: z.array(z.uuid()).max(32) });
const deny = (): never => { throw new GoogleProvenanceUnavailable(); };
/** Canonical non-terminal run statuses (terminal: completed, failed, aborted). */
const ACTIVE_RUN_STATUSES = ['accepted', 'running', 'waiting_for_input', 'waiting_for_approval'] as const;
// Resolve only registered entity formats. The caller restricts c to the exact owner.
const copyChats = sql`
    SELECT substring(c.entity_ref FROM 5) AS chat_id WHERE c.kind='session' AND left(c.entity_ref,9)='mpi_chat_'
    UNION ALL SELECT m.chat_id FROM chat_messages m
      WHERE c.kind='derived' AND left(c.entity_ref,3)='cm_' AND m.id=substring(c.entity_ref FROM 4)
    UNION ALL SELECT e.chat_id FROM chat_run_events e
      WHERE c.kind='derived' AND left(c.entity_ref,4)='gae_'
        AND (e.google_activity_entity_ref=c.entity_ref OR e.id=substring(c.entity_ref FROM 5))
    UNION ALL SELECT r.chat_id FROM chat_runs r
      WHERE c.kind='derived' AND left(c.entity_ref,4)='grc_' AND r.id=substring(c.entity_ref FROM 5)
    UNION ALL SELECT q.chat_id FROM chat_queued_turns q
      WHERE c.kind='derived' AND left(c.entity_ref,4)='gqc_' AND q.id=substring(c.entity_ref FROM 5)`;
/** Isolated exact-owner host only. Commands are server-authenticated by the transport composer,
 * not by this helper. No copied content enters its metadata receipt tables. */
export async function createGooglePilotCopyLifecycle(options: {
    database: Kysely<ChatDatabase>;
    ownerId: string;
    storage: GooglePilotStorage;
    repository: Pick<ChatRepository, 'publishCommittedExternalOutbox'>;
    registry: Pick<BotRuntimeRegistry, 'lookupRun'>;
    fence: ExecutionAdmissionFence;
    pendingCount(): number;
    intervalMs?: number;
}) {
    commandSchema.shape.ownerId.parse(options.ownerId);
    const db = options.database;
    const stops = createGoogleStoppedRunReceipts(db, options.ownerId);
    await stops.migrate();
    await boundedProvenanceTransaction(db, async (tx) => {
        await sql `CREATE TABLE IF NOT EXISTS google_pilot_purge_commands(owner_id TEXT NOT NULL,command_id UUID NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>0),account_id UUID NOT NULL,input_digest TEXT NOT NULL,
      complete BOOLEAN NOT NULL DEFAULT false,input JSONB NOT NULL CHECK(octet_length(input::text)<=2048),result JSONB NULL CHECK(result IS NULL OR octet_length(result::text)<=8192),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,command_id,revision))`.execute(tx);
    });
    let managed: {
        stopAndDrain(input: ManagedPiStopInput): Promise<unknown>;
    } | undefined;
    let closed = false;
    let held = false;
    let active: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const closing = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const check = (signal?: AbortSignal) => { if (closed || signal?.aborted || closing.signal.aborted || operationSignal?.aborted)
        deny(); };
    const admitted = () => { check(); if (!held || !options.fence.blocked || options.pendingCount() !== 0)
        deny(); };
    const remainingContextCopies = (ownerId: string, chatId: string) => boundedProvenanceTransaction(db, tx => sql `SELECT 1 FROM google_copy_registry c WHERE c.owner_id=${ownerId}
    AND c.state<>'deleted' AND EXISTS(SELECT 1 FROM google_context_origins o JOIN google_context_markers m ON m.id=o.context_id
      WHERE m.owner_id=${ownerId} AND m.chat_id=${chatId} AND c.origins @> jsonb_build_array(jsonb_build_object('connectionId',o.origin_id))) LIMIT 1`.execute(tx));
    const remainingChatCopies = (ownerId: string, chatId: string) => boundedProvenanceTransaction(db, tx => sql`
        SELECT 1 FROM google_copy_registry c WHERE c.owner_id=${ownerId} AND c.state<>'deleted'
        AND EXISTS(SELECT 1 FROM (${copyChats}) binding WHERE binding.chat_id=${chatId}) LIMIT 1`.execute(tx));
    function deletionAuthority(remainingCopies: typeof remainingContextCopies): GoogleContextDeletionAuthority {
        return { async withVerifiedContextDeletion(ownerId, chatId, work) {
            admitted();
            if (ownerId !== options.ownerId) return null;
            const remaining = await remainingCopies(ownerId, chatId);
            admitted();
            return remaining.rows.length ? null : work();
        } };
    }
    const contexts = createGoogleContextStore(db, { deletionAuthority: deletionAuthority(remainingContextCopies) });
    const expiryContexts = createGoogleContextStore(db, { deletionAuthority: deletionAuthority(remainingChatCopies) });
    async function stopped<T>(key: {
        ownerId: string;
        chatId: string;
        runId: string;
        signal?: AbortSignal;
    }, work: () => Promise<T>): Promise<T | null> {
        admitted();
        if (key.ownerId !== options.ownerId)
            deny();
        const signal = AbortSignal.any([closing.signal, operationSignal!, ...(key.signal ? [key.signal] : []), AbortSignal.timeout(30000)]);
        let receipt = await stops.get({ ownerId: key.ownerId, chatId: key.chatId, runId: key.runId });
        check(signal);
        if (!receipt) {
            if (!managed)
                deny();
            await managed!.stopAndDrain({ ...key, signal });
            admitted();
            check(signal);
            receipt = await stops.get({ ownerId: key.ownerId, chatId: key.chatId, runId: key.runId });
        }
        admitted();
        check(signal);
        if (!receipt || options.registry.lookupRun(receipt))
            deny();
        const result = await work();
        admitted();
        check(signal);
        return result;
    }
    options.storage.installQuiescence({ withStoppedRun: stopped }, { async withStoppedQueue(key, work) {
            admitted();
            if (key.ownerId !== options.ownerId)
                deny();
            check(key.signal);
            const result = await work();
            admitted();
            check(key.signal);
            return result;
        } });
    async function withAdmission<T>(work: () => Promise<T>, parent?: AbortSignal): Promise<T> {
        check();
        if (active)
            deny();
        const release = options.fence.tryAcquire();
        if (!release)
            deny();
        operationSignal = AbortSignal.any([closing.signal, AbortSignal.timeout(60000), ...(parent ? [parent] : [])]);
        held = true;
        const task = (async () => {
            const deadline = Date.now() + 5000;
            while (options.pendingCount() > 0) {
                check();
                if (Date.now() >= deadline)
                    deny();
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            admitted();
            return work();
        })();
        active = task;
        try {
            return await task;
        }
        finally {
            held = false;
            active = undefined;
            operationSignal = undefined;
            release!();
        }
    }
    // Only live runs can still write copies. Finished runs of any driver and long histories never block a
    // registered-copy purge; the execution fence held by withAdmission prevents new runs meanwhile. A chat has
    // at most one active run (idx_chat_runs_one_active), so the 100-row cap only refuses corrupt state.
    async function quiesceChat(chatId: string) {
        admitted();
        const runs = await boundedProvenanceTransaction(db, tx => tx.selectFrom('chat_runs as r').innerJoin('chats as c', 'c.id', 'r.chat_id').select(['r.id', 'r.driver_kind'])
            .where('r.chat_id', '=', chatId).where('r.status', 'in', ACTIVE_RUN_STATUSES).where('c.owner_type', '=', 'personal')
            .where('c.owner_id', '=', options.ownerId).limit(101).execute());
        admitted();
        if (runs.length > 100)
            deny();
        for (const run of runs) {
            // Only the managed Pi stop path can prove an active run stopped.
            if (run.driver_kind !== 'matrix_pi')
                deny();
            await stopped({ ownerId: options.ownerId, chatId, runId: run.id, signal: closing.signal }, async () => {
                let invalidation: Parameters<ChatRepository['publishCommittedExternalOutbox']>[1] | undefined;
                await boundedProvenanceTransaction(db, async (tx) => {
                    const chat = await tx.selectFrom('chats').select(['id', 'revision']).where('id', '=', chatId).where('owner_type', '=', 'personal').where('owner_id', '=', options.ownerId).where('collaboration', 'is', null).forUpdate().executeTakeFirst();
                    if (!chat)
                        deny();
                    const current = await tx.selectFrom('chat_runs').select(['status', 'turn_id']).where('id', '=', run.id).where('chat_id', '=', chatId).forUpdate().executeTakeFirst();
                    if (!current)
                        deny();
                    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(current!.status)) {
                        await tx.updateTable('chat_runs').set({ status: 'aborted', outcome: 'aborted', started_at: sql `coalesce(started_at,now())`, completed_at: sql `now()`, updated_at: sql `now()` }).where('id', '=', run.id).execute();
                        await tx.updateTable('chat_turns').set({ status: 'aborted', updated_at: sql `now()` }).where('id', '=', current!.turn_id).where('chat_id', '=', chatId).execute();
                        const revision = Number(chat!.revision) + 1;
                        if (!Number.isSafeInteger(revision))
                            deny();
                        await tx.updateTable('chats').set({ revision, attention: 'none', updated_at: sql `now()` }).where('id', '=', chatId).execute();
                        const row = await tx.insertInto('chat_outbox').values({ owner_type: 'personal', owner_id: options.ownerId, chat_id: chatId, revision, event_type: 'chat.updated', payload: sql `'{}'::jsonb` }).returningAll().executeTakeFirstOrThrow();
                        invalidation = toOutbox(row);
                    }
                });
                admitted();
                if (invalidation)
                    options.repository.publishCommittedExternalOutbox({ type: 'personal', ownerId: options.ownerId }, invalidation);
            });
        }
    }
    const canonical = createGoogleCanonicalMessageDeletionHandler(db, { onInvalidation: ({ owner, event }) => options.repository.publishCommittedExternalOutbox(owner, event) });
    const sessions = createGoogleManagedPiSessionDeletionHandler(db);
    // Older deployments put missing run proof in terminal "unavailable".
    const recoverable = sql`j.state='unresolved' AND j.reason='unavailable'
        AND c.kind='derived' AND c.entity_ref ~ '^(gae_|grc_|gqc_)'`;
    const dueForProof = sql`(j.state='pending' AND j.next_attempt<=clock_timestamp())
        OR (j.state='leased' AND j.lease_until<=clock_timestamp())
        OR ((${recoverable}) AND j.next_attempt<=clock_timestamp())`;
    async function processCopies(scope: RawBuilder<unknown>, queueActive = false) {
        if (queueActive) {
            const rows = await boundedProvenanceTransaction(db, tx => sql<{ id: string }>`
                SELECT c.id FROM google_copy_registry c WHERE c.owner_id=${options.ownerId}
                AND c.state='active' AND (${scope}) ORDER BY c.retention_deadline,c.id LIMIT 500`.execute(tx));
            admitted();
            if (rows.rows.length) await options.storage.provenance.queueCopies(options.ownerId, rows.rows.map(row => row.id));
            admitted();
        }
        const rows = await boundedProvenanceTransaction(db, tx => sql<{
            id: string;
            kind: string;
            entity_ref: string;
            recovering: boolean;
        }>`SELECT c.id,c.kind,c.entity_ref,j.state='unresolved' AS recovering
            FROM google_copy_registry c JOIN google_copy_purge_jobs j ON j.copy_id=c.id AND j.owner_id=c.owner_id
            WHERE c.owner_id=${options.ownerId} AND c.state='purging'
            AND (${scope})
            AND (${dueForProof})
            ORDER BY j.next_attempt,c.id LIMIT 500`.execute(tx));
        admitted();
        const selectedIds = rows.rows.map(row => row.id);
        const affected = selectedIds.length ? await boundedProvenanceTransaction(db, tx => sql<{
            copy_id: string;
            chat_id: string;
        }>`SELECT DISTINCT c.id AS copy_id,binding.chat_id
            FROM google_copy_registry c CROSS JOIN LATERAL (${copyChats}) binding
            WHERE c.owner_id=${options.ownerId} AND c.id=ANY(${selectedIds}::uuid[]) LIMIT 501`.execute(tx)) : { rows: [] };
        admitted();
        if (affected.rows.length > 500)
            deny();
        // Both maps are bounded by the 500-row discovery limits.
        const chatsByCopy = new Map<string, string[]>();
        for (const { copy_id, chat_id } of affected.rows) {
            const chats = chatsByCopy.get(copy_id);
            if (chats) chats.push(chat_id);
            else chatsByCopy.set(copy_id, [chat_id]);
        }
        const chatProofs = new Map<string, boolean>();
        async function verifyProof(work: () => Promise<unknown>) {
            try { await work(); }
            catch (error: unknown) {
                admitted();
                if (error instanceof GoogleProvenanceUnavailable || error instanceof ManagedPiStopUnavailable)
                    return false;
                throw error;
            }
            admitted();
            return true;
        }
        async function verifyCopy(copy: typeof rows.rows[number]) {
            for (const chatId of chatsByCopy.get(copy.id) ?? []) {
                const stopped = chatProofs.get(chatId) ?? await verifyProof(() => quiesceChat(chatId));
                chatProofs.set(chatId, stopped);
                if (!stopped) return false;
            }
            if (copy.kind === 'derived' && copy.entity_ref.startsWith('gae_'))
                return verifyProof(() => options.storage.activity.quiesceCopy(options.ownerId, copy.entity_ref, operationSignal));
            if (copy.kind === 'derived' && /^(grc_|gqc_)/.test(copy.entity_ref))
                return verifyProof(() => options.storage.context.quiesceCopy(options.ownerId, copy.entity_ref, operationSignal));
            return true;
        }
        const handlerWork = new Set<Promise<unknown>>();
        function track(handler: NonNullable<PurgeHandlers['derived']>): NonNullable<PurgeHandlers['derived']> { return input => { admitted(); const work = handler({ ...input, signal: AbortSignal.any([input.signal, operationSignal!]) }); handlerWork.add(work); void work.then(() => { handlerWork.delete(work); }, (error: unknown) => { handlerWork.delete(work); console.warn('[google-data] Copy handler failed', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' }); }); return work; }; }
        const handlers: PurgeHandlers = { session: track(sessions), derived: track(input => input.entityRef.startsWith('cm_') ? canonical(input) : input.entityRef.startsWith('gae_') ? options.storage.activity.delete(input) : /^(grc_|gqc_)/.test(input.entityRef) ? options.storage.context.delete(input) : Promise.resolve({ status: 'unavailable' })) };
        try {
            // Commit each erasure or proof backoff before the next stop wait so
            // cancelling a later wait cannot undo work or monopolize the next pass.
            for (const copy of rows.rows) {
                admitted();
                if (!await verifyCopy(copy)) {
                    await boundedProvenanceTransaction(db, tx => sql`UPDATE google_copy_purge_jobs j
                        SET state=CASE WHEN j.state='leased' THEN 'pending' ELSE j.state END,
                            lease_token=NULL,worker_id=NULL,lease_until=NULL,revision=j.revision+1,
                            next_attempt=clock_timestamp()+${provenanceDefaults.retryDelayMs}*interval '1 millisecond',updated_at=now()
                        FROM google_copy_registry c WHERE c.id=j.copy_id AND c.owner_id=j.owner_id AND c.state='purging'
                        AND j.owner_id=${options.ownerId} AND j.copy_id=${copy.id}::uuid AND (${dueForProof})`.execute(tx));
                    continue;
                }
                admitted();
                if (copy.recovering) {
                    await boundedProvenanceTransaction(db, tx => sql`UPDATE google_copy_purge_jobs j
                        SET state='pending',reason=NULL,revision=j.revision+1,updated_at=now()
                        FROM google_copy_registry c WHERE c.id=j.copy_id AND c.owner_id=j.owner_id AND c.state='purging'
                        AND j.owner_id=${options.ownerId} AND j.copy_id=${copy.id}::uuid AND (${recoverable})`.execute(tx));
                    admitted();
                }
                const claim = await options.storage.provenance.claimPurge('google-pilot-host', { ownerId: options.ownerId, copyIds: [copy.id] });
                admitted();
                if (claim) {
                    await options.storage.provenance.executeClaim(claim, handlers);
                    admitted();
                }
            }
        }
        finally {
            await Promise.allSettled([...handlerWork]);
        }
    }

    async function expireChat(chatId: string) {
        await withAdmission(async () => {
            const revision = await expiryContexts.beginExpiredChatPurge(options.ownerId, chatId);
            admitted();
            if (revision === null) return;
            // An ambiguous binding cannot authorize Chat-scoped erasure.
            await processCopies(sql`(SELECT bool_and(binding.chat_id=${chatId}) FROM (${copyChats}) binding) IS TRUE`, true);
            if (!(await remainingChatCopies(options.ownerId, chatId)).rows.length) {
                admitted();
                await expiryContexts.completeDeletion(options.ownerId, chatId, revision);
            }
        });
    }
    async function purge(input: GooglePilotPurgeCommand, signal?: AbortSignal): Promise<GooglePilotPurgeReceipt> {
        const command = commandSchema.parse(input);
        if (command.ownerId !== options.ownerId)
            deny();
        const digest = createHash('sha256').update(JSON.stringify(command)).digest('hex');
        return withAdmission(async () => {
            const saved = await boundedProvenanceTransaction(db, async (tx) => {
                await sql `SELECT pg_advisory_xact_lock(551035507)`.execute(tx);
                const prior = (await sql<{
                    revision: number;
                    account_id: string;
                    input_digest: string;
                    complete: boolean;
                    result: unknown;
                }> `SELECT * FROM google_pilot_purge_commands
          WHERE owner_id=${options.ownerId} AND command_id=${command.commandId} ORDER BY revision DESC FOR UPDATE`.execute(tx)).rows;
                if (prior.some(row => row.account_id !== command.googleAccountId) || (prior[0]?.revision ?? 0) > command.revision)
                    deny();
                const same = prior.find(row => row.revision === command.revision);
                if (same) {
                    if (same.input_digest !== digest)
                        deny();
                    return same;
                }
                const count = (await sql<{
                    count: number;
                }> `SELECT count(*)::int AS count FROM google_pilot_purge_commands`.execute(tx)).rows[0]!.count;
                if (count >= 4096)
                    deny();
                await sql `INSERT INTO google_pilot_purge_commands(owner_id,command_id,revision,account_id,input_digest,input)
          VALUES(${options.ownerId},${command.commandId},${command.revision},${command.googleAccountId},${digest},${JSON.stringify(command)}::jsonb) ON CONFLICT DO NOTHING`.execute(tx);
                return undefined;
            });
            admitted();
            if (saved?.complete)
                return receiptSchema.parse(saved.result);
            const sources = await contexts.sourcesForAccount(options.ownerId, command.googleAccountId);
            admitted();
            if (sources.length > 32)
                deny();
            if (command.originId && sources.some(s => s.originId === command.originId && command.consentId && s.consentId !== command.consentId))
                deny();
            const contextPurge = await contexts.beginPurge(options.ownerId, command.googleAccountId);
            admitted();
            const requestIds: string[] = [];
            for (const originId of contextPurge.originIds) {
                const requestKey = `gpc_${createHash('sha256').update(JSON.stringify([command.commandId, command.revision, originId])).digest('hex')}`;
                requestIds.push((await options.storage.provenance.requestPurge(options.ownerId, originId, requestKey)).id);
                admitted();
            }
            await processCopies(sql`EXISTS(SELECT 1 FROM jsonb_array_elements(c.origins) o
                WHERE o->>'connectionId'=ANY(${contextPurge.originIds}::text[]))`);
            const statuses = [];
            for (const id of requestIds) {
                statuses.push(await options.storage.provenance.status(options.ownerId, id));
                admitted();
            }
            if (statuses.some(s => !s))
                deny();
            const pending = statuses.reduce((n, s) => n + s!.pending, 0), unresolved = statuses.reduce((n, s) => n + s!.unresolved, 0);
            // ACK concerns this exact account's registered copies only. Other-account copies keep
            // mixed contexts permanently unavailable; never attest whole-context erasure for those.
            if (pending === 0 && unresolved === 0)
                for (const chatId of contextPurge.chatIds.slice(0, 100)) {
                    const remaining = await remainingContextCopies(options.ownerId, chatId);
                    admitted();
                    if (!remaining.rows.length) {
                        await contexts.completeDeletion(options.ownerId, chatId, contextPurge.revisions[chatId]!);
                        admitted();
                    }
                }
            const result: GooglePilotPurgeReceipt = { complete: pending === 0 && unresolved === 0, pending, unresolved, coverage: 'registered-copies-only', requestIds };
            await boundedProvenanceTransaction(db, tx => sql `UPDATE google_pilot_purge_commands SET complete=${result.complete},result=${JSON.stringify(result)}::jsonb
        WHERE owner_id=${options.ownerId} AND command_id=${command.commandId} AND revision=${command.revision} AND input_digest=${digest}`.execute(tx));
            admitted();
            return result;
        }, signal);
    }
    let accountCursor = '';
    let chatCursor = '';
    async function sweep() {
        if (closed || active)
            return;
        // Resume accepted commands even before source expiry. Ignore superseded revisions
        // and keep the cursor moving across accounts with unavailable stop proof.
        try {
            const latestIncomplete = sql`p.owner_id=${options.ownerId} AND NOT p.complete AND NOT EXISTS (
                SELECT 1 FROM google_pilot_purge_commands newer WHERE newer.owner_id=p.owner_id
                AND newer.command_id=p.command_id AND newer.revision>p.revision)`;
            const accounts = await boundedProvenanceTransaction(db, tx => sql<{ account_id: string }>`
                SELECT account_id FROM (SELECT DISTINCT p.account_id::text AS account_id
                  FROM google_pilot_purge_commands p WHERE ${latestIncomplete}) due
                ORDER BY (account_id>${accountCursor}) DESC,account_id LIMIT 10`.execute(tx));
            for (const { account_id } of accounts.rows) {
                check();
                accountCursor = account_id;
                try {
                    const existing = await boundedProvenanceTransaction(db, tx => sql<{ input: unknown }>`SELECT p.input FROM google_pilot_purge_commands p
                      WHERE p.account_id=${account_id}::uuid AND ${latestIncomplete} ORDER BY p.created_at LIMIT 1`.execute(tx));
                    check();
                    if (existing.rows[0]) await purge(commandSchema.parse(existing.rows[0].input));
                } catch (error: unknown) {
                    check();
                    console.warn('[google-data] Account copy cleanup unavailable', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' });
                }
            }
            const chats = await boundedProvenanceTransaction(db, tx => sql<{ chat_id: string }>`
                SELECT m.chat_id FROM google_context_markers m WHERE m.owner_id=${options.ownerId} AND m.state<>'deleted'
                AND ${googleContextRetentionExpired} ORDER BY (m.chat_id>${chatCursor}) DESC,m.chat_id LIMIT 10`.execute(tx));
            for (const { chat_id } of chats.rows) {
                check();
                chatCursor = chat_id;
                try { await expireChat(chat_id); }
                catch (error: unknown) {
                    check();
                    console.warn('[google-data] Chat copy cleanup unavailable', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' });
                }
            }
            // A registered copy can expire before its Chat or lack a surviving Chat binding.
            const expiredCopies = sql`c.retention_deadline<=clock_timestamp() OR EXISTS (
                SELECT 1 FROM google_context_sources s WHERE s.owner_id=c.owner_id AND s.expires_at<=clock_timestamp()
                AND c.origins @> jsonb_build_array(jsonb_build_object('connectionId',s.origin_id)))`;
            const due = await boundedProvenanceTransaction(db, tx => sql`
                SELECT 1 FROM google_copy_registry c LEFT JOIN google_copy_purge_jobs j ON j.copy_id=c.id AND j.owner_id=c.owner_id
                WHERE c.owner_id=${options.ownerId} AND (${expiredCopies})
                AND (c.state='active' OR (c.state='purging' AND (${dueForProof}))) LIMIT 1`.execute(tx));
            check();
            if (due.rows.length) await withAdmission(() => processCopies(expiredCopies, true));
        } finally {
            // Independent bounded maintenance still runs after account or lookup failures. A closed
            // lifecycle starts no new work; close drains any maintenance already in progress.
            if (!closed) {
                try { await contexts.cleanupClosedDerivedSurfaces(options.ownerId); }
                catch (error: unknown) { console.warn('[google-data] Legacy derived surface cleanup unavailable', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' }); }
            }
            if (!closed) {
                try { await options.storage.provenance.cleanupDeleted(100); }
                catch (error: unknown) { console.warn('[google-data] Deleted copy cleanup unavailable', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' }); }
                if (!closed) {
                    try { await stops.cleanup(); }
                    catch (error: unknown) { console.warn('[google-data] Stop receipt cleanup unavailable', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' }); }
                }
            }
        }
    }
    let sweeping: Promise<void> | undefined;
    return Object.freeze({ onStopped: (receipt: ManagedPiStoppedRunReceipt) => stops.record(receipt), purgeAccount: purge,
        bindManaged(value: NonNullable<typeof managed>) { if (managed || closed)
            deny(); managed = value; },
        start() {
            if (closed || timer)
                return;
            const interval = options.intervalMs ?? 30000;
            if (!Number.isInteger(interval) || interval < 1000 || interval > 300000)
                deny();
            const tick = () => { sweeping ??= sweep().catch((error: unknown) => console.warn('[google-data] Copy cleanup unavailable', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' })).finally(() => { sweeping = undefined; }); };
            timer = setInterval(tick, interval);
            timer.unref();
            tick();
        },
        async close() { closed = true; closing.abort(); if (timer)
            clearInterval(timer); await Promise.allSettled([sweeping, active]); },
    });
}
