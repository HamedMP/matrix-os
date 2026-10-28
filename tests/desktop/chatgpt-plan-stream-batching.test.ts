import { generateKeyPairSync } from 'node:crypto';
import { INFERENCE_RESPONSE_CHUNK_MAX_BYTES, chatGptPlanPeerRequestId } from '@matrix-os/contracts';
import { expect, it, vi } from 'vitest';
import { createPlanNativePeer } from '../../desktop/src/main/chatgpt-plan/peer';
import { requestPlanResponseStream } from '../../desktop/src/main/chatgpt-plan/responses';

const model = 'fixture-model';
const sessionId = '00000000-0000-4000-8000-000000000001';
const requestId = chatGptPlanPeerRequestId(sessionId, 1);
const body = JSON.stringify({ model, input: [{ role: 'user', content: 'Offline fixture' }], store: false, stream: true });
const key = generateKeyPairSync('ed25519');
const binding = {
  runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer',
  origin: 'https://matrix.test', bearer: 'fixture',
  privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
};
const delta = (value: string) =>
  `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: value })}\n\n`;
const completion = `event: response.completed\ndata: ${JSON.stringify({
  type: 'response.completed', response: { status: 'completed', model },
})}\n\ndata: [DONE]\n\n`;

it('delivers a single provider read of many small deltas in bounded peer replies and gates completion on EOF', async () => {
  const ordinary = Array.from({ length: 128 }, (_, index) => delta(`healthy line ${index}\n`)).join('');
  const source = new TextEncoder().encode(ordinary + completion);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const provider = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; controller.enqueue(source); },
  }), { headers: { 'content-type': 'text/event-stream' } });
  let closed = false;
  const closeProvider = () => { if (!closed) { closed = true; controller.close(); } };
  const replies: Array<{ ok: boolean; stream?: string; sequence?: number; body?: string }> = [];
  let polls = 0;
  const peer = createPlanNativePeer({
    current: () => true,
    connected: vi.fn(),
    infer: vi.fn(async () => { throw new Error('unexpected one-shot inference'); }),
    inferStream: (_request, signal) => requestPlanResponseStream({
      fetchFn: vi.fn(async () => provider) as typeof fetch,
      body, model, signal, accessToken: async () => 'fixture-token', validate: () => undefined,
    }),
    fetchFn: vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname.split('/').at(-1);
      if (path === 'challenge') return Response.json({ version: 1, challenge: 'a'.repeat(64),
        ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      if (path === 'connect') return Response.json({ version: 1, sessionId });
      if (path === 'poll') {
        if (polls++ === 0) return Response.json({ version: 1, requests: [{
          version: 1, action: 'infer', responseMode: 'stream', id: requestId, sequence: 1,
          expiresAt: new Date(Date.now() + 120_000).toISOString(), accountId: 'account',
          grantRevision: 1, computerId: 'computer', requestClass: 'interactive',
          runId: 'run', model, body,
        }] });
        if (!init!.signal!.aborted) await new Promise<void>(resolve =>
          init!.signal!.addEventListener('abort', () => resolve(), { once: true }));
        return Response.json({ version: 1, requests: [] });
      }
      if (path === 'reply') {
        const reply = JSON.parse(String(init?.body)) as typeof replies[number];
        replies.push(reply);
        return Response.json({ version: 1, ok: true, sessionId, id: requestId, sequence: reply.sequence });
      }
      if (path === 'disconnect') return Response.json({ ok: true });
      throw new Error(`unexpected path ${path}`);
    }) as typeof fetch,
  });
  try {
    await peer.start(binding, { deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1,
      enabled: true, background: false, models: [{
        id: model, displayName: 'Fixture', input: ['text'], contextWindow: 8192, maxOutputTokens: 256,
      }] });
    await vi.waitFor(() => {
      expect(replies.filter(reply => reply.stream === 'chunk').map(reply => reply.body).join('')).toBe(ordinary);
    }, { timeout: 3_000 });
    expect(replies.some(reply => reply.stream === 'end' || reply.body?.includes('response.completed'))).toBe(false);
    closeProvider();
    await vi.waitFor(() => expect(replies.some(reply => reply.stream === 'end')).toBe(true), { timeout: 3_000 });
    const chunks = replies.filter(reply => reply.stream === 'chunk');
    expect(chunks.length).toBeLessThan(12); // 128 visible lines should not need 128 HTTP ACKs.
    expect(chunks.map(reply => reply.body).join('')).toBe(ordinary + completion);
    expect(chunks.every(reply => Buffer.byteLength(reply.body ?? '') <= INFERENCE_RESPONSE_CHUNK_MAX_BYTES)).toBe(true);
    expect(replies.map(reply => reply.sequence)).toEqual(replies.map((_, index) => index));
    expect(replies.at(-1)).toMatchObject({ stream: 'end', sequence: chunks.length });
  } finally {
    closeProvider();
    await peer.stop();
  }
});
