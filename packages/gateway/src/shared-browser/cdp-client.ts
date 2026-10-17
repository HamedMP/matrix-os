import WebSocket from 'ws';
import { z } from 'zod/v4';
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
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4096;
const MAX_JSON_STRING = 64 * 1024;
const MAX_JSON_KEY = 256;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(MAX_JSON_STRING),
  z.array(jsonValueSchema), z.record(z.string().max(MAX_JSON_KEY), jsonValueSchema),
]));
const cdpPayloadSchema = z.record(z.string().max(MAX_JSON_KEY), jsonValueSchema);
const cdpReplySchema = z.object({
  id: z.number().int().safe().nonnegative(),
  result: cdpPayloadSchema.optional(),
  error: z.object({
    code: z.number().int().safe(),
    message: z.string().max(4096),
    data: jsonValueSchema.optional(),
  }).passthrough().optional(),
}).passthrough().refine(packet => packet.result !== undefined || packet.error !== undefined);
const cdpEventSchema = z.object({
  method: z.string().min(1).max(127),
  params: cdpPayloadSchema,
  sessionId: z.string().min(1).max(256).optional(),
}).passthrough();
const cdpEventHeaderSchema = z.object({
  method: z.string().min(1).max(127),
  id: z.never().optional(),
}).passthrough();
const CONSUMED_CDP_EVENTS = new Set([
  'Browser.downloadProgress', 'Browser.downloadWillBegin', 'DOM.documentUpdated',
  'Fetch.requestPaused', 'Page.frameNavigated', 'Page.navigatedWithinDocument',
  'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared',
  'Target.attachedToTarget', 'Target.detachedFromTarget', 'Target.targetDestroyed',
]);

function hasBoundedJsonShape(root: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (typeof value === 'string') { if (value.length > MAX_JSON_STRING) return false; continue; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') continue;
    if (Array.isArray(value)) {
      for (const entry of value) pending.push({ value: entry, depth: depth + 1 });
      continue;
    }
    if (!value || typeof value !== 'object') return false;
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_NODES || entries.some(([key]) => key.length > MAX_JSON_KEY)) return false;
    for (const [, entry] of entries) pending.push({ value: entry, depth: depth + 1 });
  }
  return true;
}
const unavailable = (dispatched = false) => new SharedBrowserError('browser_unavailable', dispatched);
/** Only the exact Chromium InvalidParams response proves a recorded target is gone. */
export class BrowserCdpMissingTargetError extends SharedBrowserError {
  constructor() { super('observe_again'); this.name = 'BrowserCdpMissingTargetError'; }
}
/** An exact Chromium response for a document object that no longer exists. */
export class BrowserCdpMissingObjectError extends Error {
  constructor() { super('Browser document changed'); this.name = 'BrowserCdpMissingObjectError'; }
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
    let decoded: unknown;
    try { decoded = JSON.parse(bytes.toString('utf8')); }
    catch (error) { console.warn('[shared-browser] CDP frame unavailable', error instanceof SyntaxError ? 'invalid_frame' : 'operation_failed'); this.fail(); return; }
    const eventHeader = cdpEventHeaderSchema.safeParse(decoded);
    if (eventHeader.success && !CONSUMED_CDP_EVENTS.has(eventHeader.data.method)) return;
    if (!hasBoundedJsonShape(decoded)) { this.fail(); return; }
    const reply = cdpReplySchema.safeParse(decoded);
    if (reply.success) {
      const packet = reply.data;
      const method = this.pending.get(packet.id)?.method;
      const missing = ['Target.getTargetInfo', 'Target.attachToTarget'].includes(method ?? '')
        && packet.error?.code === -32602 && packet.error?.message === 'No target with given id found';
      const missingObject = method === 'Runtime.callFunctionOn' && packet.error?.code === -32000
        && packet.error?.message === 'Could not find object with given id';
      this.finish(packet.id, packet.error ? missing ? new BrowserCdpMissingTargetError()
        : missingObject ? new BrowserCdpMissingObjectError() : unavailable() : undefined,
      packet.result ?? {});
    } else {
      const event = cdpEventSchema.safeParse(decoded);
      if (!event.success) { this.fail(); return; }
      const packet = event.data;
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
