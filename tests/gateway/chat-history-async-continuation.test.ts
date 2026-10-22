import { describe, expect, it, vi } from 'vitest';
import { withCanonicalChatHistory } from '../../packages/gateway/src/chat/continuation-admission.js';
import type { CanonicalChatProviderAdapter, CanonicalProviderRunEvent, CanonicalProviderRunInput } from '../../packages/gateway/src/chat/provider-adapter.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(live = false, holdTool = false, secret = false) {
  const controller = new AbortController();
  const tool = deferred(); const phase = deferred();
  let denied = false;
  const input = { owner: { type: 'personal', ownerId: 'owner_async' }, chatId: 'chat_async', runId: 'run_async',
    turnId: 'turn_async', prompt: 'Hello', parts: [{ type: 'text', text: 'Hello' }], selection: { instanceId: 'codex', model: 'test' },
    interactionMode: 'default', permissionMode: 'supervised', signal: controller.signal } as CanonicalProviderRunInput;
  const resume = vi.fn(async function* () { yield { type: 'run.completed', outcome: 'completed' } as const; });
  const submitDeferredInput = vi.fn(async () => { phase.resolve(); });
  const submitInput = vi.fn(async () => { phase.resolve(); });
  const native: CanonicalChatProviderAdapter = { driverKind: 'codex', stateSchemaVersion: 1,
    parseState: value => value, serializeState: value => value, resume, submitInput,
    deferInput: async () => { if (holdTool) await tool.promise; },
    ...(live ? { submitDeferredInput } : {}),
    start: async function* () {
      yield { type: 'state.updated', state: { session: 'synthetic' } };
      yield { type: 'input.requested', requestId: 'question', title: 'Name', questions: [{ questionId: 'name',
        question: 'Name?', header: 'Name', allowOther: true, secret }] };
      if (live) await phase.promise;
      yield { type: 'run.completed', outcome: 'completed' };
    } };
  const assertRun = vi.fn(async operation => {
    if (denied || operation.signal.aborted) throw new Error('Chat context unavailable');
  });
  const adapter = withCanonicalChatHistory(native, { assertRun, read: vi.fn() });
  const events: CanonicalProviderRunEvent[] = [];
  const outcome = (async () => { for await (const event of adapter.start(input)) events.push(event); })()
    .then(() => ({ ok: true }), error => ({ error }));
  const ready = () => vi.waitFor(() => expect(events.some(event => event.type === 'input.requested')).toBe(true));
  const answer = () => adapter.submitInput!({ owner: input.owner, chatId: input.chatId, runId: input.runId,
    requestId: 'question', clientRequestId: 'req_answer', structuredAnswers: { name: ['Synthetic'] } });
  const cleanup = async () => { controller.abort(); tool.resolve(); phase.resolve(); await outcome; };
  return { controller, input, native, adapter, assertRun, events, outcome, ready, answer, cleanup, resume, submitDeferredInput, submitInput,
    deny: () => { denied = true; }, allow: () => { denied = false; }, releaseTool: tool.resolve, releasePhase: phase.resolve };
}
describe('history guard at actual asynchronous native sends', () => {
  it('uses the final registered wrapper identity and original run signal', async () => {
    const f = fixture();
    try {
      await f.ready();
      expect(f.assertRun).toHaveBeenCalledWith(expect.objectContaining({ owner: f.input.owner,
        chatId: f.input.chatId, adapter: f.adapter, signal: f.controller.signal }));
      expect(f.adapter).not.toBe(f.native);
    } finally { await f.cleanup(); }
  });
  it('rechecks after an idle question wait before resuming a previously admitted answer', async () => {
    const f = fixture();
    try {
      await f.ready(); await new Promise(done => setTimeout(done, 0));
      f.deny(); await f.answer();
      expect(await f.outcome).toEqual({ error: expect.objectContaining({ message: 'Chat context unavailable' }) });
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.events.some(event => event.type === 'input.resolved' && event.reason === 'answered')).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('rechecks after deferred-tool release and preserves a refused live answer for retry', async () => {
    const f = fixture(true, true);
    try {
      await f.ready();
      const submitted = f.answer();
      const outcome = submitted.then(value => ({ value }), error => ({ error }));
      f.deny(); f.releaseTool();
      expect(await outcome).toEqual({ error: expect.objectContaining({ name: 'ChatInputNotDeliveredError' }) });
      expect(f.submitDeferredInput).not.toHaveBeenCalled();
      expect(f.events.some(event => event.type === 'input.resolved' && event.reason === 'answered')).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('preserves a definitely unsent native-only secret answer request for retry', async () => {
    const f = fixture(true, false, true);
    try {
      await f.ready(); f.deny();
      await expect(f.answer()).rejects.toMatchObject({ name: 'ChatInputNotDeliveredError' });
      expect(f.submitInput).not.toHaveBeenCalled();
      f.allow(); await f.answer(); await f.outcome;
      expect(f.submitInput).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });
  it('keeps immutable run and pending answer ownership across deferred waits', async () => {
    const f = fixture(true, true);
    try {
      await f.ready(); const answer = f.answer();
      f.input.owner.ownerId = 'substituted_owner';
      f.releaseTool(); await answer; await f.outcome;
      expect(f.submitDeferredInput).toHaveBeenCalledWith(expect.objectContaining({ owner: { type: 'personal', ownerId: 'owner_async' },
        chatId: 'chat_async', runId: 'run_async' }));
      for (const [operation] of f.assertRun.mock.calls) expect(operation.owner.ownerId).toBe('owner_async');
    } finally { await f.cleanup(); }
  });
});
