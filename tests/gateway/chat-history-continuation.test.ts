import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalProviderCatalogSchema } from '@matrix-os/contracts';
import { CanonicalChatOrchestrator } from '../../packages/gateway/src/chat/orchestrator.js';
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from '../../packages/gateway/src/chat/provider-adapter.js';
import { createOwnerChatHistoryRepository } from '../../packages/gateway/src/startup/chat-history.js';
import { createGoogleModelHistoryReader } from '../../packages/gateway/src/google-data/runtime/model-history-reader.js';
import { createGoogleContextStore } from '../../packages/gateway/src/google-data/runtime/contexts.js';
import { createAuthorityFixture } from './google-data/fixture-db.js';

const owner = { type: 'personal' as const, ownerId: 'owner_history' };
const principal = { userId: owner.ownerId, source: 'jwt' as const };
const selection = { instanceId: 'codex_default', model: 'gpt-5.6-sol' };
const account = '10000000-0000-4000-8000-000000000001';
const catalog = CanonicalProviderCatalogSchema.parse({ revision: 'history_catalog',
  drivers: [{ kind: 'codex', displayName: 'Codex', adapterVersion: '1.0.0', capabilityClass: 'coding_agent' }],
  instances: [{ id: selection.instanceId, driverKind: 'codex', displayName: 'Codex', availability: 'available',
    workspaceRequirement: 'project_optional', catalogRevision: 'history_catalog', models: [{ id: selection.model,
      displayName: 'Model', availability: 'available', capabilities: ['reasoning', 'tools'], supportsVision: false, supportsToolUse: true }],
    options: [], skills: [], commands: [], setupActions: [], supports: { rootChat: true, resume: true, cancellation: true,
      steering: 'same_run', attachments: [], tools: [], approvals: true, userInput: true, worktrees: 'optional', resources: [],
      interactionModes: ['default'], permissionModes: ['supervised'] } }] });
let repository: ReturnType<typeof createOwnerChatHistoryRepository>['repository'];
let orchestrator: CanonicalChatOrchestrator | undefined;
let release: () => void;
beforeEach(async () => {
  const { db } = await createAuthorityFixture();
  const history = createOwnerChatHistoryRepository(db.sql);
  await history.bootstrap(); repository = history.repository;
  await repository.create(owner, { id: 'chat_one', clientRequestId: 'req_create', title: 'one' });
});
afterEach(async () => { release?.(); await orchestrator?.drain(); orchestrator = undefined; });
const request = (id: string, revision = 0) => ({ clientRequestId: id, baseRevision: revision,
  selection, interactionMode: 'default', permissionMode: 'supervised', parts: [{ type: 'text' as const, text: 'Hello' }] });

async function fixture() {
  let clock = new Date(); let matched = true;
  let starts = 0;
  const paused = new Promise<void>(done => { release = done; });
  const steer = vi.fn(async () => undefined);
  const submitInput = vi.fn(async () => undefined);
  const submitApproval = vi.fn(async () => undefined);
  const adapter: CanonicalChatProviderAdapter = { driverKind: 'codex', stateSchemaVersion: 1,
    parseState: value => value, serializeState: value => value, steer, submitInput, submitApproval,
    cancel: async () => release(),
    start: async function* () {
      starts++;
      yield { type: 'state.updated', state: { sessionId: 'synthetic' } };
      yield { type: 'input.requested', requestId: 'input_one', title: 'Name', questions: [{ questionId: 'name',
        question: 'Name?', header: 'Name', allowOther: true, secret: false }] };
      yield { type: 'approval.requested', approvalId: 'approval_one', title: 'Continue?', risk: 'medium',
        allowedDecisions: ['approve', 'decline', 'cancel'] };
      await paused;
      yield { type: 'run.completed', outcome: 'completed' };
    } };
  const reader = createGoogleModelHistoryReader({ repository, isGuardedAdapter: value => matched && value === adapter,
    now: () => clock });
  const assertRun = vi.spyOn(reader, 'assertRun');
  const adapters = new CanonicalChatProviderRegistry([adapter]);
  orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog },
    adapters, modelHistory: reader });
  const admitted = await orchestrator.admitTurn(principal, owner, 'chat_one', request('req_active'));
  await vi.waitFor(async () => expect((await repository.getPendingApproval(owner,
    { chatId: 'chat_one', runId: admitted.run.id, approvalId: 'approval_one' }))?.approvalId).toBe('approval_one'));
  // Queue while ordinary; later history changes must not consume this owner input.
  const queued = await orchestrator.enqueueQueuedTurn(principal, owner, 'chat_one',
    request('req_queue', (await repository.get(owner, 'chat_one'))!.chat.revision));
  const contexts = createGoogleContextStore(repository.kysely);
  await contexts.mark({ ownerId: owner.ownerId, chatId: 'chat_one', googleAccountId: account,
    consentId: 'consent_one', profileId: 'reviewed', profileRevision: 1, purposeId: 'assistant',
    expiresAt: new Date(clock.getTime() + 60_000).toISOString(), retentionDeadline: new Date(clock.getTime() + 60_000).toISOString() });
  const calls = { steer, queued: steer, answer: submitInput, approve: submitApproval };
  async function invoke(kind: keyof typeof calls, id = 'req_control') {
    if (kind === 'steer') return orchestrator!.steerRun(owner, 'chat_one', admitted.run.id,
      { clientRequestId: id, expectedTurnId: admitted.turn.id, parts: [{ type: 'text', text: 'Change direction' }] });
    if (kind === 'queued') return orchestrator!.steerQueuedTurn(owner, 'chat_one', admitted.run.id, queued.queuedTurn.id,
      { clientRequestId: id, expectedTurnId: admitted.turn.id, baseRevision: (await repository.get(owner, 'chat_one'))!.chat.revision });
    if (kind === 'answer') return orchestrator!.submitInput(owner, 'chat_one', admitted.run.id, 'input_one',
      { clientRequestId: id, structuredAnswers: { name: ['Synthetic'] } });
    return orchestrator!.submitApproval(owner, 'chat_one', admitted.run.id, 'approval_one',
      { clientRequestId: id, decision: 'approve' });
  }
  return { adapter, adapters, admitted, queued, reader, assertRun, contexts, calls, invoke, starts: () => starts,
    expire: () => { clock = new Date(clock.getTime() + 120_000); },
    mismatch: () => { matched = false; },
    restore: () => { matched = true; clock = new Date(); },
    purge: () => contexts.beginPurge(owner.ownerId, account) };
}

