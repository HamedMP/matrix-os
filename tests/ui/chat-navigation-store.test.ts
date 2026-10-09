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

it('recovers from authorization rejection in the same store without hydrating revoked cache', async () => {
  const cached = deferred<CanonicalChatNavigationResponse | null>();
  const persistence = { load: vi.fn(() => cached.promise), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
  const load = vi.fn().mockRejectedValueOnce(new ChatNavigationAuthorityRevoked()).mockResolvedValue(snapshot('Recovered'));
  const store = createChatNavigationStore({ load, persistence });
  await store.ensure();
  expect(store.getSnapshot().items).toEqual([]);
  expect(persistence.clear).toHaveBeenCalledOnce();
  cached.resolve(snapshot('Revoked'));
  await store.ensure();
  expect(load).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot().items[0]?.chat.title).toBe('Recovered');
  expect(persistence.load).toHaveBeenCalledOnce();
});
it('fences revoked reads without letting their completion detach a new single flight', async () => {
  const stale = deferred<CanonicalChatNavigationResponse>();
  const fresh = deferred<CanonicalChatNavigationResponse>();
  const cleanup = deferred<void>();
  const save = vi.fn(async () => {});
  const load = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise);
  const store = createChatNavigationStore({ load, persistence: { load: async () => null, save, clear: () => cleanup.promise } });
  const oldRequest = store.ensure();
  store.revoke();
  store.update(() => snapshot('Unsafe optimistic').items);
  expect(store.getSnapshot().items).toEqual([]);
  const newRequest = store.ensure();
  stale.resolve(snapshot('Stale'));
  await oldRequest;
  expect(store.getSnapshot().items).toEqual([]);
  expect(store.ensure()).toBe(newRequest);
  expect(load).toHaveBeenCalledTimes(2);
  fresh.resolve(snapshot('Recovered'));
  await newRequest;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(save).not.toHaveBeenCalled();
  cleanup.resolve();
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith(snapshot('Recovered')));
  expect(store.getSnapshot().items[0]?.chat.title).toBe('Recovered');
  store.dispose(true);
  await store.ensure();
  expect(load).toHaveBeenCalledTimes(2);
});

it('ignores unknown live patches during cold loading without restarting the request', async () => {
  const pending = deferred<CanonicalChatNavigationResponse>();
  const load = vi.fn(() => pending.promise);
  const store = createChatNavigationStore({ load });
  const request = store.ensure();
  store.patch(snapshot('Unknown live Chat').items[0]!);
  expect(store.getSnapshot().items).toEqual([]);
  pending.resolve(snapshot());
  await request;
  expect(load).toHaveBeenCalledOnce();
  expect(store.getSnapshot().items[0]?.chat.title).toBe('Saved');
});
it('keeps live known metadata through stale reads without restarting or persisting partial state', async () => {
  const pending = deferred<CanonicalChatNavigationResponse>();
  const live = snapshot('Live');
  live.items[0]!.chat = { ...live.items[0]!.chat, revision: 2, titleVersion: 2, messageCount: 3,
    activityAt: '2026-10-08T01:00:00Z', updatedAt: '2026-10-08T01:00:00Z' };
  live.items[0]!.readState = { ...live.items[0]!.readState, version: 2, latestIncomingSeq: 3, unread: true };
  const load = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(pending.promise).mockResolvedValue(live);
  const save = vi.fn(async () => {});
  const store = createChatNavigationStore({ load, persistence: { load: async () => null, save, clear: async () => {} } });
  await store.ensure();
  const request = store.refresh();
  store.patch(live.items[0]!);
  expect(store.getSnapshot().items[0]).toMatchObject(live.items[0]!);
  expect(store.ensure()).toBe(request);
  pending.resolve(snapshot());
  await request;
  expect(load).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot().items[0]).toMatchObject(live.items[0]!);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(save).not.toHaveBeenCalled();
  await store.refresh();
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith(live));
});
it('takes membership and classification from the server and never resurrects removed patched rows', async () => {
  const load = vi.fn(async () => snapshot());
  const store = createChatNavigationStore({ load });
  await store.ensure();
  const live = snapshot('Live').items[0]!;
  live.chat = { ...live.chat, revision: 3, titleVersion: 3 };
  store.patch(live);
  const changed = snapshot();
  changed.items[0]!.classification = { kind: 'bot', agentId: 'bot_known001' };
  changed.items[0]!.persistence = 'membership';
  load.mockResolvedValue(changed);
  await store.refresh();
  expect(store.getSnapshot().items[0]).toMatchObject({ chat: { title: 'Live' }, classification: changed.items[0]!.classification, persistence: 'membership' });
  load.mockResolvedValue({ ...changed, items: [] });
  await store.refresh();
  store.patch(live);
  expect(store.getSnapshot().items).toEqual([]);
  load.mockResolvedValue(snapshot('Recreated'));
  await store.refresh();
  expect(store.getSnapshot().items[0]?.chat.title).toBe('Recreated');
});
it('exposes authority epochs and ignores revoked or disposed live patches', async () => {
  const store = createChatNavigationStore({ load: async () => snapshot() });
  await store.ensure();
  const epoch = store.getAuthorityEpoch();
  store.revoke();
  expect(store.getAuthorityEpoch()).toBe(epoch + 1);
  store.patch(snapshot('Late revoked').items[0]!);
  expect(store.getSnapshot().items).toEqual([]);
  await store.ensure();
  store.dispose();
  expect(store.getAuthorityEpoch()).toBe(epoch + 2);
  store.patch(snapshot('Late disposed').items[0]!);
  expect(store.getSnapshot().items).toEqual([]);
});

