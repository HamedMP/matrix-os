import { describe, expect, it, vi } from 'vitest';
import { createGoogleModelHistoryAdmission } from '../../packages/gateway/src/google-data/runtime/model-history-admission.js';
const owner = { type: 'personal' as const, ownerId: 'owner_one' };
const ordinary = () => ({ classification: 'ordinary' as const });
const google = () => ({ classification: 'google' as const, googleContext: { ownerId: owner.ownerId, chatId: 'source_one', revision: 1,
  availability: 'available', retentionDeadline: new Date(Date.now() + 60000).toISOString(), sources: [{ originId: 'a'.repeat(64), googleAccountId: '123e4567-e89b-42d3-a456-426614174000', consentId: 'consent_one', profileId: 'profile_one', profileRevision: 1, purposeId: 'mail-assistance', expiresAt: new Date(Date.now() + 60000).toISOString(), state: 'active' }] } });
function fixture() {
  let source: any = ordinary(); let target: any = ordinary();
  const inspect = vi.fn(async (_owner, chatId) => structuredClone(chatId === 'source_one' ? source : target));
  const inherit = vi.fn(async (_owner, targetId) => { if (source.classification === 'google') target = { ...structuredClone(source), googleContext: { ...source.googleContext, chatId: targetId } }; return structuredClone(target); });
  const adapter = {}; const otherAdapter = {};
  const admission = createGoogleModelHistoryAdmission({ store: { inspect, inherit }, isGuardedAdapter: value => value === adapter });
  return { admission, inspect, inherit, adapter, otherAdapter, source: (value: any) => { source = value; }, target: (value: any) => { target = value; } };
}
describe('model-only Google history admission', () => {
  it('permits born ordinary history and checks it again after the read', async () => {
    const f = fixture(); const read = vi.fn(async () => 'ordinary');
    expect(await f.admission.read({ owner, chatId: 'source_one', adapter: f.otherAdapter, read })).toBe('ordinary');
    expect(f.inspect).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledOnce();
  });
  it.each(['unknown', 'undefined', 'malformed', 'organization'] as const)('denies %s before reading model content', async kind => {
    const f = fixture(); if (kind !== 'organization') f.source(kind === 'unknown' ? { classification: 'unknown' } : kind === 'undefined' ? undefined : { classification: 'ordinary', googleContext: google().googleContext });
    const read = vi.fn(async () => 'private');
    await expect(f.admission.read({ owner: kind === 'organization' ? { type: 'organization', ownerId: owner.ownerId } : owner, chatId: 'source_one', adapter: f.adapter, read })).rejects.toThrow('Chat context unavailable');
    expect(read).not.toHaveBeenCalled();
  });
  it('permits current Google history only through the actual guarded adapter object', async () => {
    const f = fixture(); f.source(google()); const read = vi.fn(async () => 'private');
    await expect(f.admission.read({ owner, chatId: 'source_one', adapter: { driverKind: 'matrix_pi' }, read })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(await f.admission.read({ owner, chatId: 'source_one', adapter: f.adapter, read })).toBe('private');
  });
  it.each(['expired', 'purging', 'deleted', 'source-expired', 'wrong-owner', 'wrong-chat'] as const)('denies %s Google history before reading', async changed => {
    const f = fixture(); const value = google();
    if (['expired', 'purging', 'deleted'].includes(changed)) value.googleContext.availability = changed;
    if (changed === 'source-expired') value.googleContext.sources[0]!.expiresAt = new Date(0).toISOString();
    if (changed === 'wrong-owner') value.googleContext.ownerId = 'other'; if (changed === 'wrong-chat') value.googleContext.chatId = 'other'; f.source(value);
    const read = vi.fn(async () => 'private'); await expect(f.admission.read({ owner, chatId: 'source_one', adapter: f.adapter, read })).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it.each(['purge', 'new-source', 'expiry', 'unknown'] as const)('withholds a loaded value after %s during reading', async changed => {
    const f = fixture(); const initial = google(); f.source(initial);
    const read = vi.fn(async () => { const next = structuredClone(initial);
      if (changed === 'purge') next.googleContext.availability = 'purging'; if (changed === 'new-source') next.googleContext.revision++;
      if (changed === 'expiry') next.googleContext.retentionDeadline = new Date(0).toISOString(); f.source(changed === 'unknown' ? { classification: 'unknown' } : next); return 'private'; });
    await expect(f.admission.read({ owner, chatId: 'source_one', adapter: f.adapter, read })).rejects.toThrow('Chat context unavailable');
  });
  it('inherits Google references before reading and rechecks the target afterward', async () => {
    const f = fixture(); f.source(google()); const read = vi.fn(async () => { expect(f.inherit).toHaveBeenCalledExactlyOnceWith(owner, 'target_one', ['source_one'], undefined); return 'private'; });
    expect(await f.admission.read({ owner, chatId: 'source_one', targetChatId: 'target_one', read })).toBe('private');
    expect(f.inspect.mock.calls.map(([, id]) => id)).toContain('target_one');
  });
  it('does not let an unknown target receive a Google reference', async () => {
    const f = fixture(); f.source(google()); f.target({ classification: 'unknown' }); const read = vi.fn(async () => 'private');
    await expect(f.admission.read({ owner, chatId: 'source_one', targetChatId: 'target_one', read })).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });

  it('cancels a stalled content read without releasing its late value', async () => {
    const f = fixture(); const control = new AbortController(); let finish!: (value: string) => void; let entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const work = f.admission.read({ owner, chatId: 'source_one', adapter: f.otherAdapter, signal: control.signal,
      read: () => { entered(); return new Promise<string>(r => { finish = r; }); } });
    const rejected = expect(work).rejects.toThrow('Chat context unavailable'); await ready; control.abort(); await rejected; finish('late-private');
  });
  it.each(['missing-origin', 'longer-retention', 'wrong-target'] as const)('refuses %s inheritance before loading content', async changed => {
    const f = fixture(); const source = google(); f.source(source);
    f.inherit.mockImplementation(async () => { const context = structuredClone(source.googleContext); context.chatId = 'target_one';
      if (changed === 'missing-origin') context.sources[0]!.consentId = 'other';
      if (changed === 'longer-retention') context.retentionDeadline = new Date(Date.parse(context.retentionDeadline) + 10000).toISOString();
      if (changed === 'wrong-target') context.chatId = 'other';
      return { classification: 'google', googleContext: context };
    });
    const read = vi.fn(async () => 'private'); await expect(f.admission.read({ owner, chatId: 'source_one', targetChatId: 'target_one', read })).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it('contains dependency diagnostics without retaining their cause', async () => {
    const f = fixture(); f.inspect.mockRejectedValue(new Error('private token and path'));
    const error = await f.admission.read({ owner, chatId: 'source_one', read: async () => 'private' }).catch(e => e);
    expect(error.message).toBe('Chat context unavailable'); expect(error.cause).toBeUndefined();
  });

  it.each(['lost-target-source', 'extended-target-retention'] as const)('rejects %s in a reference inheritance result', async changed => {
    const f = fixture(); const source = google(); const existing = google();
    existing.googleContext.chatId = 'target_one'; existing.googleContext.sources[0]!.originId = 'b'.repeat(64);
    existing.googleContext.retentionDeadline = new Date(Date.now() + 30000).toISOString();
    f.source(source); f.target(existing);
    f.inherit.mockImplementation(async () => ({ classification: 'google', googleContext: {
      ...source.googleContext, chatId: 'target_one', revision: 2,
      retentionDeadline: changed === 'lost-target-source' ? existing.googleContext.retentionDeadline : source.googleContext.retentionDeadline,
      sources: changed === 'lost-target-source' ? source.googleContext.sources : [...source.googleContext.sources, ...existing.googleContext.sources],
    } }));
    const read = vi.fn(async () => 'private');
    await expect(f.admission.read({ owner, chatId: 'source_one', targetChatId: 'target_one', read })).rejects.toThrow('Chat context unavailable');
    expect(read).not.toHaveBeenCalled();
  });
  it('contains diagnostics from the final post-transaction clock check', async () => {
    let broken = false;
    const admission = createGoogleModelHistoryAdmission({ store: { inspect: async () => ordinary(), inherit: async () => ordinary() },
      isGuardedAdapter: () => false, now: () => { if (broken) throw new Error('private clock path'); return new Date(); } });
    const prepared = await admission.prepareRead({ owner, chatId: 'source_one', read: async () => 'private' });
    broken = true;
    expect(() => prepared.assertCurrent()).toThrow('Chat context unavailable');
  });

});
