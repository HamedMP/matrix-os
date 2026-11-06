import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { requestPlanResponse, requestPlanResponseStream } from '../../desktop/src/main/chatgpt-plan/responses';
import { createPlanNativePeer } from '../../desktop/src/main/chatgpt-plan/peer';
import { INFERENCE_RESPONSE_BUFFER_MAX_BYTES, INFERENCE_RESPONSE_CHUNK_MAX_BYTES } from '@matrix-os/contracts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const model = 'fixture-model';
const body = JSON.stringify({ model, input: [{ role: 'user', content: 'fixture only' }], store: false, stream: true });
const completion = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model } })}\n\n`;
const delta = (value: string) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: value })}\n\n`;
const input = (response: Response, signal = new AbortController().signal) => ({
  fetchFn: vi.fn(async () => response) as typeof fetch, body, model, signal,
  accessToken: async () => 'fixture-token', validate: vi.fn(),
});

it('streams many bounded Unicode chunks beyond the legacy cumulative response cap', async () => {
  const text = Array.from({ length: 40 }, () => delta('🧪'.repeat(8_000))).join('') + completion;
  expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
  const chunks: string[] = [];
  for await (const chunk of requestPlanResponseStream(input(new Response(text)))) {
    expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(64 * 1024);
    chunks.push(chunk);
  }
  expect(chunks.join('')).toBe(text);
  await expect(requestPlanResponse(input(new Response(text)))).rejects.toMatchObject({ category: 'response_too_large' });
});

it('holds completion until EOF and rejects late error without publishing terminal text', async () => {
  let close!: () => void;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(delta('hello') + completion));
    close = () => { controller.enqueue(new TextEncoder().encode('data: {"type":"response.failed"}\n\n')); controller.close(); };
  } });
  const iterator = requestPlanResponseStream(input(new Response(stream)))[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ done: false, value: delta('hello') });
  const pending = iterator.next();
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  close();
  await expect(pending).rejects.toMatchObject({ category: 'incomplete_stream' });
});

it('does not treat [DONE] as EOF when a late failure arrives before the source closes', async () => {
  let failSource!: () => void;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(delta('safe') + completion + 'data: [DONE]\n\n'));
    failSource = () => { controller.enqueue(new TextEncoder().encode('data: {"type":"error"}\n\n')); controller.close(); };
  } });
  const iterator = requestPlanResponseStream(input(new Response(stream)))[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ done: false, value: delta('safe') });
  const terminal = iterator.next();
  let settled = false; void terminal.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  failSource();
  await expect(terminal).rejects.toMatchObject({ category: 'incomplete_stream' });
});

it.each([
  ['early DONE followed by completion', 'data: [DONE]\n\n' + completion],
  ['duplicate DONE', completion + 'data: [DONE]\n\ndata: [DONE]\n\n'],
])('rejects %s without releasing a terminal chunk', async (_name, text) => {
  const iterator = requestPlanResponseStream(input(new Response(text)))[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toMatchObject({ category: 'incomplete_stream' });
});

it('rejects malformed UTF-8 instead of replacing bytes in a trusted reply', async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"'),
    0xc3, 0x28, ...new TextEncoder().encode('"}\n\n' + completion)]);
  const iterator = requestPlanResponseStream(input(new Response(bytes)))[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toMatchObject({ category: 'invalid_stream' });
});

it('rejects one oversized SSE event even when the cumulative stream is uncapped', async () => {
  const text = delta('a'.repeat(1024 * 1024)) + completion;
  const iterator = requestPlanResponseStream(input(new Response(text)));
  await expect((async () => { for await (const _ of iterator) { /* drain */ } })()).rejects.toMatchObject({ category: 'response_too_large' });
});

it.each(['response.completed', 'response.output_item.done'])('bounds a full %s event at exactly one MiB', async type => {
  const frame = (padding: string) => `data: ${JSON.stringify(type === 'response.completed'
    ? { type, response: { status: 'completed', model, output: padding } }
    : { type, item: { content: padding } })}\n\n`;
  const exact = frame('a'.repeat(INFERENCE_RESPONSE_BUFFER_MAX_BYTES - Buffer.byteLength(frame(''))));
  expect(Buffer.byteLength(exact)).toBe(INFERENCE_RESPONSE_BUFFER_MAX_BYTES);
  const valid = type === 'response.completed' ? exact : exact + completion;
  const output: string[] = [];
  for await (const chunk of requestPlanResponseStream(input(new Response(valid)))) output.push(chunk);
  expect(output.join('')).toBe(valid);
  const oversized = frame('a'.repeat(INFERENCE_RESPONSE_BUFFER_MAX_BYTES + 1 - Buffer.byteLength(frame(''))));
  const invalid = requestPlanResponseStream(input(new Response(oversized + (type === 'response.completed' ? '' : completion))));
  await expect((async () => { for await (const _ of invalid) { /* drain */ } })())
    .rejects.toMatchObject({ category: 'response_too_large' });
});

