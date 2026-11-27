import { describe, expect, it, vi } from 'vitest';
import { ChatAgentContext } from '../../packages/gateway/src/chat/agent-context.js';
import { prepareChatSessionContext } from '../../packages/gateway/src/chat/session-history.js';
import { loadChatResumeState } from '../../packages/gateway/src/chat/resume-checkpoint.js';
import { MATRIX_BOT_INSTANCE_ID } from '../../packages/gateway/src/bots/selection.js';

const owner = { type: 'personal' as const, ownerId: 'owner_one' };
describe('model-history boundaries on replay and opaque resumes', () => {
  it.each(['resume', 'bot', 'empty', 'cached'] as const)('checks %s history even when no transcript query is needed', async kind => {
    const read = vi.fn(async () => { throw new Error('Chat context unavailable'); });
    const getDetailPage = vi.fn();
    await expect(prepareChatSessionContext({ owner, chatId: 'chat_one', repository: { getDetailPage },
      instanceId: kind === 'bot' ? MATRIX_BOT_INSTANCE_ID : 'other', throughSeq: kind === 'empty' ? 0 : 1,
      resumeState: kind === 'resume' ? {} : undefined, requestHash: 'a'.repeat(64),
      context: kind === 'cached' ? { version: 1, requestHash: 'a'.repeat(64), chats: [],
        history: { chatId: 'chat_one', title: 'one', throughSeq: 1, text: 'private', truncated: false } } : undefined,
      adapter: {}, modelHistory: { read, assertRun: vi.fn() },
    })).rejects.toThrow('Chat context unavailable');
    expect(read).toHaveBeenCalledOnce(); expect(getDetailPage).not.toHaveBeenCalled();
  });
  it('loads canonical text through the transaction-scoped repository supplied by the gate', async () => {
    const root = { getDetailPage: vi.fn() };
    const scoped = { getDetailPage: vi.fn(async () => ({ record: { chat: { lifecycle: 'active', title: 'one' } }, messages: [] })) };
    const adapter = {};
    const read = vi.fn(async input => {
      expect(input.adapter).toBe(adapter); expect(input.owner).toEqual(owner); expect(input.chatId).toBe('chat_one');
      return input.read(scoped);
    });
    const result = await prepareChatSessionContext({ repository: root, owner, chatId: 'chat_one',
      instanceId: 'other', throughSeq: 1, resumeState: undefined, requestHash: 'a'.repeat(64), adapter,
      modelHistory: { read, assertRun: vi.fn() } });
    expect(result?.history?.title).toBe('one'); expect(root.getDetailPage).not.toHaveBeenCalled(); expect(scoped.getDetailPage).toHaveBeenCalledOnce();
  });
  it.each([false, true])('checks resume admission before the adapter resume=%s shortcut or private state read', async resume => {
    const getLatestAdapterStateForChat = vi.fn();
    const read = vi.fn(async () => { throw new Error('Chat context unavailable'); });
    const adapter = { resume, parseState: vi.fn() } as never;
    await expect(loadChatResumeState({ repository: { getLatestAdapterStateForChat }, owner, chatId: 'chat_one',
      instanceId: 'instance_one', adapter, executionRootFingerprint: null, mode: 'follow_up',
      modelHistory: { read, assertRun: vi.fn() } })).rejects.toThrow('Chat context unavailable');
    expect(read).toHaveBeenCalledOnce(); expect(getLatestAdapterStateForChat).not.toHaveBeenCalled();
  });
  it('loads and parses opaque state only inside the admitted transaction callback', async () => {
    const outer = { getLatestAdapterStateForChat: vi.fn() };
    const scoped = { getLatestAdapterStateForChat: vi.fn(async () => ({ state: 'private' })) };
    const adapter = { resume: true, parseState: vi.fn(value => ({ parsed: value })) } as never;
    const read = vi.fn(async input => input.read(scoped));
    expect(await loadChatResumeState({ repository: outer, owner, chatId: 'chat_one', instanceId: 'instance_one', adapter,
      executionRootFingerprint: null, mode: 'retry', modelHistory: { read, assertRun: vi.fn() } })).toEqual({ parsed: 'private' });
    expect(outer.getLatestAdapterStateForChat).not.toHaveBeenCalled(); expect(scoped.getLatestAdapterStateForChat).toHaveBeenCalledOnce();
  });
  it.each(['transcript', 'checkpoint'] as const)('snapshots %s scope before a gate wait', async kind => {
    const subject = { ...owner };
    const scoped = { getDetailPage: vi.fn(async () => ({ record: { chat: { lifecycle: 'active', title: 'one' } }, messages: [] })),
      getLatestAdapterStateForChat: vi.fn(async () => undefined) };
    const read = vi.fn(async operation => { subject.ownerId = 'different_owner'; return operation.read(scoped); });
    const modelHistory = { read, assertRun: vi.fn() };
    if (kind === 'transcript') await prepareChatSessionContext({ repository: scoped, owner: subject, chatId: 'chat_one',
      instanceId: 'other', throughSeq: 1, resumeState: undefined, requestHash: 'a'.repeat(64), adapter: {}, modelHistory });
    else await loadChatResumeState({ repository: scoped, owner: subject, chatId: 'chat_one', instanceId: 'one',
      adapter: { resume: true, parseState: vi.fn() } as never, executionRootFingerprint: null, mode: 'follow_up', modelHistory });
    const call = kind === 'transcript' ? scoped.getDetailPage.mock.calls[0] : scoped.getLatestAdapterStateForChat.mock.calls[0];
    expect(call![0]).toEqual(owner);
  });
});