describe('current history on canonical continuation sends', () => {
  for (const kind of ['steer', 'queued', 'answer', 'approve'] as const) {
    it(`${kind} checks the actual current adapter and succeeds with current Google history`, async () => {
      const f = await fixture(); f.assertRun.mockClear();
      await f.invoke(kind);
      expect(f.calls[kind]).toHaveBeenCalledOnce();
      expect(f.assertRun).toHaveBeenCalledWith(expect.objectContaining({ owner, chatId: 'chat_one', adapter: f.adapter,
        signal: expect.any(AbortSignal) }));
    });
    it.each(['expired', 'purging', 'mismatched'] as const)(`${kind} withholds %s history without consuming pending owner input`, async state => {
      const f = await fixture();
      if (state === 'expired') f.expire(); else if (state === 'purging') await f.purge(); else f.mismatch();
      await expect(f.invoke(kind)).rejects.toThrow();
      expect(f.calls[kind]).not.toHaveBeenCalled();
      const answer = await repository.getInputState(owner, { chatId: 'chat_one', runId: f.admitted.run.id, requestId: 'input_one' });
      expect(answer.submitted).toBeFalsy(); expect(answer.resolved).toBeFalsy();
      expect(await repository.getPendingApproval(owner, { chatId: 'chat_one', runId: f.admitted.run.id, approvalId: 'approval_one' })).toBeTruthy();
      const saved = await repository.exportChat(owner, 'chat_one');
      expect(saved!.messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect((await repository.listQueuedTurns(owner, 'chat_one')).find(turn => turn.id === f.queued.queuedTurn.id))
        .toMatchObject({ parts: f.queued.queuedTurn.parts });
    });
    it(`${kind} rechecks history after an awaited adapter-state read`, async () => {
      const f = await fixture();
      const getState = repository.getAdapterState.bind(repository);
      vi.spyOn(repository, 'getAdapterState').mockImplementationOnce(async (...args) => {
        const state = await getState(...args); await f.purge(); return state;
      });
      await expect(f.invoke(kind)).rejects.toThrow(); expect(f.calls[kind]).not.toHaveBeenCalled();
    });
    it(`${kind} refuses a cancelled run after its final history await`, async () => {
      const f = await fixture();
      const check = f.reader.assertRun.bind(f.reader);
      f.assertRun.mockImplementationOnce(async input => {
        await check(input);
        await orchestrator!.cancelRun(owner, 'chat_one', f.admitted.run.id);
      });
      await expect(f.invoke(kind)).rejects.toThrow(); expect(f.calls[kind]).not.toHaveBeenCalled();
    });
    it(`${kind} rejects an active adapter that is no longer the registered object`, async () => {
      const f = await fixture();
      vi.spyOn(f.adapters, 'get').mockReturnValue({ ...f.adapter });
      await expect(f.invoke(kind)).rejects.toThrow(); expect(f.calls[kind]).not.toHaveBeenCalled();
    });
  }
  it('drain waits for queue preparation after the active run has left the registry', async () => {
    await fixture();
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(repository, 'claimNextQueuedTurn').mockImplementationOnce(async () => {
      enter(); await paused; return null;
    });
    release();
    await entered;
    expect(orchestrator!.activeCount).toBe(0);
    let drained = false;
    const draining = orchestrator!.drain().then(() => { drained = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(drained).toBe(false);
    } finally { resume(); await draining; }
    expect(drained).toBe(true);
  });
  it('quiesces an expired run rather than forwarding a decline that could resume its model', async () => {
    const f = await fixture(); f.expire();
    await expect(orchestrator!.submitApproval(owner, 'chat_one', f.admitted.run.id, 'approval_one',
      { clientRequestId: 'req_decline', decision: 'decline' })).rejects.toThrow();
    expect(f.calls.approve).not.toHaveBeenCalled();
    expect((await repository.get(owner, 'chat_one'))!.activeRun).toBeUndefined();
    await orchestrator!.drain();
    expect(f.starts()).toBe(1); // Stop may promote the queue, but closed history cannot reach another adapter send.
  });
  it('keeps a definitely unsent answer retryable after history becomes current again', async () => {
    const f = await fixture(); f.expire();
    await expect(f.invoke('answer')).rejects.toMatchObject({ safeError: { retryable: true } });
    f.restore();
    await expect(f.invoke('answer', 'req_retry')).resolves.toMatchObject({ submission: 'accepted' });
    expect(f.calls.answer).toHaveBeenCalledOnce();
  });
});
