import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedBrowserActionResultSchema } from '@matrix-os/contracts';
import { rig } from '../helpers/shared-browser-cdp.js';
import { createSharedBrowserBroker } from '../../packages/gateway/src/shared-browser/broker.js';

const fixture = 'http://127.0.0.1:8730/invoices';
afterEach(() => { vi.restoreAllMocks(); });

describe('Chrome related-session lifecycle', () => {
  it('completes a real driver handoff through the broker without entering unavailable or replaying work', async () => {
    const { driver, fake, signal } = await rig();
    fake.enforceChildSessions();
    const gates: boolean[] = [];
    const broker = createSharedBrowserBroker({ ownerId: 'owner', driver,
      setHumanControl: async enabled => { gates.push(enabled); } });
    const binding = { ownerId: 'owner', chatId: 'chat', runId: 'run', harness: 'codex' as const };
    broker.openRun(binding, signal);
    let result: Promise<unknown> | undefined;
    try {
      await broker.execute(binding, { action: 'navigate', url: fixture }, signal);
      fake.event('Target.attachedToTarget', { sessionId: 'worker-session', waitingForDebugger: false,
        targetInfo: { targetId: 'owner-worker', type: 'service_worker', url: fixture + '/worker.js' } });
      result = broker.execute(binding, { action: 'snapshot' }, signal).catch(error => error);
      await vi.waitFor(() => expect(broker.status().phase).toBe('human'));
      expect(gates).toEqual([false, true]);
      expect(fake.messages.some(row => row.method === 'Runtime.runIfWaitingForDebugger' && row.sessionId === 'worker-session')).toBe(false);
      await broker.control('owner', { action: 'resume' });
      await expect(result).resolves.toMatchObject({ success: true, observationId: expect.any(String) });
      expect(broker.status().phase).toBe('agent');
      expect(fake.messages.filter(row => row.method === 'Page.navigate')).toHaveLength(1);
    } finally {
      await broker.close();
      await result;
    }
  });

  it('releases the browser and stops the run when a recovered tab needs the same handoff again', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { driver, fake, signal } = await rig();
    fake.enforceChildSessions();
    const gates: boolean[] = [];
    const broker = createSharedBrowserBroker({ ownerId: 'owner', driver,
      setHumanControl: async enabled => { gates.push(enabled); } });
    const binding = { ownerId: 'owner', chatId: 'chat', runId: 'run', harness: 'pi' as const };
    const { token } = broker.openRun(binding, signal);
    const attachWorker = (sessionId: string) => fake.event('Target.attachedToTarget', {
      sessionId, waitingForDebugger: false,
      targetInfo: { targetId: 'owner-worker', type: 'service_worker', url: fixture + '/worker.js' },
    });
    let pending: Promise<unknown> | undefined;
    try {
      await broker.execute(binding, { action: 'tab_new', url: fixture }, signal);
      attachWorker('worker-first');
      const first = broker.execute(binding, { action: 'snapshot' }, signal);
      pending = first.catch(error => error);
      await vi.waitFor(() => expect(broker.status().phase).toBe('human'));
      await broker.control('owner', { action: 'resume' });
      const recovered = await first;
      expect(SharedBrowserActionResultSchema.parse(recovered)).toMatchObject({
        success: true, targetId: 'agent-tab', observationId: expect.any(String), content: 'Two invoices',
      });

      attachWorker('worker-again');
      const repeated = broker.execute(binding, { action: 'snapshot' }, signal);
      pending = repeated.catch(error => error);
      await vi.waitFor(() => expect(broker.status()).toMatchObject({ phase: 'idle', run: null }));
      expect(SharedBrowserActionResultSchema.parse(await repeated)).toMatchObject({
        success: false, targetId: 'agent-tab', content: expect.stringContaining('Browser automation stopped'),
      });
      expect(gates).toEqual([false, true, false, true]);
      expect(broker.resolveCapability(token)).toBeNull();
      await expect(broker.execute(binding, { action: 'snapshot' }, signal)).rejects.toMatchObject({ code: 'run_unavailable' });
      await expect(broker.control('owner', { action: 'resume' })).rejects.toMatchObject({ code: 'run_unavailable' });
      expect(fake.messages.filter(row => row.method === 'Page.navigate')).toHaveLength(1);
      expect(fake.messages.some(row => row.method === 'Runtime.runIfWaitingForDebugger' && row.sessionId?.startsWith('worker-'))).toBe(false);
      expect(fake.messages.filter(row => row.method === 'Target.detachFromTarget').map(row => row.params.sessionId))
        .toEqual(['worker-first', 'agent-session', 'worker-again', 'agent-session']);
      expect(warnings.mock.calls.filter(([message]) => message === '[shared-browser] Chrome handoff required')).toEqual(Array.from({ length: 2 }, () => [
        '[shared-browser] Chrome handoff required', 'unsupported_target', 'service_worker',
      ]));

      const next = { ...binding, runId: 'next' };
      broker.openRun(next, signal);
      await expect(broker.execute(next, { action: 'tab_new', url: fixture }, signal))
        .resolves.toMatchObject({ success: true, targetId: 'agent-tab-2' });
    } finally {
      await broker.close();
      await pending;
    }
  });
  it('detaches an auto-attached iframe through its parent without making owner handoff unavailable', async () => {
    const { driver, fake, signal } = await rig();
    fake.enforceChildSessions();
    await driver.execute({ action: 'navigate', url: fixture }, signal);
    fake.event('Target.attachedToTarget', { sessionId: 'iframe-session', waitingForDebugger: true,
      targetInfo: { targetId: 'iframe-target', type: 'iframe', url: fixture + '/child' } });
    await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Runtime.runIfWaitingForDebugger', sessionId: 'iframe-session' })));

    await expect(driver.detach()).resolves.toBeUndefined();
    expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Target.detachFromTarget', sessionId: 'agent-session', params: { sessionId: 'iframe-session' } }));
    expect(fake.messages.filter(row => row.method === 'Target.detachFromTarget').at(-1)).not.toHaveProperty('sessionId');
  });

  it('releases a duplicate attachment through the primary session and continues observing', async () => {
    const { driver, fake, signal } = await rig();
    fake.enforceChildSessions();
    await driver.execute({ action: 'navigate', url: fixture }, signal);
    fake.event('Target.attachedToTarget', { sessionId: 'duplicate-session', waitingForDebugger: false,
      targetInfo: { targetId: 'agent-tab', type: 'page', url: fixture } });

    await expect(driver.execute({ action: 'snapshot' }, signal)).resolves.toMatchObject({ success: true });
    expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Target.detachFromTarget', sessionId: 'agent-session', params: { sessionId: 'duplicate-session' } }));
    await driver.detach();
  });

  it('releases nested descendants before disabling their parent auto-attachment', async () => {
    const { driver, fake, signal } = await rig();
    fake.enforceChildSessions();
    await driver.execute({ action: 'navigate', url: fixture }, signal);
    fake.event('Target.attachedToTarget', { sessionId: 'iframe-session', waitingForDebugger: true,
      targetInfo: { targetId: 'iframe-target', type: 'iframe', url: fixture + '/child' } });
    await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Runtime.runIfWaitingForDebugger', sessionId: 'iframe-session' })));
    fake.event('Target.attachedToTarget', { sessionId: 'nested-session', waitingForDebugger: true,
      targetInfo: { targetId: 'nested-target', type: 'iframe', url: fixture + '/nested' } }, 'iframe-session');
    await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Runtime.runIfWaitingForDebugger', sessionId: 'nested-session' })));

    await expect(driver.detach()).resolves.toBeUndefined();
    const detached = fake.messages.filter(row => row.method === 'Target.detachFromTarget');
    expect(detached.map(row => [row.sessionId, row.params.sessionId])).toEqual([
      ['iframe-session', 'nested-session'], ['agent-session', 'iframe-session'], [undefined, 'agent-session'],
    ]);
  });

  it('gates an initially empty iframe URL before resuming and still blocks private network requests', async () => {
    const { driver, fake, signal } = await rig();
    await driver.execute({ action: 'navigate', url: fixture }, signal);
    fake.event('Target.attachedToTarget', { sessionId: 'iframe-session', waitingForDebugger: true,
      targetInfo: { targetId: 'iframe-target', type: 'iframe', url: '' } });

    await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Runtime.runIfWaitingForDebugger', sessionId: 'iframe-session' })));
    const enabled = fake.messages.findIndex(row => row.method === 'Fetch.enable' && row.sessionId === 'iframe-session');
    const resumed = fake.messages.findIndex(row => row.method === 'Runtime.runIfWaitingForDebugger' && row.sessionId === 'iframe-session');
    expect(enabled).toBeGreaterThan(-1);
    expect(resumed).toBeGreaterThan(enabled);
    fake.event('Fetch.requestPaused', { requestId: 'private-request', request: { url: 'http://169.254.169.254/latest/' } }, 'iframe-session');
    await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Fetch.failRequest', sessionId: 'iframe-session', params: { requestId: 'private-request', errorReason: 'BlockedByClient' } })));
    await expect(driver.execute({ action: 'snapshot' }, signal)).resolves.toMatchObject({ success: true });
    await driver.detach();
  });
});
