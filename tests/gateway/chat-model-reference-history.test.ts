import { describe, expect, it, vi } from 'vitest';
import { ChatAgentContext } from '../../packages/gateway/src/chat/agent-context.js';

const owner = { type: 'personal' as const, ownerId: 'owner_one' };
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
