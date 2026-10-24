import { describe, expect, it, vi } from 'vitest';
import { fixture, request, session } from './chatgpt-plan-roundtrip-support';

describe('Native v2 peer authority across catalog renewal', () => {
  it.each(['explicit', 'periodic'] as const)('keeps an active inference through an identical %s catalog refresh', async kind => {
    if (kind === 'periodic') vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const x = await fixture();
    let release: (() => void) | undefined;
    let date: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await x.signedIn();
      const before = await x.service.status(session);
      release = x.holdResponse();
      x.queue([request('00000000-0000-4000-8000-000000000009', before.account!.id, before.grant.revision)]);
      await vi.waitFor(() => expect(x.providerBodies).toHaveLength(1));
      const polls = x.polls, connections = x.snapshots.length;
      const reads = x.fetchFn.mock.calls.filter(call => String(call[0]).endsWith('/v1/models')).length;
      if (kind === 'explicit') await x.service.refreshModels(session);
      else {
        date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 4 * 60000 + 1000);
        vi.advanceTimersByTime(10000);
        await vi.waitFor(() => expect(x.fetchFn.mock.calls.filter(call => String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(reads));
      }
      // At least two completed poll cycles expose a stale captured array guard.
      await vi.waitFor(() => expect(x.polls).toBeGreaterThan(polls + 2));
      expect(x.snapshots).toHaveLength(connections);
      expect(x.responseAborted).toBe(false);
      expect((await x.service.status(session)).bridgeConnected).toBe(true);
      release(); release = undefined;
      await vi.waitFor(() => expect(x.replies).toHaveLength(1));
      expect(x.replies[0]?.ok).toBe(true);
      expect(x.providerBodies).toHaveLength(1);
    } finally { date?.mockRestore(); release?.(); await x.cleanup(); vi.useRealTimers(); }
  });

  it('still aborts active inference when catalog authority actually changes', async () => {
    const x = await fixture(); let release: (() => void) | undefined;
    try {
      await x.signedIn(); const before = await x.service.status(session);
      release = x.holdResponse();
      x.queue([request('00000000-0000-4000-8000-000000000009', before.account!.id, before.grant.revision)]);
      await vi.waitFor(() => expect(x.providerBodies).toHaveLength(1));
      x.changeModel('fixture-new'); await x.service.refreshModels(session);
      await vi.waitFor(() => expect(x.responseAborted).toBe(true));
      expect(x.providerBodies).toHaveLength(1);
      expect((await x.service.status(session)).models[0]?.id).toBe('fixture-new');
    } finally { release?.(); await x.cleanup(); }
  });
});
