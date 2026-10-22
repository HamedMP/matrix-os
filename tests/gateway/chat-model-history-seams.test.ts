import { describe, expect, it, vi } from 'vitest';
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
