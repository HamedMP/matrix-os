import { describe, expect, it, vi } from 'vitest';
import { SHARED_BROWSER_MAX_OWNED_TABS } from '@matrix-os/contracts';
import { rig } from '../helpers/shared-browser-cdp.js';

const contextId = 'public-context';
const publicUrl = 'https://browser-fixture.test/';
const worker = (browserContextId?: string, waitingForDebugger = true) => ({
  sessionId: 'worker-session', waitingForDebugger,
  targetInfo: { targetId: 'worker-target', type: 'service_worker', url: publicUrl + 'sw.js', browserContextId },
});
async function publicRig(createdId = contextId) {
  const create = vi.fn(async () => createdId);
  const result = await rig(undefined, { publicContext: { create },
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }] });
  result.fake.setBrowserContexts(contextId);
  result.fake.setTargetContext(contextId);
  return { ...result, create };
}

describe('isolated public Chrome context', () => {
  it('opens ten result tabs plus bounded scratch tabs and retains their context across reconnect', async () => {
    const {driver, fake, signal, create} = await publicRig();
    try {
      for (let index = 0; index < SHARED_BROWSER_MAX_OWNED_TABS; index++) {
        await expect(driver.execute({ action: 'tab_new', url: publicUrl }, signal)).resolves.toMatchObject({ success: true });
      }
      await expect(driver.execute({ action: 'tab_new', url: publicUrl }, signal)).rejects.toMatchObject({ code: 'tab_limit' });
      await driver.detach();
      await expect(driver.execute({ action: 'tab_switch', targetId: 'agent-tab' }, signal)).resolves.toMatchObject({ success: true });
      expect(create).toHaveBeenCalledTimes(1);
      const created = fake.messages.filter(row => row.method === 'Target.createTarget');
      expect(created).toHaveLength(SHARED_BROWSER_MAX_OWNED_TABS);
      expect(created.length).toBeGreaterThanOrEqual(10);
      expect(created.every(row => row.params.browserContextId === contextId)).toBe(true);
    } finally { await driver.detach(); }
  });

  it.each(['unregistered-context', '', 'invalid context'])('fails before opening tabs when the returned context is %j', async createdId => {
    const {driver, fake, signal} = await publicRig(createdId);
    try {
      await expect(driver.execute({ action: 'tab_new', url: publicUrl }, signal)).rejects.toMatchObject({ code: 'browser_unavailable' });
      expect(fake.messages.some(row => row.method === 'Target.createTarget')).toBe(false);
    } finally { await driver.detach(); }
  });

  it.each([undefined, 'owner-context'])('does not attach or navigate a new target with context %j', async targetContext => {
    const {driver, fake, signal} = await publicRig();
    try {
      fake.setTargetContext(targetContext);
      await expect(driver.execute({ action: 'tab_new', url: publicUrl }, signal)).rejects.toMatchObject({ code: 'browser_unavailable' });
      expect(fake.messages.some(row => row.method === 'Target.attachToTarget' || row.method === 'Page.navigate')).toBe(false);
    } finally { await driver.detach(); }
  });

  it('fails before dispatch when the retained context disappears', async () => {
    const {driver, fake, signal, create} = await publicRig();
    try {
      await driver.execute({ action: 'tab_new', url: publicUrl }, signal);
      fake.setBrowserContexts();
      await expect(driver.execute({ action: 'navigate', url: publicUrl }, signal)).rejects.toMatchObject({ code: 'browser_unavailable' });
      expect(create).toHaveBeenCalledTimes(1);
      expect(fake.messages.filter(row => row.method === 'Page.navigate')).toHaveLength(1);
    } finally { await driver.detach(); }
  });

  it.each([
    ['navigate', 'http://browser-fixture.test/'],
    ['tab_new', 'http://127.0.0.1:8730/invoices'],
  ] as const)('rejects cleartext %s before opening a tab', async (action, url) => {
    const {driver, fake, signal} = await publicRig();
    try {
      await expect(driver.execute({ action, url }, signal)).rejects.toMatchObject({ code: 'invalid_action' });
      expect(fake.messages.some(row => row.method === 'Target.createTarget' || row.method === 'Page.navigate')).toBe(false);
    } finally { await driver.detach(); }
  });

  it('rejects cleartext at the existing page Fetch gate as well', async () => {
    const {driver, fake, signal} = await publicRig();
    try {
      await driver.execute({ action: 'tab_new', url: publicUrl }, signal);
      fake.event('Fetch.requestPaused', { requestId: 'cleartext', request: { url: 'http://127.0.0.1:8730/invoices' } });
      await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({
        method: 'Fetch.failRequest', params: { requestId: 'cleartext', errorReason: 'BlockedByClient' },
      })));
    } finally { await driver.detach(); }
  });

  it('releases a paused Service Worker only inside the verified public context and keeps the iframe gate', async () => {
    const {driver, fake, signal} = await publicRig();
    try {
      fake.enforceChildSessions();
      await driver.execute({ action: 'tab_new', url: publicUrl }, signal);
      fake.event('Target.attachedToTarget', worker(contextId));
      fake.event('Target.attachedToTarget', { sessionId: 'iframe-session', waitingForDebugger: true,
        targetInfo: { targetId: 'iframe-target', type: 'iframe', url: '', browserContextId: contextId } });
      await expect(driver.execute({ action: 'snapshot' }, signal)).resolves.toMatchObject({ success: true });
      expect(fake.messages.some(row => row.method === 'Runtime.runIfWaitingForDebugger' && row.sessionId === 'worker-session')).toBe(true);
      const gate = fake.messages.findIndex(row => row.method === 'Fetch.enable' && row.sessionId === 'iframe-session');
      const resume = fake.messages.findIndex(row => row.method === 'Runtime.runIfWaitingForDebugger' && row.sessionId === 'iframe-session');
      expect(gate).toBeGreaterThan(-1);
      expect(resume).toBeGreaterThan(gate);
    } finally { await driver.detach(); }
    expect(fake.messages.filter(row => row.method === 'Runtime.runIfWaitingForDebugger' && row.sessionId === 'worker-session')).toHaveLength(1);
  });

  it.each([undefined, 'owner-context'])('never inspects or resumes a related worker with context %j', async reportedContext => {
    const {driver, fake, signal} = await publicRig();
    try {
      await driver.execute({ action: 'tab_new', url: publicUrl }, signal);
      fake.event('Target.attachedToTarget', worker(reportedContext));
      await expect(driver.execute({ action: 'snapshot' }, signal)).resolves.toMatchObject({ success: false, handoffRequested: true });
    } finally { await driver.detach(); }
    expect(fake.messages.some(row => row.sessionId === 'worker-session'
      || (row.method === 'Target.getTargetInfo' && row.params.targetId === 'worker-target'))).toBe(false);
  });

  it('does not dispatch navigation when a foreign related target appears during attachment', async () => {
    const {driver, fake, signal} = await publicRig();
    try {
      fake.emitRelatedOnAutoAttach(worker('owner-context'));
      await expect(driver.execute({ action: 'tab_new', url: publicUrl }, signal)).resolves.toMatchObject({
        success: false, handoffRequested: true,
      });
      expect(fake.messages.some(row => row.method === 'Page.navigate' || row.method === 'Target.activateTarget')).toBe(false);
    } finally { await driver.detach(); }
  });

  it('does not resume an already-running worker in the public context', async () => {
    const {driver, fake, signal} = await publicRig();
    try {
      await driver.execute({ action: 'tab_new', url: publicUrl }, signal);
      fake.event('Target.attachedToTarget', worker(contextId, false));
      await expect(driver.execute({ action: 'snapshot' }, signal)).resolves.toMatchObject({ success: true });
    } finally { await driver.detach(); }
    expect(fake.messages.some(row => row.sessionId === 'worker-session')).toBe(false);
  });

  it('ignores unrelated download events and never changes browser-default download behavior', async () => {
    const {driver, fake, signal} = await publicRig();
    try {
      await driver.execute({ action: 'tab_new', url: publicUrl }, signal);
      fake.raw({ method: 'Browser.downloadWillBegin', params: { guid: 'owner-download' } });
      await expect(driver.execute({ action: 'snapshot' }, signal)).resolves.toMatchObject({ success: true });
    } finally { await driver.detach(); }
    const behavior = fake.messages.filter(row => row.method === 'Browser.setDownloadBehavior');
    expect(behavior).toContainEqual(expect.objectContaining({ params: {
      behavior: 'deny', browserContextId: contextId, eventsEnabled: false,
    } }));
    expect(behavior.every(row => row.params.browserContextId === contextId)).toBe(true);
    expect(fake.messages.some(row => row.method === 'Browser.cancelDownload')).toBe(false);
  });
});