const sessionId = '00000000-0000-4000-8000-000000000001';
const key = generateKeyPairSync('ed25519');
const binding = { runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer', origin: 'https://matrix.test', bearer: 'fixture', privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
const peerRequest = { version: 1, action: 'infer', responseMode: 'stream', id: `${sessionId.slice(0, 24)}000000000001`, sequence: 1,
  expiresAt: new Date(Date.now() + 120000).toISOString(), accountId: 'account', grantRevision: 1, computerId: 'computer', requestClass: 'interactive', runId: 'run', model, body };

it('serializes reply ACKs with bounded read-ahead and discards unsent chunks on 409', async () => {
  const posted: Array<Record<string, unknown>> = [];
  const pulls: number[] = [];
  let pollCount = 0, sourceClosed = false;
  let releaseAck!: () => void;
  const ack = new Promise<void>(resolve => { releaseAck = resolve; });
  const chunks = Array.from({ length: 6 }, (_, index) =>
    delta(String(index).repeat(INFERENCE_RESPONSE_CHUNK_MAX_BYTES - Buffer.byteLength(delta('')))));
  expect(chunks.every(chunk => Buffer.byteLength(chunk) === INFERENCE_RESPONSE_CHUNK_MAX_BYTES)).toBe(true);
  const inferStream = vi.fn(async function* () {
    try {
      for (const [index, chunk] of chunks.entries()) { pulls.push(index); yield chunk; }
      yield completion;
    } finally { sourceClosed = true; }
  });
  const peer = createPlanNativePeer({ current: () => true, connected: vi.fn(), infer: vi.fn(async () => { throw new Error('legacy infer called'); }), inferStream,
    fetchFn: vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname.split('/').at(-1);
      if (path === 'challenge') return Response.json({ version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60000).toISOString() });
      if (path === 'connect') return Response.json({ version: 1, sessionId });
      if (path === 'poll') {
        if (pollCount++ === 0) return Response.json({ version: 1, requests: [peerRequest] });
        await new Promise<void>(resolve => init!.signal!.addEventListener('abort', () => resolve(), { once: true }));
        return Response.json({ version: 1, requests: [] });
      }
      if (path === 'reply') {
        const value = JSON.parse(String(init?.body)); posted.push(value);
        if (posted.length === 1) await ack;
        return posted.length === 2 ? new Response('', { status: 409 }) : Response.json({ version: 1, ok: true, sessionId, id: value.id, sequence: value.sequence });
      }
      if (path === 'disconnect') return Response.json({ ok: true });
      throw new Error(`unexpected path ${path}`);
    }) as typeof fetch });
  try {
    await peer.start(binding, { deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1, enabled: true, background: false,
      models: [{ id: model, displayName: 'Model', input: ['text'], contextWindow: 8192, maxOutputTokens: 256 }] });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    await vi.waitFor(() => expect(pulls.length).toBeGreaterThan(1));
    // One in-flight, one pending and at most one held source item, each 64KiB.
    expect(pulls.length).toBeLessThanOrEqual(3);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: true, stream: 'chunk', sequence: 0, body: chunks[0] });
    releaseAck();
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ ok: true, stream: 'chunk', sequence: 1, body: chunks[1] });
    await vi.waitFor(() => expect(sourceClosed).toBe(true));
    // The first chunk was consumed; only three more items may be retained.
    expect(pulls.length).toBeLessThanOrEqual(4);
    const stoppedPulls = [...pulls];
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(posted).toHaveLength(2);
    expect(pulls).toEqual(stoppedPulls);
    expect(posted.some(reply => reply.stream === 'end')).toBe(false);
    expect(inferStream).toHaveBeenCalledTimes(1);
  } finally { releaseAck(); await peer.stop(); }
});

it.each(['complete', 'wrong-ack', 'missing-handler'] as const)('handles %s without replaying stream output', async mode => {
  const posted: Array<Record<string, unknown>> = [];
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let pollCount = 0, closed = false;
  const inferStream = vi.fn(async function* () {
    try { yield delta('one'); yield delta('two'); }
    finally { closed = true; }
  });
  const legacyInfer = vi.fn(async () => { throw new Error('legacy infer called'); });
  const peer = createPlanNativePeer({ current: () => true, connected: vi.fn(), infer: legacyInfer,
    inferStream: mode === 'missing-handler' ? undefined : inferStream,
    fetchFn: vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname.split('/').at(-1);
      if (path === 'challenge') return Response.json({ version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60000).toISOString() });
      if (path === 'connect') return Response.json({ version: 1, sessionId });
      if (path === 'poll') {
        if (pollCount++ === 0) return Response.json({ version: 1, requests: [peerRequest] });
        await new Promise<void>(resolve => init!.signal!.addEventListener('abort', () => resolve(), { once: true }));
        return Response.json({ version: 1, requests: [] });
      }
      if (path === 'reply') {
        const value = JSON.parse(String(init?.body)); posted.push(value);
        return Response.json({ version: 1, ok: true, sessionId, id: mode === 'wrong-ack' ? '10000000-0000-4000-8000-000000000001' : value.id, sequence: value.sequence });
      }
      if (path === 'disconnect') return Response.json({ ok: true });
      throw new Error(`unexpected path ${path}`);
    }) as typeof fetch });
  try {
    await peer.start(binding, { deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1, enabled: true, background: false,
      models: [{ id: model, displayName: 'Model', input: ['text'], contextWindow: 8192, maxOutputTokens: 256 }] });
    if (mode === 'missing-handler') {
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({ ok: false, error: 'unavailable' });
      expect(inferStream).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(closed).toBe(true));
    }
    expect(legacyInfer).not.toHaveBeenCalled();
    if (mode === 'complete') {
      await vi.waitFor(() => expect(posted).toHaveLength(3));
      expect(posted.map(reply => [reply.stream, reply.sequence])).toEqual([['chunk', 0], ['chunk', 1], ['end', 2]]);
    } else if (mode === 'wrong-ack') {
      await vi.waitFor(() => expect(posted).toHaveLength(2));
      expect(posted[0]).toMatchObject({ stream: 'chunk', sequence: 0 });
      expect(posted[1]).toMatchObject({ ok: false, error: 'unavailable' });
      expect(posted.some(reply => reply.stream === 'end' || reply.sequence === 1)).toBe(false);
    }
  } finally { await peer.stop(); warning.mockRestore(); }
});
