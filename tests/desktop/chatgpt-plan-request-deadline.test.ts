import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { chatGptPlanPeerRequestId } from '@matrix-os/contracts';
import { createPlanNativePeer } from '../../desktop/src/main/chatgpt-plan/peer';
import { deliveryRequest, nativeDeliveryFixture } from './chatgpt-plan-poll-support';
import { PlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
import { sendNativeStreamReply } from '../../desktop/src/main/chatgpt-plan/reply-delivery';

afterEach(() => vi.restoreAllMocks());

/** Exercise the actual POST deadline; advance its signal, not the model's clock. */
function controlledDeadlines(milliseconds: number) {
  const original = AbortSignal.timeout;
  const controllers: AbortController[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    if (ms !== milliseconds) return original(ms);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  return controllers;
}

it.each([
  ['before_headers', 'chunk', true], ['body_read', 'chunk', true],
  ['before_headers', 'end', true], ['body_read', 'end', true],
  ['before_headers', 'chunk', false],
] as const)(
  'handles own POST deadline at %s for %s with reply-v2=%s', async (phase, lostKind, enabled) => {
    const deadlines = controlledDeadlines(10_000);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const id = chatGptPlanPeerRequestId(sessionId, 1);
    const key = generateKeyPairSync('ed25519');
    const frames: string[] = [];
    let polls = 0, lost = false, endAcknowledged = false;
    const inferStream = vi.fn(async function* () { yield 'data: first\n\n'; yield 'data: second\n\n'; });
    const peer = createPlanNativePeer({
      deliveryVersion: 2, current: () => true, connected: () => {},
      infer: async () => { throw new Error('No model replay'); }, inferStream,
      fetchFn: vi.fn(async (url, init) => {
        const path = new URL(String(url)).pathname.split('/').at(-1);
        if (path === 'challenge') return Response.json({ version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60_000).toISOString() });
        if (path === 'connect') return Response.json({ version: 1, sessionId });
        if (path === 'capabilities') return Response.json({ version: 1, sessionId, pollDeliveryVersion: 2, ...(enabled ? { replyDeliveryVersion: 2 } : {}) });
        if (path === 'poll-v2') {
          const input = JSON.parse(String(init?.body));
          if (polls++ === 0) return Response.json({ version: 2, sessionId, acknowledgedThrough: 0,
            deliveries: [{ deliverySequence: 1, request: { ...deliveryRequest(1), id, responseMode: 'stream' } }] });
          if (!init!.signal!.aborted) await new Promise<void>(resolve => init!.signal!.addEventListener('abort', () => resolve(), { once: true }));
          return Response.json({ version: 2, sessionId, acknowledgedThrough: input.ackThrough, deliveries: [] });
        }
        if (path === 'reply') {
          const encoded = String(init?.body), frame = JSON.parse(encoded);
          frames.push(encoded);
          if (frame.stream === lostKind && !lost) {
            lost = true;
            const deadline = deadlines.at(-1)!;
            setTimeout(() => deadline.abort(new DOMException('Own POST deadline', 'TimeoutError')), 0);
            return phase === 'body_read' ? new Response(new ReadableStream({}))
              : await new Promise<Response>(() => {});
          }
          if (frame.stream === 'end') endAcknowledged = true;
          return Response.json({ version: 1, ok: true, sessionId, id, sequence: frame.sequence });
        }
        if (path === 'disconnect') return Response.json({ ok: true });
        throw new Error('Unexpected fixture route');
      }) as typeof fetch,
    });
    try {
      await peer.start({ runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer', origin: 'https://matrix.test', bearer: 'fixture',
        privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') },
      { deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1, enabled: true, background: false,
        models: [{ id: 'model', displayName: 'Fixture', input: ['text'], contextWindow: 8192, maxOutputTokens: 256 }] });
      await vi.waitFor(() => expect(endAcknowledged || frames.some(text => !JSON.parse(text).ok)).toBe(true), { timeout: 1_000 });
      const chunks = frames.filter(text => JSON.parse(text).stream === 'chunk');
      expect(chunks).toHaveLength(enabled ? lostKind === 'chunk' ? 3 : 2 : 1);
      const repeated = frames.filter(text => JSON.parse(text).stream === lostKind && JSON.parse(text).sequence === (lostKind === 'chunk' ? 0 : 2));
      expect(repeated).toHaveLength(enabled ? 2 : 1);
      if (enabled) expect(repeated[0]).toBe(repeated[1]);
      expect(inferStream).toHaveBeenCalledOnce();
      expect(frames.some(text => !JSON.parse(text).ok)).toBe(!enabled);
    } finally { await peer.stop(); }
  },
);

it('retries one own v2 poll deadline with the same cursor and keeps the active inference', async () => {
  const deadlines = controlledDeadlines(15_000);
  const f = nativeDeliveryFixture({ steps: [() => {
    const deadline = deadlines.at(-1)!;
    setTimeout(() => deadline.abort(new DOMException('Own poll deadline', 'TimeoutError')), 0);
    return new Promise<Response>(() => {});
  }, () => Response.json({ version: 2, sessionId: f.sessionId, acknowledgedThrough: 1, deliveries: [] })] });
  try {
    await f.start();
    await vi.waitFor(() => expect(f.polls.length >= 4 || f.state.closed).toBe(true), { interval: 2 });
    expect(f.polls).toHaveLength(4);
    expect(f.polls[1]).toEqual(f.polls[2]);
    expect(f.state.executions).toBe(1);
    expect(f.state.signal?.aborted).toBe(false);
    f.release.resolve();
    await vi.waitFor(() => expect(f.replies.some(reply => reply.stream === 'end')).toBe(true), { interval: 2 });
  } finally { await f.close(); }
});

it.each([
  new DOMException('Foreign timeout', 'TimeoutError'),
  new PlanFailure('peer_reply', 'timeout'),
  new PlanFailure('responses', 'timeout', undefined, undefined, { phase: 'before_headers' }),
  new PlanFailure('peer_reply', 'timeout', undefined, undefined, { phase: 'post_read_binding' }),
  new PlanFailure('peer_reply', 'timeout', undefined, undefined, { phase: 'body_read', code: 'CERT_HAS_EXPIRED' }),
  new PlanFailure('peer_reply', 'timeout', undefined, undefined, { phase: 'before_headers', chromiumCode: 'ERR_ACCESS_DENIED' }),
])('does not treat foreign, untagged or wrong-boundary timeouts as a receipt retry', async error => {
  const post = vi.fn(async () => { throw error; });
  await expect(sendNativeStreamReply({ enabled: true, signal: new AbortController().signal, current: () => true, post })).rejects.toBe(error);
  expect(post).toHaveBeenCalledOnce();
});

it('does not add timeout replay to a legacy reply connection', async () => {
  const failure = new PlanFailure('peer_reply', 'timeout', undefined, undefined, { phase: 'body_read' });
  const post = vi.fn(async () => { throw failure; });
  await expect(sendNativeStreamReply({ enabled: false, signal: new AbortController().signal, current: () => true, post })).rejects.toBe(failure);
  expect(post).toHaveBeenCalledOnce();
});

it.each(['cancel', 'timeout', 'source'] as const)('keeps parent %s authoritative over an own reply timeout', async mode => {
  const controller = new AbortController();
  let current = true;
  const post = vi.fn(async () => {
    if (mode !== 'source') controller.abort(new DOMException('Caller ended', mode === 'cancel' ? 'AbortError' : 'TimeoutError'));
    else current = false;
    throw new PlanFailure('peer_reply', 'timeout', undefined, undefined, { phase: 'body_read' });
  });
  await expect(sendNativeStreamReply({ enabled: true, signal: controller.signal, current: () => current, post })).rejects.toMatchObject(
    mode !== 'source' ? { name: mode === 'cancel' ? 'AbortError' : 'TimeoutError' } : { stage: 'peer_reply', category: 'stale_source' },
  );
  expect(post).toHaveBeenCalledOnce();
});

it.each(['cancel', 'source'] as const)('rechecks %s after an ACK before returning to the stream', async mode => {
  const controller = new AbortController(); let current = true;
  const post = vi.fn(async () => {
    if (mode === 'cancel') controller.abort(); else current = false;
    return 'ack';
  });
  await expect(sendNativeStreamReply({ enabled: true, signal: controller.signal, current: () => current, post })).rejects.toThrow();
  expect(post).toHaveBeenCalledOnce();
});

it.each(['certificate', 'schema', 'cancel'] as const)('does not tag a coincident %s as its own POST deadline', async mode => {
  const deadlines = controlledDeadlines(10_000), key = generateKeyPairSync('ed25519');
  let stopping: Promise<void> | undefined;
  const peer = createPlanNativePeer({ deliveryVersion: 2, current: () => true, connected: () => {},
    infer: async () => { throw new Error('No inference'); },
    fetchFn: ((input) => {
      const path = new URL(String(input)).pathname.split('/').at(-1);
      if (path === 'challenge') return Promise.resolve(Response.json({ version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      if (path === 'connect') return Promise.resolve(Response.json({ version: 1, sessionId: '00000000-0000-4000-8000-000000000001' }));
      if (path === 'disconnect') return Promise.resolve(Response.json({ ok: true }));
      if (path !== 'capabilities') throw new Error('No model request permitted');
      const deadline = deadlines.at(-1)!;
      if (mode === 'cancel') stopping = peer.stop();
      deadline.abort(new DOMException('Own deadline', 'TimeoutError'));
      // Both promises are settled before race attaches; its first input retains
      // the original foreign error without leaving the deadline unobserved.
      if (mode === 'certificate') return Promise.reject(new Error('net::ERR_CERT_AUTHORITY_INVALID'));
      if (mode === 'schema') return Promise.reject(new SyntaxError('Foreign malformed data'));
      return Promise.reject(deadline.signal.reason);
    }) as typeof fetch,
  });
  try {
    const failure = await peer.start({ runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer', origin: 'https://matrix.test', bearer: 'fixture',
      privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') },
    { deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1, enabled: true, background: false,
      models: [{ id: 'model', displayName: 'Fixture', input: ['text'], contextWindow: 8192, maxOutputTokens: 256 }] }).then(() => { throw new Error('Expected failure'); }, error => error);
    expect(failure).toBeInstanceOf(PlanFailure);
    expect(failure.networkDiagnostic).toBeUndefined();
    expect(failure.category).toBe(mode === 'cancel' ? 'cancelled' : 'timeout');
  } finally { await stopping; await peer.stop(); }
});

it('spends only the existing single retry when own reply deadlines repeat', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = new PlanFailure('peer_reply', 'timeout', undefined, undefined, { phase: 'body_read' });
  const post = vi.fn(async () => { throw failure; });
  await expect(sendNativeStreamReply({ enabled: true, signal: new AbortController().signal, current: () => true, post })).rejects.toBe(failure);
  expect(post).toHaveBeenCalledTimes(2);
});
