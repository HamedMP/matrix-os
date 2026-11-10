import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, vi } from 'vitest';
import { createSharedBrowserCdpDriver } from '../../packages/gateway/src/shared-browser/cdp-driver.js';
const fixture = 'http://127.0.0.1:8730/invoices';
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
export function chrome() {
  let url = 'about:blank', handoff = false, snapshotId = '', skip = '', created = 0, downloadPath = '', downloads = false, navigationError = false, missingCursor = false, globalPrimaryAttachEvent = false;
  const missing = new Set<string>();
  const sessionParents = new Map<string, string>(); // Bounded by the fixture's target/session events.
  let enforceChildSessions = false;
  let lookupError: { code: number; message: string } | undefined;
  let cursorError = { code: -32000, message: "Could not find object with given id" };
  let recoveryError = false;
  const original = Buffer.from('%PDF-1.4\noriginal CDP invoice fixture\n%%EOF');
  const messages: any[] = [];
  class Socket extends EventEmitter {
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send(data: string) {
      const packet = JSON.parse(data); messages.push(packet);
      if (packet.method === skip) return;
      if (enforceChildSessions && packet.method === 'Target.detachFromTarget' && sessionParents.has(packet.params.sessionId)
        && sessionParents.get(packet.params.sessionId) !== (packet.sessionId ?? '')) {
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id: packet.id, error: { code: -32602, message: 'No session with given id' } }))));
        return;
      }
      if (['Target.getTargetInfo', 'Target.attachToTarget'].includes(packet.method) && (missing.has(packet.params.targetId) || lookupError)) {
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id: packet.id, error: lookupError ?? { code: -32602, message: 'No target with given id found' } }))));
        return;
      }
      if (missingCursor && packet.method === 'Runtime.callFunctionOn' && packet.params.functionDeclaration.startsWith('function MATRIX_CLEAR_CURSOR')) {
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id: packet.id, error: cursorError }))));
        return;
      }
      if (recoveryError && packet.method === 'Runtime.evaluate' && packet.params.expression.includes('MATRIX_CLEAR_CURSOR')) {
        queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id: packet.id, error: { code: -32000, message: 'private recovery failure' } }))));
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
        if (enforceChildSessions && packet.method === 'Target.setAutoAttach' && packet.params.autoAttach === false) {
          for (const [child, parent] of sessionParents) if (parent === packet.sessionId) {
            sessionParents.delete(child);
            this.emit('message', Buffer.from(JSON.stringify({ method: 'Target.detachedFromTarget', sessionId: parent, params: { sessionId: child } })));
          }
        }
        if (packet.method === 'Target.detachFromTarget') {
          sessionParents.delete(packet.params.sessionId);
          this.emit('message', Buffer.from(JSON.stringify({ method: 'Target.detachedFromTarget', ...(packet.sessionId ? { sessionId: packet.sessionId } : {}), params: { sessionId: packet.params.sessionId } })));
        }
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
  return { messages, fetcher, socketFactory: () => (socket = new Socket()), raw: (value: unknown) => socket.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))), event: (method: string, params: Record<string, any> = {}, sessionId = 'agent-session') => {
      if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string') sessionParents.set(params.sessionId, sessionId);
      socket.emit('message', Buffer.from(JSON.stringify({ method, params, sessionId })));
    },
    enforceChildSessions() { enforceChildSessions = true; },
    emitPrimaryAttachBeforeAck() { globalPrimaryAttachEvent = true; },
    setUrl(value: string) { url = value; }, setHandoff(value: boolean) { handoff = value; }, skip(value: string) { skip = value; }, enableDownloads() { downloads = true; return original; },
    closeTarget(id: string) { missing.add(id); }, failLookup(error?: { code: number; message: string }) { lookupError = error; }, failNavigation() { navigationError = true; }, failCursor(error?: { code: number; message: string }) { missingCursor = true; if (error) cursorError = error; }, failCursorRecovery() { recoveryError = true; }, disconnect() { socket.close(); } };
}
export async function rig(commandTimeoutMs?:number) {
  const homePath = await mkdtemp(join(tmpdir(), 'shared-cdp-')); homes.push(homePath);
  const fake = chrome(); const driver = createSharedBrowserCdpDriver({ homePath, ...fake, commandTimeoutMs });
  return { driver, fake, homePath, signal: new AbortController().signal };
}
