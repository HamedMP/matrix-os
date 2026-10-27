import { generateKeyPairSync } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { chatGptPlanPeerRequestId, INFERENCE_RESPONSE_CHUNK_MAX_BYTES } from '@matrix-os/contracts';
import { createPlanNativePeer } from '../../desktop/src/main/chatgpt-plan/peer';
import { requestPlanResponseStream } from '../../desktop/src/main/chatgpt-plan/responses';

it('coalesces small provider reads during a slow ACK instead of spending one RTT per delta', async () => {
  vi.useFakeTimers();
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const id = chatGptPlanPeerRequestId(sessionId, 1);
  const keys = generateKeyPairSync('ed25519');
  const binding = {
    runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer',
    origin: 'https://fixture.invalid', bearer: 'fixture',
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  };
  const replyTimes: number[] = [], delivered: string[] = [];
  let ended = false, dispatched = false, upstreamReadCount = 0, inferenceCalls = 0;
  const encoder = new TextEncoder();
  const frames = Array.from({ length: 200 }, () =>
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'five ' })}\n\n`);
  frames.push(`data: ${JSON.stringify({
    type: 'response.completed', response: { status: 'completed', model: 'model' },
  })}\n\n`);
  const expected = frames.join('');
  // All output exists before the peer starts. No model or renderer is involved.
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames.shift();
      if (frame === undefined) controller.close();
      else { upstreamReadCount++; controller.enqueue(encoder.encode(frame)); }
    },
  }, { highWaterMark: 0 });
  const started = Date.now();
  const peer = createPlanNativePeer({
    current: () => true, connected: () => {},
    infer: async () => { throw Error('unexpected one-shot'); },
    inferStream: (_request, signal, progress) => requestPlanResponseStream({
      body: JSON.stringify({ model: 'model', input: [{ role: 'user', content: 'synthetic' }], store: false, stream: true }),
      model: 'model', signal, accessToken: async () => 'fixture', validate: () => {},
      fetchFn: async () => { inferenceCalls++; return new Response(upstream); },
    }, true, progress),
    fetchFn: async (input, init) => {
      const path = new URL(String(input)).pathname.split('/').at(-1);
      if (path === 'challenge') return Response.json({
        version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      if (path === 'connect') return Response.json({ version: 1, sessionId });
      if (path === 'disconnect') return Response.json({ ok: true });
      if (path === 'poll') {
        if (!dispatched) {
          dispatched = true;
          return Response.json({ version: 1, requests: [{
            version: 1, action: 'infer', id, sequence: 1,
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            accountId: 'account', grantRevision: 1, computerId: 'computer',
            requestClass: 'interactive', runId: 'run', model: 'model', body: '{}', responseMode: 'stream',
          }] });
        }
        const signal = init!.signal!;
        if (!signal.aborted) await new Promise<void>(resolve =>
          signal.addEventListener('abort', () => resolve(), { once: true }));
        return Response.json({ version: 1, requests: [] });
      }
      if (path === 'reply') {
        const reply = JSON.parse(String(init?.body));
        if (reply.stream === 'chunk') delivered.push(reply.body);
        replyTimes.push(Date.now() - started);
        await new Promise(resolve => setTimeout(resolve, 500));
        if (reply.stream === 'end') ended = true;
        return Response.json({ version: 1, ok: true, sessionId, id, sequence: reply.sequence });
      }
      throw Error('unexpected route');
    },
  });
  try {
    await peer.start(binding, {
      deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1, enabled: true, background: false,
      models: [{ id: 'model', displayName: 'Model', input: ['text'], contextWindow: 8192, maxOutputTokens: 4096 }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(replyTimes).toEqual([0]);
    await vi.advanceTimersByTimeAsync(49);
    expect(replyTimes).toHaveLength(1); expect(upstreamReadCount).toBeGreaterThan(100);
    for (let i = 0; i < 4 && !ended; i++) await vi.advanceTimersByTimeAsync(500);
    expect(ended).toBe(true); expect(replyTimes.length).toBeLessThanOrEqual(4);
    expect(Date.now() - started).toBeLessThan(2100);
    expect(delivered.join('')).toBe(expected);
    expect(delivered.every(value => Buffer.byteLength(value) <= INFERENCE_RESPONSE_CHUNK_MAX_BYTES)).toBe(true);
    expect(inferenceCalls).toBe(1);
  } finally { await peer.stop(); vi.useRealTimers(); }
});
