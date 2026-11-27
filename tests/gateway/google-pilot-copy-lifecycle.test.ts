import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import type { ChatRunContext } from '@matrix-os/contracts';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { bootstrapChatSharing } from '../../packages/gateway/src/chat/sharing.js';
import { ChatRepository } from '../../packages/gateway/src/chat/repository.js';
import { createOwnerChatHistoryRepository } from '../../packages/gateway/src/startup/chat-history.js';
import { createGooglePilotCopyLifecycle } from '../../packages/gateway/src/startup/google-pilot-copy-lifecycle.js';
import { createGoogleContextStore } from '../../packages/gateway/src/google-data/runtime/contexts.js';
import { createExecutionAdmissionFence } from '../../packages/gateway/src/execution-admission-fence.js';
import { bootstrapCollaborationDatabase } from '../../packages/gateway/src/collaboration/database.js';
import { ManagedPiStopUnavailable } from '../../packages/gateway/src/chat/managed-pi-quiescence.js';
import { BotRuntimeRegistry } from '../../packages/gateway/src/bots/runtime-registry.js';
const owner = { type: 'personal' as const, ownerId: 'owner-one' };
const account = '123e4567-e89b-42d3-a456-426614174000';
const command = { ownerId: owner.ownerId, googleAccountId: account, commandId: '123e4567-e89b-42d3-a456-426614174001', revision: 1 };
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'] | undefined;
let lifecycle: Awaited<ReturnType<typeof createGooglePilotCopyLifecycle>> | undefined;
let registry: BotRuntimeRegistry | undefined;
afterEach(async () => { await lifecycle?.close(); lifecycle = undefined; registry?.shutdown(); await db?.destroy(); db = undefined; });
async function admit(repo: ChatRepository, suffix = 'one', subject = { type: 'personal' as const, ownerId: 'owner-one' }, context?: ChatRunContext) {
    const chatId = `chat_${suffix}`;
    const created = await repo.create(subject, { id: chatId, clientRequestId: `req_create_${suffix}`, title: 'Synthetic' });
    const at = new Date().toISOString();
    const message = { id: `msg_user_${suffix}`, chatId, seq: 1, role: 'user' as const, state: 'committed' as const,
        purpose: 'ai_request' as const, turnId: `cturn_${suffix}`, parts: [{ type: 'text' as const, text: 'preserve owner words' }], createdAt: at };
    const turn = { id: `cturn_${suffix}`, chatId, clientRequestId: `req_turn_${suffix}`, baseMessageSeq: 0,
        inputMessageId: message.id, status: 'accepted' as const, createdAt: at, updatedAt: at };
    const run = { id: `run_${suffix}`, chatId, turnId: turn.id, attempt: 1, driverKind: 'codex' as const,
        instanceId: 'codex_default', selection: { instanceId: 'codex_default', model: 'synthetic' },
        interactionMode: 'default' as const, permissionMode: 'supervised' as const, status: 'accepted' as const, historyBoundarySeq: 0, ...(context ? { context } : {}),
        capabilitySnapshot: { revision: 'catalog_1', rootChat: true, attachments: ['file' as const], resources: ['file' as const],
            tools: ['read'], approvals: true, userInput: true, resume: true, cancellation: true, steering: 'same_run' as const,
            worktrees: 'optional' as const, interactionModes: ['default' as const], permissionModes: ['supervised' as const] }, createdAt: at, updatedAt: at };
    await repo.admitTurn(subject, { chatId, baseRevision: created.chat.revision, message, turn, run });
}
async function fixture(stopped: boolean) {
    ({ db } = await createAuthorityFixture());
    const history = createOwnerChatHistoryRepository(db.sql, { pilot: { enabled: true, ownerId: owner.ownerId } });
    await history.bootstrap();
    const repository = history.repository;
    await bootstrapCollaborationDatabase(repository.kysely as never);
    await admit(repository);
    await sql `UPDATE chat_runs SET driver_kind='matrix_pi' WHERE id='run_one'`.execute(repository.kysely);
    const contexts = createGoogleContextStore(repository.kysely);
    const deadline = new Date(Date.now() + 60000).toISOString();
    await contexts.mark({ ownerId: owner.ownerId, chatId: 'chat_one', googleAccountId: account, consentId: 'consent_one', profileId: 'profile_one', profileRevision: 1, purposeId: 'assistant', expiresAt: deadline, retentionDeadline: deadline });
    await repository.appendAssistantDelta(owner, { chatId: 'chat_one', runId: 'run_one', messageId: 'msg_assistant_one', delta: 'synthetic Google-derived result', createdAt: new Date().toISOString() });
    const fence = createExecutionAdmissionFence();
    registry = new BotRuntimeRegistry();
    lifecycle = await createGooglePilotCopyLifecycle({ database: repository.kysely, ownerId: owner.ownerId, storage: history.googleCopies!, repository, registry,
        fence, pendingCount: () => 0, intervalMs:1000 });
    const stop = vi.fn(async (input: {chatId:string;runId:string}) => {
        if (!stopped)
            throw new ManagedPiStopUnavailable();
        await lifecycle!.onStopped({ version: 1, ownerId: owner.ownerId, chatId: input.chatId, runId: input.runId, runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', stoppedAt: new Date().toISOString() });
    });
    lifecycle.bindManaged({ stopAndDrain: stop });
    return { repository, contexts, fence, stop, history };
}
describe('durable exact-owner pilot copy cleanup', () => {
    it('persists a command before work, drains actual stop and redacts only registered derived content', async () => {
        const f = await fixture(true);
        const result = await lifecycle!.purgeAccount(command);
        expect(result).toMatchObject({ complete: true, pending: 0, unresolved: 0, coverage: 'registered-copies-only' });
        expect(f.stop).toHaveBeenCalledOnce();
        const detail = await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 });
        expect(JSON.stringify(detail)).not.toContain('synthetic Google-derived result');
        expect(JSON.stringify(detail)).toContain('preserve owner words');
        expect((await f.contexts.inspect(owner.ownerId, 'chat_one'))?.availability).toBe('deleted');
        expect(f.fence.blocked).toBe(false);
        const calls = f.stop.mock.calls.length;
        expect(await lifecycle!.purgeAccount(command)).toEqual(result);
        expect(f.stop).toHaveBeenCalledTimes(calls);
        expect((await sql `SELECT * FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows).toHaveLength(1);
    });
    it.each(['closed', 'expired'] as const)('sweeps legacy Side Chat answers and public snapshots after a marker is %s', async state => {
        const f = await fixture(true);
        const legacyChat = state === 'closed' ? 'chat_one' : 'chat_legacy';
        await bootstrapChatSharing(f.repository.kysely);
        if (state === 'closed') {
            expect((await lifecycle!.purgeAccount(command)).complete).toBe(true);
            expect((await f.contexts.inspect(owner.ownerId, legacyChat))?.availability).toBe('deleted');
        } else {
            await f.repository.create(owner, { id: legacyChat, clientRequestId: 'req_create_legacy', title: 'Synthetic' });
            const legacyAccount = '123e4567-e89b-42d3-a456-426614174099';
            const future = new Date(Date.now() + 60_000).toISOString();
            await f.contexts.mark({ ownerId: owner.ownerId, chatId: legacyChat, googleAccountId: legacyAccount,
                consentId: 'consent_legacy', profileId: 'profile_one', profileRevision: 1, purposeId: 'assistant',
                expiresAt: future, retentionDeadline: future });
            await sql`UPDATE google_context_sources SET expires_at=now()-interval '1 second'
                WHERE google_account_id=${legacyAccount}::uuid`.execute(f.repository.kysely);
        }
        await f.repository.create(owner, { id: 'chat_ordinary', clientRequestId: 'req_create_ordinary', title: 'Ordinary' });
        // Fixture for rows written by builds that did not classify these derived surfaces.
        await f.repository.kysely.transaction().execute(async tx => {
            for (const chat of [legacyChat, 'chat_ordinary']) {
                const threadId = `side_${chat}`;
                await sql`INSERT INTO chat_side_threads (id,chat_id,owner_type,owner_id)
                    VALUES(${threadId},${chat},'personal',${owner.ownerId})`.execute(tx);
                await sql`INSERT INTO chat_side_messages (thread_id,seq,role,content,client_request_id)
                    VALUES(${threadId},1,'user','Owner question','req_question'),
                          (${threadId},2,'assistant','Synthetic retained answer','req_question')`.execute(tx);
                await sql`INSERT INTO chat_shares (id,chat_id,token_hash,snapshot,expires_at)
                    VALUES(${`share_${chat}`},${chat},${`hash_${chat}`},
                        '{"title":"Synthetic","messages":[{"role":"assistant","text":"Retained snapshot"}]}',now()+interval '1 day')`.execute(tx);
            }
        });
        lifecycle!.start();
        await vi.waitFor(async () => {
            expect((await f.repository.kysely.selectFrom('chat_shares').select('chat_id').execute()).map(row => row.chat_id))
                .toEqual(['chat_ordinary']);
            expect((await f.repository.kysely.selectFrom('chat_side_messages').select(['thread_id', 'role'])
                .where('thread_id', '=', `side_${legacyChat}`).execute()).map(row => row.role)).toEqual(['user']);
            expect((await f.contexts.inspect(owner.ownerId, legacyChat))?.availability).toBe('deleted');
        }, { timeout: 4000, interval: 50 });
        expect((await f.repository.kysely.selectFrom('chat_side_messages').select('role')
            .where('thread_id', '=', 'side_chat_ordinary').orderBy('seq').execute()).map(row => row.role)).toEqual(['user', 'assistant']);
        expect((await sql`SELECT complete FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows)
            .toEqual(state === 'closed' ? [{ complete: true }] : []);
    });
    it('withholds completion on missing runtime proof and preserves copied data; persisted proofs support a later pass', async () => {
        const f = await fixture(false);
        expect(await lifecycle!.purgeAccount(command)).toMatchObject({ complete: false, pending: 1, unresolved: 0 });
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 }))).toContain('synthetic Google-derived result');
        expect((await f.contexts.inspect(owner.ownerId, 'chat_one'))?.availability).toBe('purging');
        expect(f.fence.blocked).toBe(false);
        expect((await sql<{
            complete: boolean;
        }> `SELECT complete FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows[0]?.complete).toBe(false);
        await lifecycle!.onStopped({ version: 1, ownerId: owner.ownerId, chatId: 'chat_one', runId: 'run_one', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', stoppedAt: new Date().toISOString() });
        await sql`UPDATE google_copy_purge_jobs SET next_attempt=clock_timestamp()`.execute(f.repository.kysely);
        expect((await lifecycle!.purgeAccount(command)).complete).toBe(true);
    });
    it('lets unrelated Chats start while a background retry waits on a tracked run', async () => {
        const f = await fixture(false);
        expect((await lifecycle!.purgeAccount(command)).complete).toBe(false);
        await sql`UPDATE google_copy_purge_jobs SET next_attempt=clock_timestamp()`.execute(f.repository.kysely);
        let release!: () => void;
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        f.stop.mockImplementation(async () => {
            entered();
            await new Promise<void>(resolve => { release = resolve; });
            throw new ManagedPiStopUnavailable();
        });
        lifecycle!.start();
        await waiting;
        try {
            expect(f.fence.blocked).toBe(false);
            expect(f.fence.isChatBlocked('chat_one')).toBe(true);
            expect(f.fence.isChatBlocked('chat_ordinary')).toBe(false);
        } finally {
            release();
            await lifecycle!.close();
        }
        expect(f.fence.isChatBlocked('chat_one')).toBe(false);
    });
    it('purges only the superseded origin after renewed consent has been used', async () => {
        const f = await fixture(true);
        const old = (await f.contexts.sourcesForAccount(owner.ownerId, account))[0]!;
        await admit(f.repository, 'renewed');
        const future = new Date(Date.now()+60000).toISOString();
        await f.contexts.mark({ ownerId: owner.ownerId, chatId: 'chat_renewed', googleAccountId: account,
            consentId: 'consent_renewed', profileId: old.profileId, profileRevision: old.profileRevision,
            purposeId: old.purposeId, expiresAt: future, retentionDeadline: future });
        await f.repository.appendAssistantDelta(owner, { chatId: 'chat_renewed', runId: 'run_renewed',
            messageId: 'msg_assistant_renewed', delta: 'Synthetic result under renewed consent', createdAt: new Date().toISOString() });
        await f.repository.finishRun(owner, { chatId: 'chat_renewed', runId: 'run_renewed',
            outcome: 'completed', completedAt: new Date().toISOString() });
        const result = await lifecycle!.purgeAccount({ ...command, consentId: old.consentId, originId: old.originId });
        expect(result.complete).toBe(true);
        expect((await f.contexts.inspect(owner.ownerId, 'chat_one'))?.availability).toBe('deleted');
        expect((await f.contexts.inspect(owner.ownerId, 'chat_renewed'))?.availability).toBe('available');
        expect(await f.history.googleCopies!.provenance.inspect(owner.ownerId, 'derived', 'cm_msg_assistant_renewed'))
            .toMatchObject({ state: 'active' });
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_renewed', { limit: 20 })))
            .toContain('Synthetic result under renewed consent');
    });
    it('never claims another account or owner job before their separate admission', async () => {
        const f = await fixture(true);
        const store = f.history.googleCopies!.provenance;
        const values = [{ ownerId: owner.ownerId, connection: 'other_origin', entity: 'other_copy' }, { ownerId: 'other', connection: 'foreign_origin', entity: 'foreign_copy' }];
        for (const value of values) {
            await store.record({ ownerId: value.ownerId, kind: 'derived', entityRef: value.entity, contentHash: 'b'.repeat(64), origins: [{ connectionId: value.connection, profileId: 'profile_one', profileRevision: 1, purpose: 'assistant' }], retention: { choice: 'until', deadline: new Date(Date.now() + 60000).toISOString(), decisionId: 'choice_one' } });
            await store.requestPurge(value.ownerId, value.connection, 'request_one');
        }
        await lifecycle!.purgeAccount(command);
        const jobs = (await sql<{
            owner_id: string;
            attempts: number;
            state: string;
        }> `SELECT j.owner_id,j.attempts,j.state FROM google_copy_purge_jobs j JOIN google_copy_registry c ON c.id=j.copy_id WHERE c.entity_ref IN ('other_copy','foreign_copy')`.execute(f.repository.kysely)).rows;
        expect(jobs).toHaveLength(2);
        expect(jobs.every(job => job.attempts === 0 && job.state === 'pending')).toBe(true);
    });
    it('cancels after a real stop wait without deleting content and drains the operation before shutdown', async () => {
        const f = await fixture(false);
        const controller = new AbortController();
        const original = f.stop.getMockImplementation()!;
        let release!: () => void;
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        f.stop.mockImplementation(async input => { entered(); await new Promise<void>(resolve => { release = resolve; }); return original(input); });
        const pending = lifecycle!.purgeAccount(command, controller.signal);
        const settled = Promise.allSettled([pending]);
        await waiting;
        controller.abort();
        let closed = false;
        const close = lifecycle!.close().then(() => { closed = true; });
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(f.fence.blocked).toBe(false);
        expect(f.fence.isChatBlocked('chat_one')).toBe(true);
        release();
        expect((await settled)[0]?.status).toBe('rejected');
        await close;
        expect(f.fence.blocked).toBe(false);
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 }))).toContain('synthetic Google-derived result');
    });
    it('keeps verified erasure and missing-proof backoff committed if a later stop exceeds the command budget', async () => {
        const f = await fixture(false);
        const source = (await f.contexts.sourcesForAccount(owner.ownerId, account))[0]!;
        for (const suffix of ['ready', 'blocked']) {
            await admit(f.repository, suffix);
            const chatId = `chat_${suffix}`;
            await f.contexts.mark({ ownerId: owner.ownerId, chatId, googleAccountId: account,
                consentId: source.consentId, profileId: source.profileId, profileRevision: source.profileRevision,
                purposeId: source.purposeId, expiresAt: source.expiresAt, retentionDeadline: source.expiresAt });
            await f.repository.appendAssistantDelta(owner, { chatId, runId: `run_${suffix}`, messageId: `msg_assistant_${suffix}`,
                delta: 'Synthetic retained answer', createdAt: new Date().toISOString() });
        }
        await f.repository.finishRun(owner, { chatId: 'chat_ready', runId: 'run_ready', outcome: 'completed',
            completedAt: new Date().toISOString() });
        await sql`UPDATE chat_runs SET driver_kind='matrix_pi' WHERE id='run_blocked'`.execute(f.repository.kysely);
        await f.history.googleCopies!.provenance.requestPurge(owner.ownerId, source.originId, 'request_inflight');
        await sql`UPDATE google_copy_purge_jobs j SET next_attempt=now() - CASE c.entity_ref
            WHEN 'cm_msg_assistant_ready' THEN interval '3 seconds'
            WHEN 'cm_msg_assistant_one' THEN interval '2 seconds' ELSE interval '1 second' END
            FROM google_copy_registry c WHERE c.id=j.copy_id`.execute(f.repository.kysely);
        const controller = new AbortController();
        f.stop.mockImplementation(async input => {
            if (input.runId === 'run_blocked') controller.abort();
            throw new ManagedPiStopUnavailable();
        });

        await expect(lifecycle!.purgeAccount(command, controller.signal)).rejects.toThrow();
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_ready', { limit: 20 }))).not.toContain('Synthetic retained answer');
        expect(f.stop.mock.calls.map(([input]) => input.runId)).toEqual(['run_one', 'run_blocked']);
        const jobs = (await sql`SELECT c.entity_ref,j.state,j.attempts,j.next_attempt>clock_timestamp() AS deferred
            FROM google_copy_purge_jobs j JOIN google_copy_registry c ON c.id=j.copy_id
            WHERE c.entity_ref IN ('cm_msg_assistant_one','cm_msg_assistant_blocked') ORDER BY c.entity_ref`.execute(f.repository.kysely)).rows;
        expect(jobs).toEqual([
            { entity_ref: 'cm_msg_assistant_blocked', state: 'pending', attempts: 0, deferred: false },
            { entity_ref: 'cm_msg_assistant_one', state: 'pending', attempts: 0, deferred: true },
        ]);
    });
    it('resolves hashed activity copies to their chat before accepting any run-status deletion proof', async () => {
        const f=await fixture(true); await admit(f.repository,'two');
        const source=(await f.contexts.sourcesForAccount(owner.ownerId,account))[0]!;
        await f.contexts.mark({ownerId:owner.ownerId,chatId:'chat_two',googleAccountId:account,consentId:source.consentId,profileId:source.profileId,profileRevision:source.profileRevision,purposeId:source.purposeId,expiresAt:source.expiresAt,retentionDeadline:source.expiresAt});
        await f.repository.appendRunActivities(owner,'chat_two','run_two',[{id:'event:pilot.tool',chatId:'chat_two',runId:'run_two',occurredAt:new Date().toISOString(),type:'agent.activity',activityId:'tool_pilot',kind:'command',label:'Synthetic',status:'running',summary:'synthetic retained activity'}]);
        // run_two stays an active nonmanaged (codex) run: only resolving the hashed copy to chat_two refuses it.
        expect(await lifecycle!.purgeAccount(command)).toMatchObject({ complete: false, pending: 1, unresolved: 0 });
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 }))).not.toContain('synthetic Google-derived result');
        expect(JSON.stringify((await f.repository.kysely.selectFrom('chat_run_events').select('event').where('chat_id','=','chat_two').execute()))).toContain('synthetic retained activity');
        expect(f.stop.mock.calls.some(([input])=>input.runId==='run_two')).toBe(false);
    });
    it.each(['activity', 'snapshot'] as const)('erases verified copies when a finished run has no stop proof for its %s', async kind => {
        const f = await fixture(true);
        await f.repository.create(owner, { id: 'chat_two', clientRequestId: 'req_create_two', title: 'Synthetic' });
        const source = (await f.contexts.sourcesForAccount(owner.ownerId, account))[0]!;
        await f.contexts.mark({ ownerId: owner.ownerId, chatId: 'chat_two', googleAccountId: account,
            consentId: source.consentId, profileId: source.profileId, profileRevision: source.profileRevision,
            purposeId: source.purposeId, expiresAt: source.expiresAt, retentionDeadline: source.expiresAt });
        const retained = 'retained copy without stop proof';
        const context = kind === 'snapshot' ? { version: 1 as const, requestHash: 'a'.repeat(64),
            chats: [{ chatId: 'chat_two', title: 'Synthetic', throughSeq: 1, text: retained, truncated: false }] } : undefined;
        await admit(f.repository, 'two', owner, context);
        if (kind === 'activity') await f.repository.appendRunActivities(owner, 'chat_two', 'run_two', [{
            id: 'event:pilot.unverified', chatId: 'chat_two', runId: 'run_two', occurredAt: new Date().toISOString(),
            type: 'agent.activity', activityId: 'tool_unverified', kind: 'command', label: 'Synthetic',
            status: 'running', summary: retained,
        }]);
        await sql`UPDATE chat_runs SET driver_kind='matrix_pi' WHERE id='run_two'`.execute(f.repository.kysely);
        await f.repository.finishRun(owner, { chatId: 'chat_two', runId: 'run_two', outcome: 'completed', completedAt: new Date().toISOString() });
        const stop = f.stop.getMockImplementation()!;
        f.stop.mockImplementation(async input => {
            if (input.runId === 'run_two') throw new ManagedPiStopUnavailable();
            return stop(input);
        });

        expect(await lifecycle!.purgeAccount(command)).toMatchObject({ complete: false, pending: 1, unresolved: 0 });
        expect((await sql`SELECT attempts FROM google_copy_purge_jobs WHERE state='pending'`.execute(f.repository.kysely)).rows)
            .toEqual([{ attempts: 0 }]);
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 }))).not.toContain('synthetic Google-derived result');
        const readCopy = () => kind === 'activity'
            ? f.repository.kysely.selectFrom('chat_run_events').select('event').where('chat_id', '=', 'chat_two').execute()
            : f.repository.kysely.selectFrom('chat_runs').select('context_snapshot').where('id', '=', 'run_two').execute();
        expect(JSON.stringify(await readCopy())).toContain(retained);
        if (kind === 'activity') {
            // Older builds settled a missing stop receipt as terminal unavailable.
            await sql`UPDATE google_copy_purge_jobs SET state='unresolved',reason='unavailable',attempts=1
                WHERE state='pending'`.execute(f.repository.kysely);
        }
        await lifecycle!.onStopped({ version: 1, ownerId: owner.ownerId, chatId: 'chat_two', runId: 'run_two',
            runtimeHandle: `runtime_${'b'.repeat(32)}`, executionGeneration: '1', stoppedAt: new Date().toISOString() });
        await sql`UPDATE google_copy_purge_jobs SET next_attempt=clock_timestamp() WHERE state<>'deleted'`.execute(f.repository.kysely);
        lifecycle!.start();
        await vi.waitFor(async () => {
            expect((await sql`SELECT complete FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows)
                .toEqual([{ complete: true }]);
        }, { timeout: 4000, interval: 50 });
        expect(JSON.stringify(await readCopy())).not.toContain(retained);
    });
    it('does not let finished nonmanaged runtime history block registered-copy purge', async () => {
        const f = await fixture(true);
        await sql `UPDATE chat_runs SET driver_kind='codex',status='failed',outcome='failed',started_at=now(),completed_at=now() WHERE id='run_one'`.execute(f.repository.kysely);
        expect(await lifecycle!.purgeAccount(command)).toMatchObject({ complete: true, pending: 0, unresolved: 0 });
        expect(f.stop).not.toHaveBeenCalled();
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 }))).not.toContain('synthetic Google-derived result');
    });
    it('completes purge for a chat with 150 finished runs including Claude-driver history', async () => {
        const f = await fixture(true);
        await sql `INSERT INTO chat_turns SELECT (jsonb_populate_record(NULL::chat_turns,to_jsonb(t)||jsonb_build_object('id','cturn_hist_'||n,
          'client_request_id','req_turn_hist_'||n,'status','completed'))).* FROM chat_turns t, generate_series(1,150) n WHERE t.id='cturn_one'`.execute(f.repository.kysely);
        await sql `INSERT INTO chat_runs SELECT (jsonb_populate_record(NULL::chat_runs,to_jsonb(r)||jsonb_build_object('id','run_hist_'||n,'turn_id','cturn_hist_'||n,
          'driver_kind',CASE WHEN n%2=0 THEN 'claude' ELSE 'matrix_pi' END,'client_request_id','req_hist_'||n,'status','completed',
          'outcome','completed','started_at',clock_timestamp(),'completed_at',clock_timestamp()))).* FROM chat_runs r, generate_series(1,150) n WHERE r.id='run_one'`.execute(f.repository.kysely);
        expect(await lifecycle!.purgeAccount(command)).toMatchObject({ complete: true, pending: 0, unresolved: 0 });
        expect(f.stop).toHaveBeenCalledOnce();
        expect(f.stop.mock.calls[0]![0].runId).toBe('run_one');
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 }))).not.toContain('synthetic Google-derived result');
    });
    it('still refuses purge while a nonmanaged run is active', async () => {
        const f = await fixture(true);
        await sql `UPDATE chat_runs SET driver_kind='codex',status='running',started_at=now() WHERE id='run_one'`.execute(f.repository.kysely);
        expect(await lifecycle!.purgeAccount(command)).toMatchObject({ complete: false, pending: 1, unresolved: 0 });
        expect(f.stop).not.toHaveBeenCalled();
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 }))).toContain('synthetic Google-derived result');
    });
    it('denies forged owner/account/revision replay and immutable stopped-generation replacement', async () => {
        const f = await fixture(true);
        await expect(lifecycle!.purgeAccount({ ...command, ownerId: 'other' })).rejects.toThrow();
        expect(f.stop).not.toHaveBeenCalled();
        await lifecycle!.purgeAccount(command);
        await expect(lifecycle!.purgeAccount({ ...command, googleAccountId: '123e4567-e89b-42d3-a456-426614174002' })).rejects.toThrow();
        await lifecycle!.purgeAccount({ ...command, revision: 2 });
        await expect(lifecycle!.purgeAccount({ ...command, revision: 0 })).rejects.toThrow();
        await expect(lifecycle!.onStopped({ version: 1, ownerId: owner.ownerId, chatId: 'chat_one', runId: 'run_one', runtimeHandle: `runtime_${'b'.repeat(32)}`, executionGeneration: '2', stoppedAt: new Date().toISOString() })).rejects.toThrow();
    });
    it('ACKs only the requested account while retaining other-account content behind an unavailable mixed context', async () => {
        const f=await fixture(true); const otherAccount='123e4567-e89b-42d3-a456-426614174004'; const future=new Date(Date.now()+60000).toISOString();
        await f.contexts.mark({ownerId:owner.ownerId,chatId:'chat_one',googleAccountId:otherAccount,expectedRevision:1,consentId:'consent_other',profileId:'profile_one',profileRevision:1,purposeId:'assistant',expiresAt:future,retentionDeadline:future});
        const source=(await f.contexts.sourcesForAccount(owner.ownerId,otherAccount))[0]!;
        await f.history.googleCopies!.provenance.record({ownerId:owner.ownerId,kind:'derived',entityRef:'other_account_retained_copy',contentHash:'c'.repeat(64),origins:[{connectionId:source.originId,profileId:source.profileId,profileRevision:source.profileRevision,purpose:source.purposeId}],retention:{choice:'until',deadline:future,decisionId:'other_choice'}});
        expect(await lifecycle!.purgeAccount(command)).toMatchObject({complete:true,pending:0,unresolved:0});
        expect((await f.contexts.inspect(owner.ownerId,'chat_one'))?.availability).toBe('purging');
        expect(await f.history.googleCopies!.provenance.inspect(owner.ownerId,'derived','other_account_retained_copy')).toMatchObject({state:'active'});
        await sql`UPDATE google_context_sources SET expires_at=now()-interval '1 second' WHERE google_account_id=${account}::uuid`.execute(f.repository.kysely);
        lifecycle!.start(); await new Promise(resolve=>setTimeout(resolve,20)); await lifecycle!.close();
        expect((await sql`SELECT * FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows).toHaveLength(1);
    });
    it.each([false, true])('expires just the marked Chat when it has registered copies=%s', async withCopies => {
        const f = await fixture(true);
        const source = (await f.contexts.sourcesForAccount(owner.ownerId, account))[0]!;
        await admit(f.repository, 'expired');
        await sql`UPDATE chat_runs SET driver_kind='matrix_pi' WHERE id='run_expired'`.execute(f.repository.kysely);
        await f.contexts.mark({ ownerId: owner.ownerId, chatId: 'chat_expired', googleAccountId: account,
            consentId: source.consentId, profileId: source.profileId, profileRevision: source.profileRevision,
            purposeId: source.purposeId, expiresAt: source.expiresAt, retentionDeadline: source.expiresAt });
        if (withCopies) await f.repository.appendAssistantDelta(owner, { chatId: 'chat_expired', runId: 'run_expired',
            messageId: 'msg_assistant_expired', delta: 'Expired synthetic answer', createdAt: new Date().toISOString() });
        await sql`UPDATE google_context_markers SET retention_deadline=now()-interval '1 second'
            WHERE chat_id='chat_expired'`.execute(f.repository.kysely);

        lifecycle!.start();
        await vi.waitFor(async () => {
            expect((await f.contexts.inspect(owner.ownerId, 'chat_expired'))?.availability).toBe('deleted');
        }, { timeout: 4000, interval: 50 });
        expect((await f.contexts.inspect(owner.ownerId, 'chat_one'))?.availability).toBe('available');
        expect((await f.contexts.sourcesForAccount(owner.ownerId, account))[0]?.state).toBe('active');
        expect(await f.history.googleCopies!.provenance.inspect(owner.ownerId, 'derived', 'cm_msg_assistant_one'))
            .toMatchObject({ state: 'active' });
        expect(f.stop.mock.calls.map(([input]) => input.runId)).toEqual(withCopies ? ['run_expired'] : []);
        expect((await sql`SELECT 1 FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows).toEqual([]);
        expect((await sql`SELECT 1 FROM google_copy_purge_requests`.execute(f.repository.kysely)).rows).toEqual([]);
        if (withCopies) expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_expired', { limit: 20 })))
            .not.toContain('Expired synthetic answer');
        await f.contexts.mark({ ownerId: owner.ownerId, chatId: 'chat_one', expectedRevision: 1, googleAccountId: account,
            consentId: source.consentId, profileId: source.profileId, profileRevision: source.profileRevision,
            purposeId: source.purposeId, expiresAt: source.expiresAt, retentionDeadline: source.expiresAt });
    });
    it('continues to the next expired Chat after an actual stop-proof failure', async () => {
        const f = await fixture(false);
        const next = '123e4567-e89b-42d3-a456-426614174009';
        await admit(f.repository,'two');
        await sql`UPDATE chat_runs SET driver_kind='matrix_pi' WHERE id='run_two'`.execute(f.repository.kysely);
        const future = new Date(Date.now()+60000).toISOString();
        await f.contexts.mark({ownerId:owner.ownerId,chatId:'chat_two',googleAccountId:next,consentId:'consent_two',profileId:'profile_one',profileRevision:1,purposeId:'assistant',expiresAt:future,retentionDeadline:future});
        await f.repository.appendAssistantDelta(owner,{chatId:'chat_two',runId:'run_two',messageId:'msg_assistant_two',delta:'second account result',createdAt:new Date().toISOString()});
        f.stop.mockImplementation(async input => {
            if (input.runId==='run_one') throw new Error('Unknown live driver');
            await lifecycle!.onStopped({version:1,ownerId:owner.ownerId,chatId:input.chatId,runId:input.runId,runtimeHandle:`runtime_${'b'.repeat(32)}`,executionGeneration:'1',stoppedAt:new Date().toISOString()});
        });
        await sql`UPDATE google_context_sources SET expires_at=now()-interval '1 second'`.execute(f.repository.kysely);
        lifecycle!.start();
        await vi.waitFor(async () => {
            expect((await f.contexts.inspect(owner.ownerId, 'chat_two'))?.availability).toBe('deleted');
        },{timeout:4000,interval:50});
        await lifecycle!.close();
        expect(JSON.stringify(await f.repository.getDetailPage(owner,'chat_one',{limit:20}))).toContain('synthetic Google-derived result');
        expect(JSON.stringify(await f.repository.getDetailPage(owner,'chat_two',{limit:20}))).not.toContain('second account result');
    });
    it('rotates past failing accepted commands and still runs Chat expiry and metadata cleanup', async () => {
        const f = await fixture(true);
        const accounts = Array.from({ length: 11 }, (_, i) =>
            `123e4567-e89b-42d3-a456-426614174${String(i + 10).padStart(3, '0')}`);
        for (const id of accounts.slice(0, 10)) {
            await sql`INSERT INTO google_pilot_purge_commands(owner_id,command_id,revision,account_id,input_digest,input)
                VALUES(${owner.ownerId},gen_random_uuid(),1,${id}::uuid,'malformed','{}'::jsonb)`.execute(f.repository.kysely);
        }
        // A previously accepted command, interrupted just after durable admission.
        const next = { ...command, googleAccountId: accounts[10]!, commandId: '123e4567-e89b-42d3-a456-426614174088' };
        const digest = createHash('sha256').update(JSON.stringify(next)).digest('hex');
        await sql`INSERT INTO google_pilot_purge_commands(owner_id,command_id,revision,account_id,input_digest,input)
            VALUES(${owner.ownerId},${next.commandId}::uuid,1,${next.googleAccountId}::uuid,${digest},${JSON.stringify(next)}::jsonb)`.execute(f.repository.kysely);
        await sql`UPDATE google_context_markers SET retention_deadline=now()-interval '1 second' WHERE chat_id='chat_one'`.execute(f.repository.kysely);
        await admit(f.repository, 'historical');
        await sql`INSERT INTO google_managed_stop_receipts VALUES(${owner.ownerId},'chat_historical','run_historical',${`runtime_${'a'.repeat(32)}`},'1',now()-interval '36 days')`.execute(f.repository.kysely);
        const cleanup = vi.spyOn(f.history.googleCopies!.provenance,'cleanupDeleted').mockRejectedValueOnce(new Error('Synthetic cleanup failure'));
        lifecycle!.start();
        try {
            await vi.waitFor(async () => {
                const rows = await sql`SELECT complete FROM google_pilot_purge_commands WHERE account_id=${next.googleAccountId}::uuid`.execute(f.repository.kysely);
                expect(rows.rows).toEqual([{ complete: true }]);
                expect((await f.contexts.inspect(owner.ownerId, 'chat_one'))?.availability).toBe('deleted');
                expect(cleanup).toHaveBeenCalled();
                expect((await sql`SELECT 1 FROM google_managed_stop_receipts WHERE stopped_at<now()-interval '35 days'`.execute(f.repository.kysely)).rows).toHaveLength(0);
            }, { timeout: 4000, interval: 100 });
        } finally { await lifecycle!.close(); cleanup.mockRestore(); }
    });
    it('cleans an expired Chat with actual stop proof without creating an account command', async () => {
        const f = await fixture(true);
        await sql`UPDATE google_context_sources SET expires_at=now()-interval '1 second' WHERE owner_id=${owner.ownerId}`.execute(f.repository.kysely);
        lifecycle!.start();
        await vi.waitFor(async () => {
            expect((await f.contexts.inspect(owner.ownerId, 'chat_one'))?.availability).toBe('deleted');
        });
        expect((await sql`SELECT 1 FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows).toEqual([]);
        expect(f.stop).toHaveBeenCalledOnce();
        expect(JSON.stringify(await f.repository.getDetailPage(owner,'chat_one',{limit:20}))).not.toContain('synthetic Google-derived result');
    });
    it('expires an individual copy while retaining its live Chat and source', async () => {
        const f = await fixture(true);
        await sql`UPDATE google_copy_registry SET retention_deadline=now()-interval '1 second' WHERE entity_ref='cm_msg_assistant_one'`.execute(f.repository.kysely);
        lifecycle!.start();
        await vi.waitFor(async () => {
            expect(await f.history.googleCopies!.provenance.inspect(owner.ownerId, 'derived', 'cm_msg_assistant_one'))
                .toMatchObject({ state: 'deleted' });
        });
        expect((await f.contexts.inspect(owner.ownerId, 'chat_one'))?.availability).toBe('available');
        expect((await f.contexts.sourcesForAccount(owner.ownerId, account))[0]?.state).toBe('active');
        expect((await sql`SELECT 1 FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows).toEqual([]);
        expect(f.stop).toHaveBeenCalledOnce();
    });
    it('accepts a new command ID revision one for the same account without repurging completed data', async () => {
        const f = await fixture(true);
        await lifecycle!.purgeAccount(command);
        expect((await lifecycle!.purgeAccount({ ...command, commandId: '123e4567-e89b-42d3-a456-426614174003' })).complete).toBe(true);
        expect((await sql `SELECT * FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows).toHaveLength(2);
    });
    it('requires admission and bounded pending-claim drain; closed lifecycle leaves the shared pool alive', async () => {
        const f = await fixture(true);
        const release = f.fence.tryAcquire()!;
        await expect(lifecycle!.purgeAccount(command)).rejects.toThrow();
        release();
        expect(f.stop).not.toHaveBeenCalled();
        await lifecycle!.close();
        await expect(lifecycle!.purgeAccount(command)).rejects.toThrow();
        expect((await sql `SELECT 1`.execute(f.repository.kysely)).rows).toHaveLength(1);
    });
});