const detail = (title: string) => ({ record: { chat: { lifecycle: 'active', title, messageCount: 0 } }, runs: [], messages: [] });
const input = { clientRequestId: 'req_one', baseRevision: 0,
  selection: { instanceId: 'codex_default', model: 'gpt-5.6-sol' }, interactionMode: 'default', permissionMode: 'default',
  parts: [{ type: 'text' as const, text: 'Summarize' },
    { type: 'resource_reference' as const, resource: { kind: 'chat' as const, id: 'chat_source', label: 'source' } }] };
function fixture(deny = false) {
  const repository = { get: vi.fn(async () => detail('outer').record), getDetailPage: vi.fn(async () => detail('outer')) };
  const scoped = { get: vi.fn(async () => detail('scoped').record), getDetailPage: vi.fn(async () => detail('scoped')) };
  const read = vi.fn(async operation => { if (deny) throw new Error('Chat context unavailable'); return operation.read(scoped); });
  const context = new ChatAgentContext({ repository: repository as never, agents: { get: vi.fn() }, enabled: () => true,
    modelHistory: { read, assertRun: vi.fn() } });
  return { context, read, repository, scoped };
}
describe('model-only reference history admission', () => {
  it('loads a referenced transcript only after inheritance and through the supplied scoped repository', async () => {
    const f = fixture(); const value = await f.context.prepare(owner, 'chat_target', input);
    expect(f.read).toHaveBeenCalledOnce(); expect(f.read.mock.calls[0]![0]).toMatchObject({ owner, chatId: 'chat_source', targetChatId: 'chat_target' });
    expect(value.context?.chats[0]?.title).toBe('scoped');
    expect(f.repository.getDetailPage.mock.calls).toEqual([[owner, 'chat_target', { limit: 40 }]]);
  });
  it('withholds a model reference when the history gate rejects it', async () => {
    const f = fixture(true);
    await expect(f.context.prepare(owner, 'chat_target', input)).rejects.toThrow('Chat context unavailable');
    expect(f.scoped.getDetailPage).not.toHaveBeenCalled();
    expect(f.repository.getDetailPage.mock.calls).toEqual([[owner, 'chat_target', { limit: 40 }]]);
  });
  it('keeps authenticated owner previews outside model-only admission and never inherits a preview', async () => {
    const f = fixture(true);
    expect((await f.context.preview(owner, 'chat_source')).title).toBe('outer');
    expect(f.read).not.toHaveBeenCalled();
  });
  it('rechecks saved reference lineage before replaying a cached run context', async () => {
    const f = fixture(true);
    await expect(f.context.revalidate(owner, 'chat_target', { version: 1, requestHash: 'a'.repeat(64), chats: [
      { chatId: 'chat_source', title: 'saved', throughSeq: 1, text: 'private', truncated: false },
    ] })).rejects.toThrow('Chat context unavailable');
    expect(f.read.mock.calls[0]![0]).toMatchObject({ owner, chatId: 'chat_source', targetChatId: 'chat_target' });
    expect(f.repository.get).not.toHaveBeenCalled(); expect(f.scoped.get).not.toHaveBeenCalled();
  });
  it('keeps reference loading bound to the original owner across the gate wait', async () => {
    const f = fixture(); const subject = { ...owner };
    f.read.mockImplementation(async operation => { subject.ownerId = 'different_owner'; return operation.read(f.scoped); });
    await f.context.prepare(subject, 'chat_target', input);
    expect(f.scoped.getDetailPage.mock.calls[0]![0]).toEqual(owner);
  });
});
