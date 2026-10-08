import { describe, expect, it, vi } from 'vitest';
import { createChatNavigationStore, ChatNavigationAuthorityRevoked } from '../../packages/ui/src/chat-navigation/store.js';
import type { CanonicalChatNavigationResponse } from '@matrix-os/contracts';
function snapshot(title = 'Saved'): CanonicalChatNavigationResponse {
  return { version: 1, truncated: false, items: [{ chat: { id: 'chat_test', title, titleVersion: 1, revision: 1, lifecycle: 'active', attention: 'none', messageCount: 0, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' }, readState: { version: 0, unread: false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 }, classification: { kind: 'ordinary' }, persistence: 'personal' }] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
describe('scope-owned navigation snapshots', () => {
  it('hides and clears cached rows on authentication revocation', async () => {
    const clear = vi.fn(async () => { });
    const store = createChatNavigationStore({ load: async () => { await Promise.resolve(); throw new ChatNavigationAuthorityRevoked(); }, persistence: { load: async () => snapshot(), save: async () => { }, clear } });
    await store.ensure();
    expect(store.getSnapshot().items).toEqual([]);
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it('does not invalidate an in-flight snapshot for a no-op update and isolates broken subscribers', async () => {
    const pending = deferred<CanonicalChatNavigationResponse>();
    const load = vi.fn(() => pending.promise);
    const store = createChatNavigationStore({ load });
    const listener = vi.fn();
    store.subscribe(() => { throw new Error('broken subscriber'); });
    store.subscribe(listener);
    const refresh = store.refresh();
    store.update(items => items);
    pending.resolve(snapshot());
    await refresh;
    expect(load).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot().items).toHaveLength(1);
  });
  it('single-flights mounts and atomically publishes a cohort', async () => {
    const request = deferred<CanonicalChatNavigationResponse>();
    const load = vi.fn(() => request.promise);
    const store = createChatNavigationStore({ load });
    const first = store.refresh();
    const second = store.ensure();
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().items).toEqual([]);
    request.resolve(snapshot());
    await Promise.all([first, second]);
    expect(store.getSnapshot().items).toHaveLength(1);
    await store.ensure();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('shows disk cache while the server is pending and retains it on failure', async () => {
    const request = deferred<CanonicalChatNavigationResponse>();
    const persistence = { load: vi.fn(async () => snapshot()), save: vi.fn(async () => { }), clear: vi.fn(async () => { }) };
    const store = createChatNavigationStore({ load: () => request.promise, persistence });
    void store.ensure();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().items[0]?.chat.title).toBe('Saved');
    expect(store.getSnapshot().fresh).toBe(false);
    request.resolve(snapshot('Fresh'));
    await store.refresh();
    expect(store.getSnapshot().items[0]?.chat.title).toBe('Fresh');
    const failed = createChatNavigationStore({ load: async () => { throw new Error('private'); }, persistence });
    await failed.ensure();
    expect(failed.getSnapshot().items[0]?.chat.title).toBe('Saved');
    expect(failed.getSnapshot().error).toBe('Chats could not be loaded. Try again.');
  });
  it('discards a stale snapshot that would resurrect a deletion and reruns once', async () => {
    const pending = deferred<CanonicalChatNavigationResponse>();
    const load = vi.fn().mockResolvedValueOnce(snapshot()).mockImplementationOnce(() => pending.promise).mockResolvedValue({ version: 1, items: [], truncated: false });
    const store = createChatNavigationStore({ load });
    await store.ensure();
    const refresh = store.refresh();
    store.update(items => items.filter(item => item.chat.id !== 'chat_test'));
    pending.resolve(snapshot());
    await refresh;
    expect(store.getSnapshot().items).toEqual([]);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('fences rename/pin/read/move changes until a newer fetch and skips unsafe persistence', async () => {
    const pending = deferred<CanonicalChatNavigationResponse>();
    const latest = snapshot('Renamed');
    latest.items[0]!.chat.titleVersion = 2;
    const load = vi.fn().mockResolvedValueOnce(snapshot()).mockImplementationOnce(() => pending.promise).mockResolvedValue(latest);
    const save = vi.fn(async () => { });
    const store = createChatNavigationStore({ load, persistence: { load: async () => null, save, clear: async () => { } } });
    await store.ensure();
    const request = store.refresh();
    store.update(items => items.map(item => ({ ...item, chat: { ...item.chat, title: 'Renamed', titleVersion: 2 } })));
    pending.resolve(snapshot());
    await request;
    expect(store.getSnapshot().items[0]?.chat.title).toBe('Renamed');
    expect(save.mock.calls.some(([value]) => value?.items[0]?.chat.title === 'Saved')).toBe(false);
  });
  it('invalidates late cache and network reads after logout', async () => {
    const pending = deferred<CanonicalChatNavigationResponse>();
    const cache = deferred<CanonicalChatNavigationResponse | null>();
    const save = vi.fn(async () => { });
    const clear = vi.fn(async () => { });
    const store = createChatNavigationStore({ load: () => pending.promise, persistence: { load: () => cache.promise, save, clear } });
    const request = store.ensure();
    store.dispose(true);
    cache.resolve(snapshot());
    pending.resolve(snapshot());
    await request;
    expect(store.getSnapshot().items).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
  });
  it('persists only personal entries and skips a truncated snapshot', async () => {
    const value = snapshot();
    value.items.push({ ...value.items[0]!, chat: { ...value.items[0]!.chat, id: 'chat_shared' }, persistence: 'membership' });
    const save = vi.fn(async () => { });
    const store = createChatNavigationStore({ load: async () => value, persistence: { load: async () => null, save, clear: async () => { } } });
    await store.ensure();
    await new Promise(r => setTimeout(r, 0));
    expect(save).toHaveBeenCalledWith({ ...value, items: [value.items[0]] });
    const truncated = createChatNavigationStore({ load: async () => ({ ...value, truncated: true }), persistence: { load: async () => null, save, clear: async () => { } } });
    save.mockClear();
    await truncated.ensure();
    await new Promise(r => setTimeout(r, 0));
    expect(save).not.toHaveBeenCalled();
  });
});
it('replaces older personal cache with a complete empty personal cohort', async () => {
  const shared = snapshot();
  shared.items[0]!.persistence = 'membership';
  const save = vi.fn(async () => {});
  const store = createChatNavigationStore({ load: async () => shared, persistence: { load: async () => snapshot(), save, clear: async () => {} } });
  await store.ensure();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledWith({ version: 1, items: [], truncated: false });
});
