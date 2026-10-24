import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScopeRuntimeBrokerServer } from '../../packages/gateway/src/collaboration/scope-runtime-broker.js';
import { ScopeRuntimeInferenceStreamFrameSchema } from '../../packages/scope-runtime/src/broker-protocol.js';

const id = '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1';
const request = { version: 1, action: 'inference.responses', requestId: id,
  runtimeHandle: 'runtime_22222222222222222222222222222222', executionGeneration: '7', method: 'POST', path: '/v1/responses',
  headers: {}, body: JSON.stringify({ model: 'test', stream: true, input: [] }), responseMode: 'stream' };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).reverse().map(clean => clean())); });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(routeFrame: (raw: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>) {
  const root = await mkdtemp(join(tmpdir(), 'matrix-stream-server-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, 'b.sock');
  const server = createScopeRuntimeBrokerServer({ socketPath, broker: { handle: vi.fn(), close: vi.fn() }, routeFrame });
  await server.start(); cleanups.push(() => server.close()); return socketPath;
}
function exchange(socketPath: string, raw: unknown, onFrame?: (frame: Record<string, unknown>, socket: Socket) => void) {
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const socket = createConnection(socketPath); let input = ''; const frames: Record<string, unknown>[] = [];
    socket.setEncoding('utf8'); socket.on('error', reject); socket.on('close', () => resolve(frames));
    socket.on('connect', () => {
      const value = raw as { action?: string; responseMode?: string };
      if (value.responseMode === 'stream' && value.action?.startsWith('inference.')) socket.write(JSON.stringify(raw) + '\n');
      else socket.end(JSON.stringify(raw) + '\n');
    });
    socket.on('data', chunk => { input += chunk; let at: number;
      while ((at = input.indexOf('\n')) >= 0) { const frame = JSON.parse(input.slice(0, at)) as Record<string, unknown>;
        input = input.slice(at + 1); frames.push(frame); onFrame?.(frame, socket); }
    });
  });
}
const result = (body: AsyncIterable<string>) => ({ version: 1, requestId: id, ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body });
describe('streaming scope broker server', () => {
  it('delivers a first chunk before upstream completion and accepts over 1MiB in bounded frames', async () => {
    const first = deferred(); const proceed = deferred();
    const path = await fixture(async () => result((async function* () {
      yield 'first'; await proceed.promise; for (let n = 0; n < 33; n++) yield 'x'.repeat(64 * 1024);
    })()));
    const reply = exchange(path, request, frame => { if (frame.stream === 'chunk' && frame.sequence === 0) first.resolve(); });
    await Promise.race([first.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('not incremental')), 1000))]);
    proceed.resolve(); const frames = await reply;
    for (const frame of frames) expect(ScopeRuntimeInferenceStreamFrameSchema.safeParse(frame).success).toBe(true);
    expect(frames[0]?.stream).toBe('start'); expect(frames.at(-1)).toMatchObject({ stream: 'end', sequence: 34 });
    expect(frames.filter(f => f.stream === 'chunk').map(f => f.body).join('').length).toBe(33 * 64 * 1024 + 5);
  });
  it('aborts its transport authority when the consumer closes after a chunk', async () => {
    const aborted = deferred();
    const path = await fixture(async (_raw, signal) => result((async function* () {
      yield 'first'; await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
    })()));
    await exchange(path, request, (frame, socket) => { if (frame.stream === 'chunk') socket.destroy(); });
    await Promise.race([aborted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not cancelled')), 1000))]);
  });
  it('does not send a successful end after an upstream failure', async () => {
    const path = await fixture(async () => result((async function* () { yield 'partial'; throw new Error('fixture failure'); })()));
    const frames = await exchange(path, request);
    expect(frames.some(f => f.stream === 'chunk')).toBe(true); expect(frames.some(f => f.stream === 'end')).toBe(false);
  });
  it('refuses oversized chunks and never streams a control response', async () => {
    const path = await fixture(async () => result((async function* () { yield 'x'.repeat(64 * 1024 + 1); })()));
    const frames = await exchange(path, request); expect(frames.some(f => f.stream === 'end')).toBe(false);
    const control = await exchange(path, { ...request, action: 'bot.session.load' }); expect(control).toEqual([]);
  });
});
