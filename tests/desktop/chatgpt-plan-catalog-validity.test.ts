import { describe, expect, it, vi } from 'vitest';
import { catalogFixture, session, settle } from './chatgpt-plan-catalog-validity-support';

describe('Qualified native catalog validity', () => {
  it('keeps its signed peer and active inference through an owned refresh timeout inside the original deadline', async () => {
    const x = catalogFixture();
    try {
      await x.start();
      await vi.advanceTimersByTimeAsync(239000);
      await x.infer();
      const connections = x.snapshots.length;
      x.mode('timeout');
      const refresh = expect(x.service.refreshModels(session)).rejects.toMatchObject({ stage: 'catalog', category: 'timeout' });
      await vi.advanceTimersByTimeAsync(10000); await refresh; await settle();
      expect(x.aborted).toBe(false);
      expect(x.disconnects).toBe(0);
      expect(x.snapshots).toHaveLength(connections);
      const status = await x.service.status(session);
      expect(status.models.map(model => model.id)).toEqual(['fixture-visible']);
      expect(status.bridgeConnected).toBe(true);
      expect(status.grant).toEqual({ revision: 1, enabled: true, background: false });
      x.release(); await settle();
      expect(x.replies).toHaveLength(1);
    } finally { await x.cleanup(); }
  });

  it('withdraws the peer and cancels inference at the original five-minute deadline despite failed retries', async () => {
    const x = catalogFixture();
    try {
      await x.start(); const deadline = Date.now() + 300000;
      await vi.advanceTimersByTimeAsync(239000); await x.infer();
      x.mode('timeout');
      const failed = expect(x.service.refreshModels(session)).rejects.toMatchObject({ category: 'timeout' });
      await vi.advanceTimersByTimeAsync(10000); await failed;
      await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
      expect(x.aborted).toBe(false);
      expect(x.disconnects).toBe(0);
      await vi.advanceTimersByTimeAsync(1); await settle();
      expect(x.aborted).toBe(true);
      expect(x.disconnects).toBe(1);
      x.release(); await settle();
      expect(x.bodies).toHaveLength(1);
      expect(x.replies.some(reply => (reply as { ok?: boolean }).ok)).toBe(false);
      const status = x.service.status(session);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await status).toMatchObject({ models: [], bridgeConnected: false, grant: { background: false } });
    } finally { await x.cleanup(); }
  });

  it('renews only on success, keeps identical authority connected and fences the older expiry timer', async () => {
    const x = catalogFixture();
    try {
      await x.start(); await vi.advanceTimersByTimeAsync(239000); await x.infer();
      await x.service.refreshModels(session);
      const connections = x.snapshots.length;
      x.mode('timeout');
      await vi.advanceTimersByTimeAsync(61000);
      expect(x.aborted).toBe(false);
      expect(x.disconnects).toBe(0);
      expect(x.snapshots).toHaveLength(connections);
      x.release(); await settle(); expect(x.replies).toHaveLength(1);
      expect(x.replies[0]).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(239000); await settle();
      expect(x.disconnects).toBe(1);
      expect(x.snapshots).toHaveLength(connections);
    } finally { await x.cleanup(); }
  });

  it('retains a fresh connected source for an explicitly classified transport reset', async () => {
    const x = catalogFixture();
    try {
      await x.start(); await x.infer(); x.mode('reset');
      await expect(x.service.refreshModels(session)).rejects.toMatchObject({ category: 'network_error' });
      expect(x.aborted).toBe(false); expect(x.disconnects).toBe(0);
      expect((await x.service.status(session)).models).toHaveLength(1);
      x.release(); await settle(); expect(x.replies[0]).toMatchObject({ ok: true });
    } finally { await x.cleanup(); }
  });

  it.each(['unknown', 'tls', 'auth', 'schema', 'fake-timeout', 'reset-unknown-cause', 'reset-nested-tls', 'typed-reset'] as const)('withdraws on %s rather than treating a coarse error category as transient', async mode => {
    const x = catalogFixture();
    try {
      await x.start(); await x.infer(); x.mode(mode);
      await expect(x.service.refreshModels(session)).rejects.toBeInstanceOf(Error);
      await settle(); expect(x.aborted).toBe(true); expect(x.disconnects).toBe(1);
      expect(x.snapshots).toHaveLength(1);
    } finally { await x.cleanup(); }
  });

  it('does not qualify a timed-out initial catalog or manufacture a peer', async () => {
    const x = catalogFixture();
    try {
      x.mode('timeout'); const status = x.service.status(session);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await status).toMatchObject({ models: [], bridgeConnected: false });
      expect(x.snapshots).toHaveLength(0); expect(x.bodies).toHaveLength(0);
    } finally { await x.cleanup(); }
  });

  it('does not resurrect a cancelled generation when its in-flight refresh later times out', async () => {
    const x = catalogFixture();
    try {
      await x.start(); await x.infer(); x.mode('timeout');
      const failed = expect(x.service.refreshModels(session)).rejects.toMatchObject({ category: 'timeout' });
      await settle(); x.service.cancelAll(); await settle();
      await vi.advanceTimersByTimeAsync(10000); await failed;
      expect(x.aborted).toBe(true); expect(x.snapshots).toHaveLength(1);
      x.mode('ok'); await x.service.status(session);
      expect(x.snapshots).toHaveLength(2);
      expect(x.reads).toBeGreaterThan(2);
    } finally { await x.cleanup(); }
  });

  it('a new grant cannot use a prior authority stamp to retain a failed refresh', async () => {
    const x = catalogFixture();
    try {
      const before = await x.start();
      await x.service.setGrant({ ...session, accountId: before.account!.id, baseRevision: 1, enabled: true, background: false });
      x.mode('reset'); await expect(x.service.refreshModels(session)).rejects.toMatchObject({ category: 'network_error' });
      await settle();
      expect(x.disconnects).toBe(2); expect(x.snapshots).toHaveLength(2);
    } finally { await x.cleanup(); }
  });

  it('a real token rotation cannot retain the old credential qualification after refresh failure', async () => {
    const x = catalogFixture(300000);
    try {
      await x.start(); await vi.advanceTimersByTimeAsync(241000);
      x.mode('reset');
      await expect(x.service.refreshModels(session)).rejects.toMatchObject({ category: 'network_error' });
      expect(x.fetchFn.mock.calls.filter(call => String(call[0]).endsWith('/oauth/token'))).toHaveLength(1);
      expect(x.disconnects).toBe(1);
      expect(x.snapshots).toHaveLength(1);
    } finally { await x.cleanup(); }
  });

  it('an older failed read cannot erase a newer successful renewal or its deadline', async () => {
    const x = catalogFixture(); let release: (() => void) | undefined;
    try {
      await x.start(); await vi.advanceTimersByTimeAsync(239000); await x.infer();
      release = x.holdOneCatalog('reset');
      const older = expect(x.service.refreshModels(session)).rejects.toMatchObject({ category: 'network_error' });
      await settle(); await vi.advanceTimersByTimeAsync(1000);
      await x.service.refreshModels(session);
      release(); release = undefined; await older;
      x.mode('timeout'); await vi.advanceTimersByTimeAsync(60000);
      expect(x.aborted).toBe(false); expect(x.disconnects).toBe(0); expect(x.snapshots).toHaveLength(1);
      x.release(); await settle(); expect(x.replies[0]).toMatchObject({ ok: true });
    } finally { release?.(); await x.cleanup(); }
  });

  it('an old runtime refresh cannot withdraw or requalify the replacement source', async () => {
    const x = catalogFixture(); let release: (() => void) | undefined;
    try {
      await x.start(); release = x.holdOneCatalog('reset');
      const older = expect(x.service.refreshModels(session)).rejects.toMatchObject({ category: 'network_error' });
      await settle(); x.authState.authGeneration++;
      const replacement = await x.service.status({ ...session, authGeneration: 2 });
      expect(replacement.bridgeConnected).toBe(true); expect(x.snapshots).toHaveLength(2);
      release(); release = undefined; await older;
      expect((await x.service.status({ ...session, authGeneration: 2 })).bridgeConnected).toBe(true);
      expect(x.snapshots).toHaveLength(2);
    } finally { release?.(); await x.cleanup(); }
  });

  it('rejects inference at the exact deadline even when the expiry timer has not run', async () => {
    const x = catalogFixture();
    try {
      await x.start();
      // Jump wall time without running callbacks: qualification must independently
      // enforce age, rather than relying solely on timely timer delivery.
      vi.setSystemTime(Date.now() + 300000);
      await x.infer(0); await settle();
      expect(x.bodies).toHaveLength(0);
      expect(x.snapshots).toHaveLength(1);
    } finally { await x.cleanup(); }
  });

  it('does not stamp a catalog read using old credentials as qualified by a later credential rotation', async () => {
    const x = catalogFixture(300000); let release: (() => void) | undefined;
    try {
      await x.start(); await vi.advanceTimersByTimeAsync(239000);
      release = x.holdOneCatalog('ok');
      const outcome = x.service.refreshModels(session).then(() => ({ status: 'fulfilled' }), (error: unknown) => ({ status: 'rejected', error }));
      await settle(); await vi.advanceTimersByTimeAsync(2000); await x.infer();
      expect(x.fetchFn.mock.calls.filter(call => String(call[0]).endsWith('/oauth/token'))).toHaveLength(1);
      release(); release = undefined;
      expect(await outcome).toMatchObject({ status: 'rejected', error: { message: 'source changed' } }); await settle();
      expect(x.aborted).toBe(true); expect(x.snapshots).toHaveLength(1);
    } finally { release?.(); await x.cleanup(); }
  });
});
