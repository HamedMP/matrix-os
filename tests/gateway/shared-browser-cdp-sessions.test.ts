import { afterEach, describe, expect, it, vi } from 'vitest';
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
