import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createPlanNativePeer } from '../../desktop/src/main/chatgpt-plan/peer';
import { PlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';

afterEach(() => vi.restoreAllMocks());

const sessionId = '10000000-0000-4000-8000-000000000001';
const keys = generateKeyPairSync('ed25519');
const binding = {
  runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer',
  origin: 'https://fixture.test', bearer: 'fixture-secret',
  privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
};
const snapshot = {
  deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1, enabled: true, background: false,
  models: [{ id: 'fixture-model', displayName: 'Fixture', input: ['text' as const], contextWindow: 8192, maxOutputTokens: 256 }],
};

it.each([
  ['ack timeout', 'peer_reply', 'timeout'],
  ['ack body timeout', 'peer_reply', 'timeout'],
  ['ack network failure', 'peer_reply', 'network_error'],
  ['invalid ack identity', 'peer_reply', 'invalid_schema'],
  ['upstream timeout', 'responses', 'timeout'],
] as const)('distinguishes %s without retaining private request or error text', async (mode, stage, category) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let polls = 0, failureReplies = 0, successfulPosts = 0, sourceClosed = false;
  const request = {
    version: 1, action: 'infer', responseMode: 'stream',
    id: `${sessionId.slice(0, 24)}000000000001`, sequence: 1,
    expiresAt: new Date(Date.now() + 120000).toISOString(), accountId: 'account', grantRevision: 1,
    computerId: '30000000-0000-4000-8000-000000000001', requestClass: 'interactive',
    runId: 'run_0123456789abcdef0123456789abcdef', model: 'fixture-model',
    body: JSON.stringify({ model: 'fixture-model', input: [{ role: 'user', content: 'private fixture prompt' }], stream: true }),
  };
  const peer = createPlanNativePeer({
    current: () => true, connected: vi.fn(), infer: async () => { throw new Error('legacy inference forbidden'); },
    inferStream: async function* () {
      try {
        if (mode === 'upstream timeout') throw new PlanFailure('responses', 'timeout');
        yield 'data: {"type":"response.output_text.delta","delta":"private fixture response"}\n\n';
        throw new Error('must stop after failed ACK');
      } finally { sourceClosed = true; }
    },
    fetchFn: (async (url, init) => {
      const action = new URL(String(url)).pathname.split('/').at(-1);
      if (action === 'challenge') return Response.json({ version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60000).toISOString() });
      if (action === 'connect') return Response.json({ version: 1, sessionId });
      if (action === 'poll') {
        if (polls++ === 0) return Response.json({ version: 1, requests: [request] });
        await new Promise<void>(resolve => {
          const signal = init!.signal!;
          signal.addEventListener('abort', () => resolve(), { once: true });
          if (signal.aborted) resolve();
        });
        return Response.json({ version: 1, requests: [] });
      }
      if (action === 'reply') {
        const value = JSON.parse(String(init?.body));
        if (!value.ok) { failureReplies++; return Response.json({ version: 1, ok: true }); }
        successfulPosts++;
        if (mode === 'ack timeout') throw new DOMException('private timeout detail', 'TimeoutError');
        if (mode === 'ack network failure') throw new TypeError('private host/path detail');
        if (mode === 'ack body timeout') return new Response(new ReadableStream({
          start(controller) { controller.error(new DOMException('private body detail', 'TimeoutError')); },
        }));
        return Response.json({ version: 1, ok: true, sessionId, id: '20000000-0000-4000-8000-000000000001', sequence: value.sequence });
      }
      if (action === 'disconnect') return Response.json({ version: 1, ok: true });
      throw new Error('unexpected fixture action');
    }) as typeof fetch,
  });
  try {
    await peer.start(binding, snapshot);
    await vi.waitFor(() => expect(failureReplies).toBe(1));
    expect(sourceClosed).toBe(true);
    expect(successfulPosts).toBe(mode === 'upstream timeout' ? 0 : 1);
    const failures = warning.mock.calls.map(call => String(call[0])).filter(log => log.includes(request.runId));
    expect(failures).toHaveLength(1);
    const log = failures[0]!;
    expect(log).toContain(`[chatgpt-plan] ${stage}: ${category}`);
    expect(log).toContain(request.runId);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('fixture-secret');
  } finally { await peer.stop(); }
});