it.each(['server', 'mutation'])('lets equal-revision %s pin/completion results supersede stream overlays and resume persistence', async boundary => {
  const initial = snapshot();
  initial.items[0]!.chat.userState = { pinned: false, muted: false, readThroughSeq: 0 };
  initial.items[0]!.latestSuccessfulCompletion = { runId: 'run_complete', completedAt: '2026-10-08T00:00:00Z', unacknowledged: true };
  const load = vi.fn(async () => initial);
  const save = vi.fn(async () => {});
  const store = createChatNavigationStore({ load, persistence: { load: async () => null, save, clear: async () => {} } });
  await store.ensure();
  const live = structuredClone(initial.items[0]!);
  live.chat = { ...live.chat, revision: 2, messageCount: 5, updatedAt: '2026-10-08T01:00:00Z' };
  store.patch(live);
  const fresh = structuredClone(live);
  fresh.chat.userState = { pinned: true, muted: true, readThroughSeq: 5 };
  fresh.latestSuccessfulCompletion!.unacknowledged = false;
  fresh.chat.lifecycle = 'archived';
  fresh.projectId = 'new-project';
  fresh.readState = { ...fresh.readState, version: 1, readThroughSeq: 5, latestIncomingSeq: 5, unread: false };
  const result = { ...initial, items: [fresh] };
  if (boundary === 'mutation') store.update(() => [fresh]);
  load.mockResolvedValue(result);
  await store.refresh();
  expect(store.getSnapshot().items[0]).toEqual(fresh);
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith(result));
});
it('stream patches never downgrade independent clocks or overwrite unversioned server fields', async () => {
  const initial = snapshot('Renamed');
  const current = initial.items[0]!;
  current.chat = { ...current.chat, revision: 3, titleVersion: 4, messageCount: 8, updatedAt: '2026-10-08T02:00:00Z',
    activityAt: '2026-10-08T02:00:00Z', userState: { pinned: true, muted: true, readThroughSeq: 7 } };
  current.readState = { ...current.readState, version: 3, readThroughSeq: 7, latestIncomingSeq: 8, unread: true };
  const store = createChatNavigationStore({ load: async () => initial });
  await store.ensure();
  const old = snapshot('Old').items[0]!;
  old.chat.revision = 5; // A larger Chat revision does not order pin/title/read clocks.
  old.readState = { ...old.readState, version: 3, readThroughSeq: 0, latestIncomingSeq: 9, unread: true };
  store.patch(old);
  expect(store.getSnapshot().items[0]).toMatchObject({ chat: { revision: 5, title: 'Renamed', messageCount: 8,
    updatedAt: current.chat.updatedAt, activityAt: current.chat.activityAt, userState: current.chat.userState },
    readState: { version: 3, readThroughSeq: 7, latestIncomingSeq: 9, unread: true } });
});
