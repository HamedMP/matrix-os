import WebSocket from 'ws';
import { SharedBrowserError } from './broker.js';

export interface CdpSocket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
}
export interface CdpEvent { method: string; params: Record<string, any>; sessionId?: string }
export interface CdpConnectOptions {
  fetcher?: typeof fetch;
  socketFactory?: (url: string) => CdpSocket;
  commandTimeoutMs?: number;
}
type Pending = { method: string; resolve(value: Record<string, any>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; aborted: boolean; onAbort(): void };
const MAX_FRAME = 192 * 1024;
const unavailable = (dispatched = false) => new SharedBrowserError('browser_unavailable', dispatched);
/** Only the exact Chromium InvalidParams response proves a recorded target is gone. */
export class BrowserCdpMissingTargetError extends SharedBrowserError {
  constructor() { super('observe_again'); this.name = 'BrowserCdpMissingTargetError'; }
}

export class BrowserCdpClient {
  private readonly pending = new Map<number, Pending>(); // <=64, deadline/close eviction.
  private readonly listeners = new Set<(event: CdpEvent) => void>(); // <=8; explicit unsubscribe/close drain.
  private sequence = 0;
  private closed = false;
  constructor(private readonly socket: CdpSocket, private readonly timeoutMs: number) {
    socket.on('message', this.message);
    socket.on('close', this.disconnected);
    socket.on('error', this.disconnected);
  }
  get pendingCount() { return this.pending.size; }
  get available() { return !this.closed; }
  onEvent(callback: (event: CdpEvent) => void) {
    if (this.closed || this.listeners.size >= 8) throw unavailable();
    this.listeners.add(callback); return () => this.listeners.delete(callback);
  }
  private finish(id: number, error?: Error, value: Record<string, any> = {}) {
    const request = this.pending.get(id); if (!request) return;
    this.pending.delete(id); clearTimeout(request.timer); request.signal?.removeEventListener('abort', request.onAbort);
    if (error || request.aborted) request.reject(error instanceof BrowserCdpMissingTargetError && !request.aborted ? error
      : error instanceof SharedBrowserError ? new SharedBrowserError(error.code, true) : error ?? new SharedBrowserError('browser_changed', true));
    else request.resolve(value);
  }
  private message = (data: unknown) => {
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.isBuffer(data) ? data : undefined;
    if (!bytes || bytes.length > MAX_FRAME) { this.fail(); return; }
    let packet: Record<string, any>;
    try { packet = JSON.parse(bytes.toString('utf8')); }
    catch (error) { console.warn('[shared-browser] CDP frame unavailable', error instanceof SyntaxError ? 'invalid_frame' : 'operation_failed'); this.fail(); return; }
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) { this.fail(); return; }
    if (Number.isSafeInteger(packet.id)) {
      const method = this.pending.get(packet.id)?.method;
      const missing = ['Target.getTargetInfo', 'Target.attachToTarget'].includes(method ?? '')
        && packet.error?.code === -32602 && packet.error?.message === 'No target with given id found';
      this.finish(packet.id, packet.error ? missing ? new BrowserCdpMissingTargetError() : unavailable() : undefined, packet.result && typeof packet.result === 'object' ? packet.result : {});
    } else if (typeof packet.method === 'string' && packet.method.length < 128 && packet.params && typeof packet.params === 'object') {
      for (const callback of this.listeners) {
        try { callback({ method: packet.method, params: packet.params, sessionId: packet.sessionId }); }
        catch (error) { console.warn('[shared-browser] CDP event unavailable', error instanceof SharedBrowserError ? error.code : 'operation_failed'); this.fail(); break; }
      }
    }
  };
  private disconnected = () => this.fail();
  private fail() {
    if (this.closed) return; this.closed = true;
    for (const id of this.pending.keys()) this.finish(id, unavailable());
    this.listeners.clear();
    this.socket.off('message', this.message);
    // Retain the idempotent error/close drain until this socket is collected;
    // a late transport error during close must not become an uncaught event.
    this.socket.close();
  }
  request(method: string, params: Record<string, unknown> = {}, sessionId?: string, signal?: AbortSignal): Promise<Record<string, any>> {
    if (this.closed || signal?.aborted || this.pending.size >= 64) return Promise.reject(unavailable());
    const id = ++this.sequence;
    const encoded = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    if (Buffer.byteLength(encoded) > MAX_FRAME) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      // Once sent, wait for the acknowledgement before reporting cancellation.
      // A synchronous page action may have already run; takeover must drain it.
      const request: Pending = { method, resolve, reject, aborted: false, signal,
        onAbort: () => { request.aborted = true; }, timer: setTimeout(() => this.fail(), this.timeoutMs) };
      this.pending.set(id, request); signal?.addEventListener('abort', request.onAbort, { once: true });
      try { this.socket.send(encoded); }
      catch (error) { console.warn('[shared-browser] CDP command unavailable', error instanceof Error ? 'send_failed' : 'operation_failed'); this.fail(); }
    });
  }
  async close() { this.fail(); }
}

export async function connectBrowserCdp(options: CdpConnectOptions = {}): Promise<BrowserCdpClient> {
  try {
    const response = await (options.fetcher ?? fetch)('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok || !response.body) throw unavailable();
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 16_384) { await reader.cancel(); throw unavailable(); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const version = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const url = new URL(version.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== '9222' || url.username || url.password || url.search || url.hash || !/^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/.test(url.pathname)) throw unavailable();
    const socket = (options.socketFactory ?? (address => new WebSocket(address, { maxPayload: MAX_FRAME, handshakeTimeout: 3000 })))(url.href);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); socket.close(); reject(unavailable()); };
      const timer = setTimeout(failed, 3000);
      socket.on('open', opened); socket.on('error', failed); socket.on('close', failed);
    });
    return new BrowserCdpClient(socket, Math.min(8000, Math.max(1, options.commandTimeoutMs ?? 8000)));
  } catch (error) {
    if (error instanceof SharedBrowserError) throw error;
    console.warn('[shared-browser] Chrome attachment unavailable', error instanceof SyntaxError ? 'invalid_version' : 'attachment_failed');
    throw unavailable();
  }
}
