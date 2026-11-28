import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createAuthorityFixture } from './google-data/fixture-db.js';
import { ChatRepository } from '../../packages/gateway/src/chat/repository.js';
import { createOwnerChatHistoryRepository } from '../../packages/gateway/src/startup/chat-history.js';
import { createGooglePilotCopyLifecycle } from '../../packages/gateway/src/startup/google-pilot-copy-lifecycle.js';
import { createGoogleContextStore } from '../../packages/gateway/src/google-data/runtime/contexts.js';
import { createExecutionAdmissionFence } from '../../packages/gateway/src/execution-admission-fence.js';
import { bootstrapCollaborationDatabase } from '../../packages/gateway/src/collaboration/database.js';
import { BotRuntimeRegistry } from '../../packages/gateway/src/bots/runtime-registry.js';
const owner = { type: 'personal' as const, ownerId: 'owner-one' };
const account = '123e4567-e89b-42d3-a456-426614174000';
const command = { ownerId: owner.ownerId, googleAccountId: account, commandId: '123e4567-e89b-42d3-a456-426614174001', revision: 1 };
let db: Awaited<ReturnType<typeof createAuthorityFixture>>['db'] | undefined;
let lifecycle: Awaited<ReturnType<typeof createGooglePilotCopyLifecycle>> | undefined;
let registry: BotRuntimeRegistry | undefined;
afterEach(async () => { await lifecycle?.close(); lifecycle = undefined; registry?.shutdown(); await db?.destroy(); db = undefined; });
async function admit(repo: ChatRepository, suffix = 'one', subject = { type: 'personal' as const, ownerId: 'owner-one' }) {
    const chatId = `chat_${suffix}`;
    const created = await repo.create(subject, { id: chatId, clientRequestId: `req_create_${suffix}`, title: 'Synthetic' });
    const at = new Date().toISOString();
    const message = { id: `msg_user_${suffix}`, chatId, seq: 1, role: 'user' as const, state: 'committed' as const,
        purpose: 'ai_request' as const, turnId: `cturn_${suffix}`, parts: [{ type: 'text' as const, text: 'preserve owner words' }], createdAt: at };
    const turn = { id: `cturn_${suffix}`, chatId, clientRequestId: `req_turn_${suffix}`, baseMessageSeq: 0,
        inputMessageId: message.id, status: 'accepted' as const, createdAt: at, updatedAt: at };
    const run = { id: `run_${suffix}`, chatId, turnId: turn.id, attempt: 1, driverKind: 'codex' as const,
        instanceId: 'codex_default', selection: { instanceId: 'codex_default', model: 'synthetic' },
        interactionMode: 'default' as const, permissionMode: 'supervised' as const, status: 'accepted' as const, historyBoundarySeq: 0,
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
        fence, pendingCount: () => 0 });
    const stop = vi.fn(async (input: {chatId:string;runId:string}) => {
        if (!stopped)
            throw new Error('No actual stop evidence');
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
    it('withholds completion on missing runtime proof and preserves copied data; persisted proofs support a later pass', async () => {
        const f = await fixture(false);
        await expect(lifecycle!.purgeAccount(command)).rejects.toThrow();
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 }))).toContain('synthetic Google-derived result');
        expect((await f.contexts.inspect(owner.ownerId, 'chat_one'))?.availability).toBe('purging');
        expect(f.fence.blocked).toBe(false);
        expect((await sql<{
            complete: boolean;
        }> `SELECT complete FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows[0]?.complete).toBe(false);
        await lifecycle!.onStopped({ version: 1, ownerId: owner.ownerId, chatId: 'chat_one', runId: 'run_one', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', stoppedAt: new Date().toISOString() });
        expect((await lifecycle!.purgeAccount(command)).complete).toBe(true);
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
        expect(f.fence.blocked).toBe(true);
        release();
        expect((await settled)[0]?.status).toBe('rejected');
        await close;
        expect(f.fence.blocked).toBe(false);
        expect(JSON.stringify(await f.repository.getDetailPage(owner, 'chat_one', { limit: 20 }))).toContain('synthetic Google-derived result');
    });
    it('resolves hashed activity copies to their chat before accepting any run-status deletion proof', async () => {
        const f=await fixture(true); await admit(f.repository,'two');
        await sql`UPDATE chat_runs SET driver_kind='matrix_pi' WHERE id='run_two'`.execute(f.repository.kysely);
        const source=(await f.contexts.sourcesForAccount(owner.ownerId,account))[0]!;
        await f.contexts.mark({ownerId:owner.ownerId,chatId:'chat_two',googleAccountId:account,consentId:source.consentId,profileId:source.profileId,profileRevision:source.profileRevision,purposeId:source.purposeId,expiresAt:source.expiresAt,retentionDeadline:source.expiresAt});
        await f.repository.appendRunActivities(owner,'chat_two','run_two',[{id:'event:pilot.tool',chatId:'chat_two',runId:'run_two',occurredAt:new Date().toISOString(),type:'agent.activity',activityId:'tool_pilot',kind:'command',label:'Synthetic',status:'running',summary:'synthetic retained activity'}]);
        await sql`INSERT INTO chat_runs SELECT (jsonb_populate_record(NULL::chat_runs,to_jsonb(r)||jsonb_build_object('id','run_unknown','driver_kind','codex','attempt',2,'client_request_id','req_unknown','status','failed','outcome','failed','started_at',clock_timestamp(),'completed_at',clock_timestamp()))).* FROM chat_runs r WHERE id='run_two'`.execute(f.repository.kysely);
        await expect(lifecycle!.purgeAccount(command)).rejects.toThrow();
        expect(JSON.stringify((await f.repository.kysely.selectFrom('chat_run_events').select('event').where('chat_id','=','chat_two').execute()))).toContain('synthetic retained activity');
        expect(f.stop.mock.calls.some(([input])=>input.runId==='run_unknown')).toBe(false);
    });
    it('refuses nonmanaged runtime history even with terminal canonical status', async () => {
        const f = await fixture(true);
        await sql `UPDATE chat_runs SET driver_kind='codex',status='failed',outcome='failed',started_at=now(),completed_at=now() WHERE id='run_one'`.execute(f.repository.kysely);
        await expect(lifecycle!.purgeAccount(command)).rejects.toThrow();
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
    it('runs recurring expiry cleanup through the same durable command and actual stop proof', async () => {
        const f = await fixture(true);
        await sql `UPDATE google_context_sources SET expires_at=now()-interval '1 second' WHERE owner_id=${owner.ownerId}`.execute(f.repository.kysely);
        lifecycle!.start();
        for (let i = 0; i < 100; i++) {
            const complete = (await sql<{
                complete: boolean;
            }> `SELECT complete FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows[0]?.complete;
            if (complete)
                break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        await lifecycle!.close();
        expect((await sql<{
            complete: boolean;
        }> `SELECT complete FROM google_pilot_purge_commands`.execute(f.repository.kysely)).rows).toEqual([{ complete: true }]);
        expect(f.stop).toHaveBeenCalledOnce();
        expect((await f.contexts.inspect(owner.ownerId, 'chat_one'))?.availability).toBe('deleted');
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
