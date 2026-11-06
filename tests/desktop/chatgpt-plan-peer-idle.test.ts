import { generateKeyPairSync } from 'node:crypto';
import { chatGptPlanPeerRequestId } from '@matrix-os/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createPlanNativePeer } from '../../desktop/src/main/chatgpt-plan/peer';

const sessionId = '00000000-0000-4000-8000-000000000001';
const id = chatGptPlanPeerRequestId(sessionId, 1);
const key = generateKeyPairSync('ed25519');
const binding = { runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer',
  origin: 'https://matrix.test', bearer: 'fixture',
  privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Peer did not reach the expected state');
}

function controlledTimeouts() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    // Keep the unrelated long poll parked while advancing the inference clock.
    if (milliseconds !== 15_000) setTimeout(() =>
      controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
}

async function peerFixture(inferStream: (_request: unknown, signal: AbortSignal, progress?: () => void) => AsyncIterable<string>) {
  const replies: Array<{ ok: boolean; stream?: string; sequence?: number; body?: string; error?: string }> = [];
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  let polled = false;
  const peer = createPlanNativePeer({
    current: () => true, connected: vi.fn(),
    infer: vi.fn(async () => { throw new Error('unexpected legacy inference'); }),
    inferStream,
    fetchFn: vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname.split('/').at(-1);
      if (path === 'challenge') return Response.json({ version: 1, challenge: 'a'.repeat(64),
        ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      if (path === 'connect') return Response.json({ version: 1, sessionId });
      if (path === 'poll') {
        if (!polled) {
          polled = true;
          return Response.json({ version: 1, requests: [{
            version: 1, action: 'infer', responseMode: 'stream', id, sequence: 1, expiresAt,
            accountId: 'account', grantRevision: 1, computerId: 'computer', requestClass: 'interactive',
            runId: 'run', model: 'model', body: '{}',
          }] });
        }
        if (!init!.signal!.aborted) await new Promise<void>(resolve =>
          init!.signal!.addEventListener('abort', () => resolve(), { once: true }));
        return Response.json({ version: 1, requests: [] });
      }
      if (path === 'reply') {
        const reply = JSON.parse(String(init?.body)) as typeof replies[number];
        replies.push(reply);
        return Response.json({ version: 1, ok: true, sessionId, id, sequence: reply.sequence });
      }
      if (path === 'disconnect') return Response.json({ ok: true });
      throw new Error(`unexpected peer path ${path}`);
    }) as typeof fetch,
  });
  await peer.start(binding, { deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1,
    enabled: true, background: false, models: [{
      id: 'model', displayName: 'Fixture', input: ['text'], contextWindow: 8192, maxOutputTokens: 256,
    }] });
  return { peer, replies, expiresAt };
}

it('keeps an admitted stream alive past request expiry when provider reads progress between replies', async () => {
  controlledTimeouts();
  let releaseRead!: () => void;
  const read = new Promise<void>(resolve => { releaseRead = resolve; });
  let releaseEnd!: () => void;
  const end = new Promise<void>(resolve => { releaseEnd = resolve; });
  const x = await peerFixture(async function* (_request, _signal, progress) {
    yield 'first';
    await read;
    progress?.(); // A provider read may contain only part of an SSE event.
    await end;
    yield 'last';
  });
  try {
    await until(() => x.replies.length === 1);
    await vi.advanceTimersByTimeAsync(70_000);
    releaseRead();
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(70_000);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 140_001);
    expect(Date.now()).toBeGreaterThan(Date.parse(x.expiresAt));
    releaseEnd();
    await until(() => x.replies.some(reply => reply.stream === 'end' || reply.ok === false));
    clock.mockRestore();
    expect(x.replies.map(reply => reply.stream)).toEqual(['chunk', 'chunk', 'end']);
  } finally {
    releaseRead(); releaseEnd();
    await x.peer.stop();
  }
});

it('ends a truly idle stream at 120 seconds without a success end', async () => {
  controlledTimeouts();
  const x = await peerFixture(async function* (_request, signal) {
    yield 'first';
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  try {
    await until(() => x.replies.length === 1);
    await vi.advanceTimersByTimeAsync(120_001);
    await until(() => x.replies.some(reply => reply.ok === false));
    expect(x.replies.some(reply => reply.stream === 'end')).toBe(false);
  } finally {
    await x.peer.stop();
  }
});

it('does not extend a stream lifetime for empty yielded chunks', async () => {
  controlledTimeouts();
  let releaseEmpty!: () => void;
  const empty = new Promise<void>(resolve => { releaseEmpty = resolve; });
  let emptyConsumed = false;
  const x = await peerFixture(async function* (_request, signal) {
    yield 'first';
    await empty;
    yield '';
    emptyConsumed = true;
    await new Promise<void>(resolve => signal.addEventListener('abort', resolve, { once: true }));
  });
  try {
    await until(() => x.replies.length === 1);
    await vi.advanceTimersByTimeAsync(70_000);
    releaseEmpty();
    await until(() => emptyConsumed);
    await vi.advanceTimersByTimeAsync(50_001);
    await until(() => x.replies.some(reply => reply.ok === false));
    expect(x.replies.some(reply => reply.stream === 'end')).toBe(false);
  } finally {
    releaseEmpty();
    await x.peer.stop();
  }
});

it('Stop aborts an admitted stream before its next chunk or end', async () => {
  controlledTimeouts();
  let aborted = false;
  const x = await peerFixture(async function* (_request, signal) {
    yield 'first';
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    yield 'late';
  });
  try {
    await until(() => x.replies.length === 1);
    await x.peer.stop();
    expect(aborted).toBe(true);
    expect(x.replies.map(reply => reply.stream)).toEqual(['chunk']);
  } finally {
    await x.peer.stop();
  }
});
