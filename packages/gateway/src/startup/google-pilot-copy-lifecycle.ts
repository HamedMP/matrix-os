import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { sql, type Kysely } from 'kysely';
import type { ChatDatabase } from '../chat/database.js';
import type { ChatRepository } from '../chat/repository.js';
import { toOutbox } from '../chat/records.js';
import type { ManagedPiStoppedRunReceipt, ManagedPiStopInput } from '../chat/managed-pi-quiescence.js';
import type { BotRuntimeRegistry } from '../bots/runtime-registry.js';
import type { ExecutionAdmissionFence } from '../execution-admission-fence.js';
import type { GooglePilotStorage } from './google-pilot-storage.js';
import { createGoogleStoppedRunReceipts } from './google-stop-receipts.js';
import { createGoogleContextStore } from '../google-data/runtime/contexts.js';
import { boundedProvenanceTransaction } from '../google-data/provenance/transaction.js';
import { createGoogleCanonicalMessageDeletionHandler } from '../google-data/provenance/canonical-message-delete.js';
import { createGoogleManagedPiSessionDeletionHandler } from '../google-data/provenance/managed-copy-writes.js';
import { GoogleProvenanceUnavailable, type PurgeHandlers } from '../google-data/provenance/contracts.js';
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
    const contexts = createGoogleContextStore(db, { deletionAuthority: { async withVerifiedContextDeletion(ownerId, chatId, work) {
                admitted();
                if (ownerId !== options.ownerId)
                    return null;
                const remaining = await remainingContextCopies(ownerId, chatId);
                admitted();
                return remaining.rows.length ? null : work();
            } } });
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
    async function quiesceChat(chatId: string) {
        admitted();
        const runs = await boundedProvenanceTransaction(db, tx => tx.selectFrom('chat_runs as r').innerJoin('chats as c', 'c.id', 'r.chat_id').select(['r.id', 'r.driver_kind'])
            .where('r.chat_id', '=', chatId).where('c.owner_type', '=', 'personal').where('c.owner_id', '=', options.ownerId).limit(101).execute());
        admitted();
        if (runs.length > 100)
            deny();
        for (const run of runs) {
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
                    if (['accepted', 'running', 'waiting_for_input', 'waiting_for_approval'].includes(current!.status)) {
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
            const rows = await boundedProvenanceTransaction(db, tx => sql<{
                id: string;
                kind: string;
                entity_ref: string;
            }> `SELECT id,kind,entity_ref FROM google_copy_registry c WHERE owner_id=${options.ownerId} AND state='purging'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.origins) o WHERE o->>'connectionId'=ANY(${contextPurge.originIds}::text[])) AND EXISTS(SELECT 1 FROM google_copy_purge_jobs j WHERE j.copy_id=c.id AND (j.state='pending' OR (j.state='leased' AND j.lease_until<=clock_timestamp()))) ORDER BY id LIMIT 500`.execute(tx));
            admitted();
            const selectedIds = rows.rows.map(row => row.id);
            const affected = selectedIds.length ? await boundedProvenanceTransaction(db, tx => sql<{
                chat_id: string;
            }> `WITH copies AS
        (SELECT kind,entity_ref FROM google_copy_registry WHERE owner_id=${options.ownerId} AND id=ANY(${selectedIds}::uuid[]))
        SELECT DISTINCT chat_id FROM (
          SELECT substring(entity_ref FROM 5) AS chat_id FROM copies WHERE kind='session' AND entity_ref LIKE 'mpi_chat_%'
          UNION ALL SELECT m.chat_id FROM copies c JOIN chat_messages m ON c.entity_ref='cm_'||m.id WHERE c.kind='derived'
          UNION ALL SELECT e.chat_id FROM copies c JOIN chat_run_events e ON (c.entity_ref=e.google_activity_entity_ref OR c.entity_ref='gae_'||e.id) WHERE c.kind='derived'
          UNION ALL SELECT r.chat_id FROM copies c JOIN chat_runs r ON c.entity_ref='grc_'||r.id WHERE c.kind='derived'
          UNION ALL SELECT q.chat_id FROM copies c JOIN chat_queued_turns q ON c.entity_ref='gqc_'||q.id WHERE c.kind='derived') chats LIMIT 501`.execute(tx)) : { rows: [] };
            admitted();
            if (affected.rows.length > 500)
                deny();
            for (const row of affected.rows)
                await quiesceChat(row.chat_id);
            for (const copy of rows.rows) {
                if (copy.kind === 'derived' && copy.entity_ref.startsWith('gae_'))
                    await options.storage.activity.quiesceCopy(options.ownerId, copy.entity_ref, closing.signal);
                if (copy.kind === 'derived' && /^(grc_|gqc_)/.test(copy.entity_ref))
                    await options.storage.context.quiesceCopy(options.ownerId, copy.entity_ref, closing.signal);
                admitted();
            }
            const handlerWork = new Set<Promise<unknown>>();
            function track(handler: NonNullable<PurgeHandlers['derived']>): NonNullable<PurgeHandlers['derived']> { return input => { admitted(); const work = handler({ ...input, signal: AbortSignal.any([input.signal, operationSignal!]) }); handlerWork.add(work); void work.then(() => { handlerWork.delete(work); }, (error: unknown) => { handlerWork.delete(work); console.warn('[google-data] Copy handler failed', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' }); }); return work; }; }
            const handlers: PurgeHandlers = { session: track(sessions), derived: track(input => input.entityRef.startsWith('cm_') ? canonical(input) : input.entityRef.startsWith('gae_') ? options.storage.activity.delete(input) : /^(grc_|gqc_)/.test(input.entityRef) ? options.storage.context.delete(input) : Promise.resolve({ status: 'unavailable' })) };
            try {
                for (let i = 0; i < rows.rows.length; i++) {
                    admitted();
                    const claim = await options.storage.provenance.claimPurge('google-pilot-host', { ownerId: options.ownerId, copyIds: selectedIds });
                    admitted();
                    if (!claim)
                        break;
                    await options.storage.provenance.executeClaim(claim, handlers);
                    admitted();
                }
            }
            finally {
                await Promise.allSettled([...handlerWork]);
            }
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
    let expiryCursor = '';
    async function sweep() {
        if (closed || active)
            return;
        // Closed markers are not expiry. Only actual source/copy deadlines trigger account cleanup.
        // Already-deleted copies cannot create endless new expiry commands for a mixed closed context.
        try {
            const accounts = await boundedProvenanceTransaction(db, tx => sql<{ account_id: string }>`SELECT account_id FROM (
              SELECT DISTINCT s.google_account_id::text AS account_id FROM google_context_sources s
              WHERE s.owner_id=${options.ownerId} AND EXISTS(SELECT 1 FROM google_copy_registry c
                WHERE c.owner_id=s.owner_id AND c.state<>'deleted' AND c.origins @> jsonb_build_array(jsonb_build_object('connectionId',s.origin_id))
                AND (s.expires_at<=clock_timestamp() OR c.retention_deadline<=clock_timestamp()))
            ) expired ORDER BY (account_id>${expiryCursor}) DESC, account_id LIMIT 10`.execute(tx));
            for (const { account_id } of accounts.rows) {
                check();
                // Advance before awaiting: an unavailable account must not monopolize every bounded pass.
                expiryCursor = account_id;
                try {
                    const existing = await boundedProvenanceTransaction(db, tx => sql<{ input: unknown }>`SELECT input FROM google_pilot_purge_commands
                      WHERE owner_id=${options.ownerId} AND account_id=${account_id}::uuid AND NOT complete ORDER BY created_at LIMIT 1`.execute(tx));
                    check();
                    const command = existing.rows[0];
                    await purge(command ? commandSchema.parse(command.input) : { ownerId: options.ownerId, googleAccountId: account_id, commandId: randomUUID(), revision: 1 });
                } catch (error: unknown) {
                    check();
                    console.warn('[google-data] Account copy cleanup unavailable', { errorClass: error instanceof Error ? 'Error' : 'UnknownError' });
                }
            }
        } finally {
            // Independent bounded maintenance still runs after account or lookup failures. A closed
            // lifecycle starts no new work; close drains any maintenance already in progress.
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
