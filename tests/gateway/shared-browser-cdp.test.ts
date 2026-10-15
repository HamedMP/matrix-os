import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSharedBrowserCdpDriver } from '../../packages/gateway/src/shared-browser/cdp-driver.js';
import { connectBrowserCdp } from '../../packages/gateway/src/shared-browser/cdp-client.js';
import { validateBrowserUrl } from '../../packages/gateway/src/shared-browser/url-policy.js';

const fixture = 'http://127.0.0.1:8730/invoices';
const homes: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
function chrome() {
  let url = 'about:blank', handoff = false, snapshotId = '', skip = '', created = 0, downloadPath = '', downloads = false, navigationError = false, missingCursor = false, globalPrimaryAttachEvent = false;
  const missing = new Set<string>();
  let lookupError: { code: number; message: string } | undefined;
  const original = Buffer.from('%PDF-1.4\noriginal CDP invoice fixture\n%%EOF');
  const messages: any[] = [];
  class Socket extends EventEmitter {
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send(data: string) {
      const packet = JSON.parse(data); messages.push(packet);
      if (packet.method === skip) return;
      if (['Target.getTargetInfo', 'Target.attachToTarget'].includes(packet.method) && (missing.has(packet.params.targetId) || lookupError)) {
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id: packet.id, error: lookupError ?? { code: -32602, message: 'No target with given id found' } }))));
        return;
      }
      if (missingCursor && packet.method === 'Runtime.callFunctionOn' && packet.params.functionDeclaration.startsWith('function MATRIX_CLEAR_CURSOR')) {
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id: packet.id, error: { code: -32000, message: 'Could not find object with given id' } }))));
        return;
      }
      if (packet.method === 'Browser.setDownloadBehavior') downloadPath = packet.params.downloadPath ?? '';
      let result: any = {};
      if (packet.method === 'Target.createTarget') result = { targetId: ++created === 1 ? 'agent-tab' : `agent-tab-${created}` };
      if (packet.method === 'Target.attachToTarget') result = { sessionId: 'agent-session' };
      if (packet.method === 'Target.getTargetInfo') result = { targetInfo: { targetId: packet.params.targetId, type: 'page', url, title: 'Invoices' } };
      if (packet.method === 'Page.navigate') { url = packet.params.url; result = navigationError ? { errorText: 'net::ERR_CONNECTION_REFUSED' } : { frameId: 'agent-frame' }; }
      if (packet.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'agent-frame', url } } };
      if (packet.method === 'Page.createIsolatedWorld') result = { executionContextId: 9 };
      if (packet.method === 'Runtime.evaluate') result = packet.params.expression.includes('MATRIX_CLEAR_CURSOR') ? {result:{value:{ok:true}}} : { result: { objectId: 'document-handle' } };
      if (packet.method === 'Runtime.callFunctionOn') {
        const args = packet.params.arguments.map((entry: any) => entry.value);
        if (packet.params.functionDeclaration.includes('MATRIX_SNAPSHOT')) {
          snapshotId = args[0]; result = { result: { value: handoff ? { handoff: true } : { content: 'Two invoices', title: 'Invoices', elements: [{ ref: 'r1', role: 'link', name: 'Original invoice' }] } } };
        } else result = { result: { value: { ok: true, href: fixture + '/original.pdf', observation: snapshotId } } };
      }
      const shouldDownload = downloads && downloadPath && packet.method === 'Runtime.callFunctionOn' && packet.params.arguments[2]?.value === 'click';
      queueMicrotask(async () => {
        if (globalPrimaryAttachEvent && packet.method === 'Target.attachToTarget') {
          this.emit('message', Buffer.from(JSON.stringify({ method: 'Target.attachedToTarget', params: {
            sessionId: result.sessionId, waitingForDebugger: false,
            targetInfo: { targetId: packet.params.targetId, type: 'page', url },
          } })));
        }
        if (packet.method === 'Target.detachFromTarget') this.emit('message', Buffer.from(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: packet.params.sessionId } })));
        if (shouldDownload) {
          await writeFile(join(downloadPath, 'cdp-invoice-guid'), original);
          this.emit('message', Buffer.from(JSON.stringify({ method: 'Browser.downloadWillBegin', params: { frameId: 'agent-frame', guid: 'cdp-invoice-guid', url: fixture + '/original.pdf' } })));
          this.emit('message', Buffer.from(JSON.stringify({ method: 'Browser.downloadProgress', params: { guid: 'cdp-invoice-guid', receivedBytes: original.length, totalBytes: original.length, state: 'completed' } })));
        }
        this.emit('message', Buffer.from(JSON.stringify({ id: packet.id, result })));
      });
    }
    close() { this.readyState = 3; this.emit('close'); }
  }
  let socket: Socket;
  const fetcher = vi.fn(async () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test-123' }));
  return { messages, fetcher, socketFactory: () => (socket = new Socket()), raw: (value: unknown) => socket.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))), event: (method: string, params = {}, sessionId = 'agent-session') => socket.emit('message', Buffer.from(JSON.stringify({ method, params, sessionId }))),
    emitPrimaryAttachBeforeAck() { globalPrimaryAttachEvent = true; },
    setUrl(value: string) { url = value; }, setHandoff(value: boolean) { handoff = value; }, skip(value: string) { skip = value; }, enableDownloads() { downloads = true; return original; },
    closeTarget(id: string) { missing.add(id); }, failLookup(error?: { code: number; message: string }) { lookupError = error; }, failNavigation() { navigationError = true; }, failCursor() { missingCursor = true; }, disconnect() { socket.close(); } };
}
async function rig(commandTimeoutMs?:number) {
  const homePath = await mkdtemp(join(tmpdir(), 'shared-cdp-')); homes.push(homePath);
  const fake = chrome(); const driver = createSharedBrowserCdpDriver({ homePath, ...fake, commandTimeoutMs });
  return { driver, fake, homePath, signal: new AbortController().signal };
}
describe('shared owner Chrome CDP driver', () => {
  it('rejects depth, node and string budget violations before notifying CDP listeners', async () => {
    let deep: unknown = 'leaf';
    for (let depth = 0; depth < 20; depth++) deep = { nested: deep };
    const invalidPayloads = [
      { value: deep },
      { values: Array.from({ length: 4100 }, () => null) },
      { value: 'x'.repeat(64 * 1024 + 1) },
    ];
    for (const params of invalidPayloads) {
      const fake = chrome();
      const client = await connectBrowserCdp(fake);
      const listener = vi.fn();
      client.onEvent(listener);

      fake.raw({ method: 'Fetch.requestPaused', params });

      expect(listener).not.toHaveBeenCalled();
      expect(client.available).toBe(false);
    }
  });

  it('validates CDP reply and event envelopes while preserving bounded nested payloads', async () => {
    const fake = chrome();
    const client = await connectBrowserCdp(fake);
    const listener = vi.fn();
    client.onEvent(listener);
    fake.raw({ method: 'Page.frameNavigated', params: { frame: { id: 'agent-frame', url: fixture } }, sessionId: 'agent-session' });
    expect(listener).toHaveBeenCalledWith({ method: 'Page.frameNavigated', params: { frame: { id: 'agent-frame', url: fixture } }, sessionId: 'agent-session' });

    const pending = client.request('Target.getTargets');
    const sent = fake.messages.at(-1);
    fake.raw({ id: sent.id, result: [] });
    await expect(pending).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(client.available).toBe(false);
  });

  it('ignores unused bounded-size CDP event payloads without interrupting a pending reply', async () => {
    const fake = chrome();
    const client = await connectBrowserCdp(fake);
    const listener = vi.fn();
    client.onEvent(listener);
    const pending = client.request('Target.getTargets');

    fake.raw({ method: 'Runtime.consoleAPICalled', params: { args: [{ type: 'string', value: 'x'.repeat(64 * 1024 + 1) }] } });

    await expect(pending).resolves.toEqual({});
    expect(listener).not.toHaveBeenCalled();
    expect(client.available).toBe(true);
    await client.close();
  });

  it('ignores the global primary attach event before acknowledgement and still releases a later scoped duplicate', async () => {
    const { driver, fake, signal } = await rig();
    fake.emitPrimaryAttachBeforeAck();
    await expect(driver.execute({ action: 'tab_new' }, signal)).resolves.toMatchObject({ success: true, targetId: 'agent-tab' });
    expect(fake.messages.filter(row => row.method === 'Target.detachFromTarget')).toHaveLength(0);
    const firstSnapshot = await driver.execute({ action: 'snapshot' }, signal);
    expect(firstSnapshot).toMatchObject({ success: true, targetId: 'agent-tab' });
    const start = fake.messages.length;
    fake.event('Target.attachedToTarget', { sessionId: 'duplicate-session', waitingForDebugger: false,
      targetInfo: { targetId: 'agent-tab', type: 'page', url: 'about:blank' } });
    await expect(driver.execute({ action: 'snapshot' }, signal)).resolves.toMatchObject({ success: true, targetId: 'agent-tab' });
    expect(fake.messages.slice(start).filter(row => row.method === 'Target.detachFromTarget'))
      .toEqual([expect.objectContaining({ params: { sessionId: 'duplicate-session' } })]);
    expect(fake.messages.slice(start).filter(row => row.method === 'Page.getFrameTree'))
      .toEqual([expect.objectContaining({ sessionId: 'agent-session' })]);
    expect(fake.messages.some(row => row.sessionId === 'duplicate-session')).toBe(false);
    await driver.detach();
  });

  it('detaches a duplicate auto-attachment to its owned current page and keeps the primary session usable', async () => {
    const { driver, fake, signal } = await rig();
    await driver.execute({ action: 'tab_new' }, signal);
    const start = fake.messages.length;
    fake.event('Target.attachedToTarget', { sessionId: 'duplicate-session', waitingForDebugger: false,
      targetInfo: { targetId: 'agent-tab', type: 'page', url: 'about:blank' } });

    const snapshot = await driver.execute({ action: 'snapshot' }, signal);
    expect(snapshot).toMatchObject({ success: true, targetId: 'agent-tab' });
    expect(fake.messages.slice(start).filter(row => row.method === 'Target.detachFromTarget'))
      .toEqual([expect.objectContaining({ params: { sessionId: 'duplicate-session' } })]);
    expect(fake.messages.slice(start).filter(row => row.method === 'Page.getFrameTree'))
      .toEqual([expect.objectContaining({ sessionId: 'agent-session' })]);
    expect(fake.messages.some(row => row.sessionId === 'duplicate-session')).toBe(false);
    await expect(driver.execute({ action: 'click', observationId: snapshot.observationId!, ref: 'r1' }, signal))
      .resolves.toMatchObject({ success: true, targetId: 'agent-tab' });
    await driver.detach();
    expect(fake.messages.some(row => row.method === 'Fetch.disable' && row.sessionId === 'duplicate-session')).toBe(false);
    expect(fake.messages.filter(row => row.method === 'Target.createTarget')).toHaveLength(1);
  });

  it('drains duplicate detach failure before observing and fails closed without detaching the primary session', async () => {
    const { driver, fake, signal } = await rig();
    await driver.execute({ action: 'tab_new' }, signal);
    fake.skip('Target.detachFromTarget');
    const start = fake.messages.length;
    fake.event('Target.attachedToTarget', { sessionId: 'duplicate-session', waitingForDebugger: false,
      targetInfo: { targetId: 'agent-tab', type: 'page', url: 'about:blank' } });
    const observing = driver.execute({ action: 'snapshot' }, signal);
    await vi.waitFor(() => expect(fake.messages.at(-1)).toMatchObject({ method: 'Target.detachFromTarget', params: { sessionId: 'duplicate-session' } }));
    fake.raw({ id: fake.messages.at(-1).id, error: { code: -32000, message: 'Detach unavailable' } });

    expect(await observing).toMatchObject({ success: false, handoffRequested: true });
    expect(fake.messages.slice(start).some(row => row.method === 'Page.getFrameTree')).toBe(false);
    expect(fake.messages.slice(start).some(row => row.method === 'Target.detachFromTarget' && row.params.sessionId === 'agent-session')).toBe(false);
    await expect(driver.execute({ action: 'tab_new' }, signal)).rejects.toMatchObject({ code: 'browser_changed' });
    fake.skip(''); await driver.detach();
  });

  it('drains a pending duplicate detach before releasing the primary session to the owner', async () => {
    const { driver, fake, signal } = await rig();
    await driver.execute({ action: 'tab_new' }, signal);
    fake.skip('Target.detachFromTarget');
    const start = fake.messages.length;
    fake.event('Target.attachedToTarget', { sessionId: 'duplicate-session', waitingForDebugger: false,
      targetInfo: { targetId: 'agent-tab', type: 'page', url: 'about:blank' } });
    const duplicate = fake.messages.at(-1);
    const releasing = driver.detach();
    await Promise.resolve(); await Promise.resolve();
    expect(fake.messages.slice(start).some(row => row.method === 'Fetch.disable')).toBe(false);
    fake.skip(''); fake.raw({ id: duplicate.id, result: {} });

    await releasing;
    expect(fake.messages.slice(start).filter(row => row.method === 'Target.detachFromTarget').map(row => row.params.sessionId))
      .toEqual(['duplicate-session', 'agent-session']);
    expect(fake.messages.some(row => row.sessionId === 'duplicate-session')).toBe(false);
  });

  it('bounds an unacknowledged duplicate detach and hands off instead of observing', async () => {
    const { driver, fake, signal } = await rig(20);
    await driver.execute({ action: 'tab_new' }, signal);
    fake.skip('Target.detachFromTarget');
    const start = fake.messages.length;
    fake.event('Target.attachedToTarget', { sessionId: 'duplicate-session', waitingForDebugger: false,
      targetInfo: { targetId: 'agent-tab', type: 'page', url: 'about:blank' } });
    expect(await driver.execute({ action: 'snapshot' }, signal)).toMatchObject({ success: false, handoffRequested: true });
    expect(fake.messages.slice(start).some(row => row.method === 'Page.getFrameTree')).toBe(false);
    fake.skip(''); await driver.detach();
  });

  it.each([
    ['unowned-page', 'page', 'different-session'],
    ['agent-tab', 'iframe', 'different-session'],
    ['agent-tab', 'page', 'agent-session'],
  ])('keeps nonwaiting %s/%s attachments outside the duplicate exception', async (targetId, type, sessionId) => {
    const { driver, fake, signal } = await rig();
    await driver.execute({ action: 'tab_new' }, signal);
    const start = fake.messages.length;
    fake.event('Target.attachedToTarget', { sessionId, waitingForDebugger: false,
      targetInfo: { targetId, type, url: 'about:blank' } });
    expect(await driver.execute({ action: 'snapshot' }, signal)).toMatchObject({ success: false, handoffRequested: true });
    expect(fake.messages.slice(start).some(row => row.method === 'Target.detachFromTarget')).toBe(false);
    await driver.detach();
  });

  it('retains cursor cleanup authority across direct transport disconnect',async()=>{
    const {driver,fake,signal}=await rig();const observed=await driver.execute({action:'snapshot'},signal);
    await driver.execute({action:'click',observationId:observed.observationId!,ref:'r1'},signal);
    fake.disconnect();await driver.detach();
    expect(fake.messages.some(row=>row.method==='Runtime.evaluate' && row.params.expression.includes('MATRIX_CLEAR_CURSOR'))).toBe(true);
  });
  it.each([['Page.frameNavigated',{frame:{id:'other-frame'}}],['Runtime.executionContextDestroyed',{executionContextId:99}]])('preserves main cursor cleanup on unrelated %s',async(method,params)=>{
    const {driver,fake,signal}=await rig();const observed=await driver.execute({action:'snapshot'},signal);
    await driver.execute({action:'click',observationId:observed.observationId!,ref:'r1'},signal);
    fake.event(method,params);await driver.detach();
    expect(fake.messages.some(row=>row.method==='Runtime.callFunctionOn' && row.params.functionDeclaration.startsWith('function MATRIX_CLEAR_CURSOR'))).toBe(true);
  });
  it('does not replay an acknowledged click when cursor cleanup times out',async()=>{
    const {driver,fake,signal}=await rig(20);const observed=await driver.execute({action:'snapshot'},signal);
    expect(await driver.execute({action:'click',observationId:observed.observationId!,ref:'r1'},signal)).toMatchObject({success:true});
    fake.skip('Runtime.callFunctionOn');driver.invalidateObservation();
    await driver.detach();
    expect(fake.messages.some(row=>row.method==='Runtime.evaluate' && row.params.expression.includes('MATRIX_CLEAR_CURSOR'))).toBe(true);
    expect(fake.messages.filter(row=>row.method==='Runtime.callFunctionOn' && row.params.arguments?.[2]?.value==='click')).toHaveLength(1);
    fake.skip('');await driver.detach();
  });
  it('releases owner input after navigation invalidates the decorated document', async () => {
    const { driver, fake, signal } = await rig();
    const observed = await driver.execute({ action: 'snapshot' }, signal);
    await driver.execute({ action: 'click', observationId: observed.observationId!, ref: 'r1' }, signal);
    fake.failCursor(); driver.invalidateObservation();
    await expect(driver.detach()).resolves.toBeUndefined();
    expect(fake.messages.some(row => row.method === 'Target.detachFromTarget')).toBe(true);
  });
  it('clears the painted agent pointer on observation invalidation before detaching for owner input',async()=>{
    const {driver,fake,signal}=await rig();const observed=await driver.execute({action:'snapshot'},signal);
    await driver.execute({action:'click',observationId:observed.observationId!,ref:'r1'},signal);
    const draw=fake.messages.find(row=>row.method==='Runtime.callFunctionOn' && row.params.functionDeclaration.includes('data-matrix-agent-cursor'));
    expect(draw.params.awaitPromise).toBe(true);expect(draw.sessionId).toBe('agent-session');
    driver.invalidateObservation();await driver.detach();
    const cleared=fake.messages.findIndex(row=>row.method==='Runtime.callFunctionOn' && row.params.functionDeclaration.startsWith('function MATRIX_CLEAR_CURSOR'));
    const detached=fake.messages.findIndex(row=>row.method==='Target.detachFromTarget');
    expect(cleared).toBeGreaterThan(-1);expect(cleared).toBeLessThan(detached);
  });
  it('recovers a closed selected tab on fresh snapshot after owner takeover without replaying mutations', async () => {
    const { driver, fake, signal } = await rig();
    const observed = await driver.execute({ action: 'snapshot' }, signal);
    await driver.detach(); fake.closeTarget('agent-tab');
    const start = fake.messages.length;
    await expect(driver.execute({ action: 'click', observationId: observed.observationId!, ref: 'r1' }, signal)).rejects.toMatchObject({ code: 'observe_again' });
    expect(fake.messages.slice(start).some(row => row.method === 'Target.createTarget' || row.method === 'Runtime.callFunctionOn')).toBe(false);
    expect(await driver.execute({ action: 'snapshot' }, signal)).toMatchObject({ success: true, targetId: 'agent-tab-2' });
    expect((await driver.execute({ action: 'tabs' }, signal)).tabs?.map(row => row.targetId)).toEqual(['agent-tab-2']);
    expect(fake.messages.some(row => row.method === 'Target.getTargets' || row.method === 'Target.closeTarget')).toBe(false);
    await driver.detach();
  });
  it('reconciles closed recorded tabs on listing and releases capacity without owner scans', async () => {
    const { driver, fake, signal } = await rig();
    for (let index = 0; index < 8; index++) await driver.execute({ action: 'tab_new' }, signal);
    await driver.detach(); fake.closeTarget('agent-tab'); fake.closeTarget('agent-tab-2');
    expect((await driver.execute({ action: 'tabs' }, signal)).tabs).toHaveLength(6);
    expect(await driver.execute({ action: 'tab_new' }, signal)).toMatchObject({ success: true, targetId: 'agent-tab-9' });
    await driver.execute({ action: 'tab_new' }, signal);
    fake.closeTarget('agent-tab-3');
    expect(await driver.execute({ action: 'tab_new' }, signal)).toMatchObject({ success: true, targetId: 'agent-tab-11' });
    expect(fake.messages.filter(row => row.method === 'Target.getTargetInfo').every(row => /^agent-tab(?:-\d+)?$/.test(row.params.targetId))).toBe(true);
    await driver.detach();
  });
  it('recovers closed selected targets after disconnect and unsolicited detach', async () => {
    for (const disconnected of [false, true]) {
      const { driver, fake, signal } = await rig(); await driver.execute({ action: 'snapshot' }, signal);
      fake.closeTarget('agent-tab');
      if (disconnected) fake.disconnect(); else fake.event('Target.detachedFromTarget', { sessionId: 'agent-session', targetId: 'agent-tab' });
      expect(await driver.execute({ action: 'snapshot' }, signal)).toMatchObject({ success: true, targetId: 'agent-tab-2' });
      await driver.detach();
    }
  });
  it('preserves live tabs across intentional detach and switch', async () => {
    const { driver, fake, signal } = await rig(); await driver.execute({ action: 'tab_new' }, signal); await driver.execute({ action: 'tab_new' }, signal);
    await driver.detach();
    expect(await driver.execute({ action: 'snapshot' }, signal)).toMatchObject({ targetId: 'agent-tab-2' });
    expect(await driver.execute({ action: 'tab_switch', targetId: 'agent-tab' }, signal)).toMatchObject({ targetId: 'agent-tab' });
    expect((await driver.execute({ action: 'tabs' }, signal)).tabs).toHaveLength(2);
    expect(fake.messages.filter(row => row.method === 'Target.createTarget')).toHaveLength(2); await driver.detach();
  });
  it('does not classify general target lookup failures as confirmed closures', async () => {
    const { driver, fake, signal } = await rig(); await driver.execute({ action: 'snapshot' }, signal); await driver.detach();
    fake.failLookup({ code: -32000, message: 'No target with given id found' });
    await expect(driver.execute({ action: 'snapshot' }, signal)).rejects.toMatchObject({ code: 'browser_unavailable' });
    fake.failLookup(); expect(await driver.execute({ action: 'snapshot' }, signal)).toMatchObject({ targetId: 'agent-tab' });
    expect(fake.messages.filter(row => row.method === 'Target.createTarget')).toHaveLength(1); await driver.detach();
  });
  it('only fresh observation recovers after disconnect; stale mutation does not create or invoke a target', async () => {
    const { driver, fake, signal } = await rig(); const observed = await driver.execute({ action: 'snapshot' }, signal);
    fake.disconnect(); fake.closeTarget('agent-tab'); const start = fake.messages.length;
    await expect(driver.execute({ action: 'click', observationId: observed.observationId!, ref: 'r1' }, signal)).rejects.toMatchObject({ code: 'observe_again' });
    expect(fake.messages.slice(start).some(row => row.method === 'Target.createTarget' || row.method === 'Runtime.callFunctionOn')).toBe(false);
    expect(await driver.execute({ action: 'snapshot' }, signal)).toMatchObject({ targetId: 'agent-tab-2' }); await driver.detach();
  });
  it('hands disconnected related sessions to the owner without addressing stale session IDs on the fresh transport', async () => {
    const { driver, fake, signal } = await rig(); await driver.execute({ action: 'snapshot' }, signal);
    fake.event('Target.attachedToTarget', { sessionId: 'child-session', waitingForDebugger: true, targetInfo: { targetId: 'agent-child', type: 'iframe', url: fixture + '/child' } });
    await vi.waitFor(() => expect(fake.messages.some(row => row.method === 'Runtime.runIfWaitingForDebugger' && row.sessionId === 'child-session')).toBe(true));
    fake.disconnect(); const start = fake.messages.length;
    expect(await driver.execute({ action: 'snapshot' }, signal)).toMatchObject({ success: false, handoffRequested: true });
    await driver.detach(); expect(fake.messages.slice(start).some(row => row.sessionId === 'child-session' || row.params.sessionId === 'child-session')).toBe(false);
  });
  it('rejects failed new-tab navigation instead of acknowledging success', async () => {
    const { driver, fake, signal } = await rig(); fake.failNavigation();
    await expect(driver.execute({ action: 'tab_new', url: fixture }, signal)).rejects.toMatchObject({ code: 'browser_unavailable' });
    await driver.detach();
  });
  it('confirms default download behavior on a fresh fixed connection after an uncertain transport failure',async()=>{
    const homePath=await mkdtemp(join(tmpdir(),'shared-cdp-recovery-'));homes.push(homePath);const fake=chrome();
    const driver=createSharedBrowserCdpDriver({homePath,...fake,commandTimeoutMs:20});fake.skip('Page.enable');
    await expect(driver.execute({action:'navigate',url:fixture},new AbortController().signal)).rejects.toMatchObject({code:'browser_unavailable',dispatched:true});
    fake.skip('');await driver.detach();expect(fake.fetcher).toHaveBeenCalledTimes(2);
    expect(fake.messages.at(-1)).toMatchObject({method:'Browser.setDownloadBehavior',params:{behavior:'default',eventsEnabled:false}});
    expect(fake.messages.some(row=>row.method==='Browser.close')).toBe(false);
  });
  it('can begin with a fresh snapshot of its own blank tab before navigation',async()=>{
    const {driver,signal}=await rig();const result=await driver.execute({action:'snapshot'},signal);
    expect(result).toMatchObject({success:true,url:'about:blank',targetId:'agent-tab'});
    expect(result.observationId).toBeTruthy();
    expect((await driver.execute({action:'tabs'},signal)).tabs).toHaveLength(1);
    expect(await driver.execute({action:'tab_switch',targetId:'agent-tab'},signal)).toMatchObject({success:true});
    await driver.detach();
  });
  it('attaches only to a dedicated visible tab and never scans owner tabs or starts another browser', async () => {
    const { driver, fake, signal } = await rig();
    await driver.execute({ action: 'navigate', url: fixture }, signal);
    const snapshot = await driver.execute({ action: 'snapshot' }, signal);
    expect(snapshot).toMatchObject({ success: true, content: 'Two invoices', targetId: 'agent-tab', elements: [{ ref: 'r1', role: 'link', name: 'Original invoice' }] });
    await driver.execute({ action: 'click', observationId: snapshot.observationId!, ref: 'r1' }, signal);
    expect(fake.fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:9222/json/version');
    expect(fake.messages.some(packet => packet.method === 'Target.activateTarget')).toBe(true);
    expect(fake.messages.some(packet => /getTargets|Browser.close|Network.get.*Cookies/.test(packet.method))).toBe(false);
    await driver.detach();
    expect(fake.messages.some(packet => packet.method === 'Fetch.disable')).toBe(true);
    expect(fake.messages.some(packet => packet.method === 'Target.closeTarget')).toBe(false);
  });
  it('invalidates document handles after navigation, context changes, takeover and target closure', async () => {
    for (const invalidate of ['manual', 'Page.frameNavigated', 'Runtime.executionContextsCleared', 'Target.detachedFromTarget']) {
      const { driver, fake, signal } = await rig(); await driver.execute({ action: 'navigate', url: fixture }, signal);
      const snapshot = await driver.execute({ action: 'snapshot' }, signal);
      if (invalidate === 'manual') driver.invalidateObservation(); else fake.event(invalidate, { frame: { id: 'agent-frame' }, sessionId: 'agent-session' });
      await expect(driver.execute({ action: 'click', observationId: snapshot.observationId!, ref: 'r1' }, signal)).rejects.toMatchObject({ code: 'observe_again' });
      await driver.detach();
    }
  });
  it('requires owner authentication and rejects switching to an arbitrary private target', async () => {
    const { driver, fake, signal } = await rig(); await driver.execute({ action: 'navigate', url: fixture }, signal); fake.setHandoff(true);
    const snapshot = await driver.execute({ action: 'snapshot' }, signal);
    expect(snapshot.content).toContain('owner'); expect(snapshot.elements).toEqual([]);
    await expect(driver.execute({ action: 'tab_switch', targetId: 'owner-vault-tab' }, signal)).rejects.toMatchObject({ code: 'invalid_action' });
    await driver.detach();
  });
  it('blocks redirect/private network requests before Chrome continues them', async () => {
    const { driver, fake, signal } = await rig(); await driver.execute({ action: 'navigate', url: fixture }, signal);
    fake.event('Fetch.requestPaused', { requestId: 'private-request', request: { url: 'http://169.254.169.254/latest/meta-data/' } });
    await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Fetch.failRequest', params: { requestId: 'private-request', errorReason: 'BlockedByClient' } })));
    expect(fake.messages.some(packet => packet.method === 'Fetch.continueRequest' && packet.params.requestId === 'private-request')).toBe(false);
    await driver.detach();
  });
  it('does not dispatch already-cancelled actions', async () => {
    const { driver, fake } = await rig(); const abort = new AbortController(); abort.abort();
    await expect(driver.execute({ action: 'navigate', url: fixture }, abort.signal)).rejects.toThrow();
    expect(fake.messages).toEqual([]); await driver.detach();
  });
  it('caps live owned tabs and forgets expired identifiers without closing owner Chrome tabs', async () => {
    const { driver, fake, signal } = await rig(); const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    for (let i = 0; i < 8; i++) await driver.execute({ action: 'tab_new', url: fixture }, signal);
    await expect(driver.execute({ action: 'tab_new', url: fixture }, signal)).rejects.toMatchObject({ code: 'browser_busy' });
    clock.mockReturnValue(1_000_000 + 24 * 60 * 60_000 + 1);
    await expect(driver.execute({ action: 'tab_new', url: fixture }, signal)).resolves.toMatchObject({ success: true });
    expect(fake.messages.some(packet => packet.method === 'Target.closeTarget' || packet.method === 'Browser.close')).toBe(false);
    await driver.detach();
  });
  it('collects an observed original through the actual driver, CDP client, browser events and artifact store', async () => {
    const { driver, fake, signal, homePath } = await rig(); const original = fake.enableDownloads();
    await driver.execute({ action: 'navigate', url: fixture }, signal);
    const observed = await driver.execute({ action: 'snapshot' }, signal);
    const result = await driver.execute({ action: 'download', observationId: observed.observationId!, ref: 'r1', documentId: 'INV-001' }, signal);
    expect(result).toMatchObject({ success: true, artifact: { documentId: 'INV-001', original: true, size: original.length } });
    expect(await readFile(join(homePath, result.artifact!.path))).toEqual(original);
    expect(fake.messages.some(packet => /Cookies|Storage|Browser.close/.test(packet.method))).toBe(false);
    expect(fake.messages.some(packet => packet.method === 'Browser.cancelDownload')).toBe(false);
    expect(fake.messages.at(-1)).toMatchObject({ method: 'Browser.setDownloadBehavior', params: { behavior: 'deny', eventsEnabled: true } });
    await driver.detach();
  });
  it('denies ordinary click downloads until owner control is restored', async () => {
    const { driver, fake, signal } = await rig(); fake.enableDownloads();
    const observed = await driver.execute({ action: 'snapshot' }, signal);
    expect(fake.messages.some(row => row.method === 'Browser.setDownloadBehavior' && row.params.behavior === 'deny')).toBe(true);
    const start = fake.messages.length;
    await expect(driver.execute({ action: 'click', observationId: observed.observationId!, ref: 'r1' }, signal)).resolves.toMatchObject({ success: true });
    const dispatched = fake.messages.slice(start);
    const click = dispatched.findIndex(row => row.method === 'Runtime.callFunctionOn' && row.params.arguments?.[2]?.value === 'click');
    expect(click).toBeGreaterThanOrEqual(0);
    expect(dispatched.some(row => row.method === 'Browser.downloadWillBegin')).toBe(false);
    fake.event('Browser.downloadWillBegin', { guid: 'unexpected-guid', frameId: 'agent-frame', url: fixture + '/unexpected.pdf' });
    await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Browser.cancelDownload', params: { guid: 'unexpected-guid' } })));
    await driver.detach();
    expect(fake.messages.at(-1)).toMatchObject({ method: 'Browser.setDownloadBehavior', params: { behavior: 'default', eventsEnabled: false } });
  });
  it('rejects arbitrary evaluation and endpoint selection before connecting or dispatching', async () => {
    const { driver, fake, signal } = await rig();
    await expect(driver.execute({ action: 'evaluate', script: 'document.cookie' } as never, signal)).rejects.toMatchObject({ code: 'invalid_action', dispatched: false });
    expect(fake.messages).toEqual([]); expect(fake.fetcher).not.toHaveBeenCalled(); await driver.detach();
  });
  it('gates related page/iframe targets before resuming and applies the same request policy', async () => {
    const { driver, fake, signal } = await rig(); await driver.execute({ action: 'navigate', url: fixture }, signal);
    fake.event('Target.attachedToTarget', { sessionId: 'child-session', waitingForDebugger: true, targetInfo: { targetId: 'agent-child', type: 'iframe', url: fixture + '/child' } });
    await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Runtime.runIfWaitingForDebugger', sessionId: 'child-session' })));
    const enabled = fake.messages.findIndex(packet => packet.method === 'Fetch.enable' && packet.sessionId === 'child-session');
    const resumed = fake.messages.findIndex(packet => packet.method === 'Runtime.runIfWaitingForDebugger' && packet.sessionId === 'child-session');
    expect(enabled).toBeGreaterThan(-1); expect(resumed).toBeGreaterThan(enabled);
    fake.event('Fetch.requestPaused', { requestId: 'child-private', request: { url: 'http://169.254.169.254/latest/' } }, 'child-session');
    await vi.waitFor(() => expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Fetch.failRequest', sessionId: 'child-session', params: { requestId: 'child-private', errorReason: 'BlockedByClient' } })));
    expect(fake.messages).toContainEqual(expect.objectContaining({ method: 'Network.setBypassServiceWorker', params: { bypass: true } }));
    await driver.detach();
  });
  it('hands unsupported workers to the owner without resuming or closing existing owner workers/tabs', async () => {
    const { driver, fake, signal } = await rig(); await driver.execute({ action: 'navigate', url: fixture }, signal);
    fake.event('Target.attachedToTarget', { sessionId: 'owner-worker-session', waitingForDebugger: false, targetInfo: { targetId: 'owner-shared-worker', type: 'shared_worker', url: fixture + '/worker.js' } });
    const result = await driver.execute({ action: 'snapshot' }, signal);
    expect(result).toMatchObject({ success: false, handoffRequested: true, elements: [] }); expect(result.content).toContain('owner');
    expect(fake.messages.some(packet => packet.method === 'Runtime.runIfWaitingForDebugger' && packet.sessionId === 'owner-worker-session')).toBe(false);
    expect(fake.messages.some(packet => packet.method === 'Target.closeTarget' || packet.method === 'Browser.close')).toBe(false);
    await driver.detach();
    expect(fake.messages.some(packet => packet.method === 'Runtime.runIfWaitingForDebugger' && packet.sessionId === 'owner-worker-session')).toBe(false);
  });
  it('releases only newly paused related workers during final owner handoff', async () => {
    const { driver, fake, signal } = await rig(); await driver.execute({ action: 'navigate', url: fixture }, signal);
    fake.event('Target.attachedToTarget', { sessionId: 'new-worker-session', waitingForDebugger: true, targetInfo: { targetId: 'new-agent-worker', type: 'worker', url: fixture + '/worker.js' } });
    expect(await driver.execute({ action: 'snapshot' }, signal)).toMatchObject({ success: false, handoffRequested: true });
    expect(fake.messages.some(packet => packet.method === 'Runtime.runIfWaitingForDebugger' && packet.sessionId === 'new-worker-session')).toBe(false);
    await driver.detach();
    expect(fake.messages.filter(packet => packet.method === 'Runtime.runIfWaitingForDebugger' && packet.sessionId === 'new-worker-session')).toHaveLength(1);
    expect(fake.messages.some(packet => packet.method === 'Target.closeTarget' || packet.method === 'Browser.close')).toBe(false);
  });
});
describe('fixed CDP transport and public URL policy', () => {
  it('preserves only exact confirmed missing-target responses as typed no-effect refusals', async () => {
    const fake = chrome(); const client = await connectBrowserCdp(fake); fake.closeTarget('agent-tab');
    for (const method of ['Target.getTargetInfo', 'Target.attachToTarget']) await expect(client.request(method, { targetId: 'agent-tab' })).rejects.toMatchObject({ name: 'BrowserCdpMissingTargetError', code: 'observe_again', dispatched: false });
    fake.failLookup({ code: -32602, message: 'Invalid target parameter' });
    await expect(client.request('Target.getTargetInfo', { targetId: 'agent-tab' })).rejects.toMatchObject({ name: 'SharedBrowserError', code: 'browser_unavailable', dispatched: true });
    fake.skip('Page.navigate'); const navigation = client.request('Page.navigate', { url: fixture });
    fake.raw({ id: fake.messages.at(-1).id, error: { code: -32602, message: 'No target with given id found' } });
    await expect(navigation).rejects.toMatchObject({ name: 'SharedBrowserError', code: 'browser_unavailable', dispatched: true }); await client.close();
  });
  it('rejects external, page, credentialed and alternate-port CDP sockets', async () => {
    for (const url of ['ws://example.com:9222/devtools/browser/id', 'ws://127.0.0.1:9223/devtools/browser/id', 'ws://127.0.0.1:9222/devtools/page/id', 'ws://x:y@127.0.0.1:9222/devtools/browser/id']) {
      await expect(connectBrowserCdp({ fetcher: async () => Response.json({ webSocketDebuggerUrl: url }) })).rejects.toMatchObject({ code: 'browser_unavailable' });
    }
  });
  it('caps and evicts pending requests on deadline, cancellation and disconnect', async () => {
    const fake = chrome(); const client = await connectBrowserCdp({ ...fake, commandTimeoutMs: 20 }); fake.skip('Page.enable');
    const pending = client.request('Page.enable', {}, undefined, new AbortController().signal);
    await expect(pending).rejects.toMatchObject({ code: 'browser_unavailable' }); expect(client.pendingCount).toBe(0); await client.close();
  });
  it('rejects request 65 and drains all 64 existing requests on disconnect', async () => {
    const fake = chrome(); const client = await connectBrowserCdp(fake); fake.skip('Page.enable');
    const requests = Array.from({ length: 64 }, () => client.request('Page.enable').catch(error => error));
    expect(client.pendingCount).toBe(64);
    await expect(client.request('Page.enable')).rejects.toMatchObject({ dispatched: false });
    await client.close(); const errors = await Promise.all(requests);
    expect(errors.every(error => error.dispatched === true)).toBe(true); expect(client.pendingCount).toBe(0);
  });
  it('waits for a sent action acknowledgement before returning an uncertain cancellation', async () => {
    const fake = chrome(); const client = await connectBrowserCdp(fake); fake.skip('Runtime.callFunctionOn');
    const abort = new AbortController(); const request = client.request('Runtime.callFunctionOn', {}, 'agent-session', abort.signal);
    abort.abort(); expect(client.pendingCount).toBe(1);
    fake.raw({ id: fake.messages.at(-1).id, result: {} });
    await expect(request).rejects.toMatchObject({ code: 'browser_changed', dispatched: true }); await client.close();
  });
  it('bounds and drains invalid or oversized Chrome output without leaking its contents', async () => {
    for (const value of ['private malformed frame', 'x'.repeat(192 * 1024 + 1)]) {
      const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fake = chrome(); const client = await connectBrowserCdp(fake); fake.skip('Page.enable');
      const pending = client.request('Page.enable'); fake.raw(value);
      await expect(pending).rejects.toMatchObject({ code: 'browser_unavailable', dispatched: true });
      expect(client.pendingCount).toBe(0); expect(JSON.stringify(log.mock.calls)).not.toContain('private'); log.mockRestore();
    }
  });
  it('permits only public resolved destinations and the exact invoice fixture subtree', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
    await expect(validateBrowserUrl('https://example.com/invoices?token=private#secret', resolver)).resolves.toMatchObject({ sourceUrl: 'https://example.com/invoices' });
    await expect(validateBrowserUrl(fixture + '/original.pdf')).resolves.toMatchObject({ fixture: true });
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'chrome-extension://vault/id', 'http://127.0.0.1:8730/other', fixture + '/../secrets', fixture + '/%2f..%2fsecrets', fixture + '/%5c..%5csecrets', 'https://x:y@example.com', 'http://192.0.2.1', 'http://[::ffff:7f00:1]', 'http://[2001:db8::1]', 'http://[3fff::1]']) {
      await expect(validateBrowserUrl(url, resolver)).rejects.toMatchObject({ code: 'invalid_action' });
    }
    await expect(validateBrowserUrl('https://example.com', async () => [{ address: '10.0.0.1', family: 4 }])).rejects.toMatchObject({ code: 'invalid_action' });
  });
});
