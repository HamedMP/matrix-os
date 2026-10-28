import { afterEach, expect, it, vi } from 'vitest';
import { deliveryFixture, peerRoot, postBody } from './chatgpt-plan-delivery-support.js';
import { forwardChatGptPlanInference } from '../../../packages/gateway/src/bots/chatgpt-plan-inference.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(optIn = true, now?: () => number) {
  const f = await deliveryFixture(now); cleanup.push(f.close);
  const app = f.app();
  const capability = await app.request(`${peerRoot}/capabilities${optIn ? '?includeReplyDeliveryV2=true' : ''}`, postBody(f.session));
  const source = await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
  const request = (await f.peers.poll('owner', f.session)).requests[0]!;
  const chunk = { ...f.session, id: request.id, ok: true, stream: 'chunk', sequence: 0, body: 'data: fixture\n\n' } as const;
  const end = { ...f.session, id: request.id, ok: true, stream: 'end', sequence: 1 } as const;
  return { ...f, app, capability, source, request, chunk, end };
}
it('only explicit capabilities opt-in enables exact chunk/end receipt replay', async () => {
  const f = await fixture();
  expect(await f.capability.json()).toEqual({ ...f.session, pollDeliveryVersion: 2, replyDeliveryVersion: 2 });
  const one = f.peers.reply('owner', f.chunk), duplicate = f.peers.reply('owner', f.chunk);
  expect(await f.source.body.next()).toEqual({ value: f.chunk.body, done: false });
  expect(await one).toEqual(await duplicate);
  expect(await f.peers.reply('owner', f.chunk)).toMatchObject({ sequence: 0 });
  const endAck = f.peers.reply('owner', f.end);
  expect(f.peers.reply('owner', f.end)).toEqual(endAck);
  expect(await f.source.body.next()).toEqual({ value: undefined, done: true });
  expect(() => f.peers.reply('owner', f.chunk)).toThrow('conflict');
});
it('preserves the exact legacy response and rejects chunk/end replay without negotiation', async () => {
  const f = await fixture(false);
  expect(await f.capability.json()).toEqual({ ...f.session, pollDeliveryVersion: 2 });
  const one = f.peers.reply('owner', f.chunk); await f.source.body.next(); await one;
  expect(() => f.peers.reply('owner', f.chunk)).toThrow('conflict');
  f.peers.reply('owner', f.end);
  expect(() => f.peers.reply('owner', f.end)).toThrow('conflict');
});
it('rejects changed bytes/sequence and never revives a cancelled buffered chunk', async () => {
  const f = await fixture();
  const ack = expect(f.peers.reply('owner', f.chunk)).rejects.toThrow('unavailable');
  expect(() => f.peers.reply('owner', { ...f.chunk, body: 'changed' })).toThrow('conflict');
  expect(() => f.peers.reply('owner', { ...f.chunk, sequence: 1 })).toThrow('conflict');
  await f.source.body.return!(); await ack;
  expect(() => f.peers.reply('owner', f.end)).toThrow('conflict');
});
it('keeps final receipts bounded to 32, expires at 120s and drops them with the session', async () => {
  let now = 1_000_000;
  const f = await deliveryFixture(() => now); cleanup.push(f.close);
  f.peers.capabilities('owner', f.session, true);
  const ends: unknown[] = [];
  for (let i = 0; i < 33; i++) {
    const source = await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
    const request = (await f.peers.poll('owner', f.session)).requests[0]!;
    const end = { ...f.session, id: request.id, ok: true, stream: 'end', sequence: 0 };
    f.peers.reply('owner', end); await source.body.next(); ends.push(end);
  }
  expect(() => f.peers.reply('owner', ends[0])).toThrow('conflict');
  expect(f.peers.reply('owner', ends[1])).toMatchObject({ ok: true });
  for (let i = 0; i < 5; i++) { now += 20_000; f.peers.reply('owner', ends[32]); }
  now += 20_000;
  expect(() => f.peers.reply('owner', ends[32])).toThrow('conflict');
  await f.connect(); expect(() => f.peers.reply('owner', ends[1])).toThrow('unavailable');
});
it('rejects malformed/duplicate opt-in values before peer capability negotiation', async () => {
  const f = await deliveryFixture(); cleanup.push(f.close);
  for (const query of ['', 'false', '2', 'True', 'true&includeReplyDeliveryV2=true', 'true&includeReplyDeliveryV2=false', 'false&includeReplyDeliveryV2=true']) {
    expect((await f.app().request(`${peerRoot}/capabilities?includeReplyDeliveryV2=${query}`, postBody(f.session))).status).toBe(400);
  }
});
it('replays final transport ACK after successful forwarder EOF aborts its inference lifetime', async () => {
  const f = await deliveryFixture(); cleanup.push(f.close);
  f.peers.capabilities('owner', f.session, true);
  const binding = await f.binding(); let sourceSignal: AbortSignal | undefined;
  const result = await forwardChatGptPlanInference({ version: 1, action: 'inference.responses', method: 'POST',
    requestId: '20000000-0000-4000-8000-000000000001', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1',
    path: '/v1/responses', headers: {}, responseMode: 'stream', body: JSON.stringify({ model: 'gpt-server', stream: true, input: [{ role: 'user', content: 'Fixture' }] }) }, binding,
  { authority: { ...f.peers, inferStream: async (binding, body, signal) => { sourceSignal = signal; return f.peers.inferStream(binding, body, signal); } }, signal: new AbortController().signal, stillAuthorized: () => true });
  if (!result.ok || typeof result.body === 'string') throw new Error('Stream refused');
  const request = (await f.peers.poll('owner', f.session)).requests[0]!;
  const reading = (async () => { for await (const _ of result.body) { /* consume actual guard */ } })();
  await f.peers.reply('owner', { ...f.session, id: request.id, ok: true, stream: 'chunk', sequence: 0,
    body: 'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-server"}}\n\n' });
  const end = { ...f.session, id: request.id, ok: true, stream: 'end', sequence: 1 };
  f.peers.reply('owner', end); await reading;
  expect(sourceSignal?.aborted).toBe(true);
  expect(f.peers.reply('owner', end)).toMatchObject({ sequence: 1, ok: true });
});
it('caps duplicate HTTP waiters at two; abort detaches only its HTTP waiter', async () => {
  const f = await fixture(), aborted = new AbortController();
  const first = f.app.request(`${peerRoot}/reply`, { ...postBody(f.chunk), signal: aborted.signal });
  const second = f.app.request(`${peerRoot}/reply`, postBody(f.chunk));
  await new Promise(resolve => setImmediate(resolve));
  const excess = await f.app.request(`${peerRoot}/reply`, postBody(f.chunk));
  expect(excess.status).toBe(503);
  aborted.abort(); expect((await first).status).toBe(503);
  const replacement = f.app.request(`${peerRoot}/reply`, postBody(f.chunk));
  await new Promise(resolve => setImmediate(resolve));
  expect(await f.source.body.next()).toEqual({ value: f.chunk.body, done: false });
  expect((await second).status).toBe(200); expect((await replacement).status).toBe(503);
  expect((await f.app.request(`${peerRoot}/reply`, postBody(f.end))).status).toBe(200);
});
it('expires a body read at 10s and reserves at most eight before buffering', async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  let cancels = 0;
  const held = controllers.map(controller => f.app.request(`${peerRoot}/reply`, { method: 'POST',
    headers: { authorization: 'Bearer fixture' }, signal: controller.signal,
    body: new ReadableStream({ cancel() { cancels++; } }), duplex: 'half' } as RequestInit));
  await new Promise(resolve => setImmediate(resolve));
  expect((await f.app.request(`${peerRoot}/reply`, postBody(f.chunk))).status).toBe(503);
  await vi.advanceTimersByTimeAsync(10000);
  expect((await Promise.all(held)).map(r => r.status)).toEqual(Array(8).fill(503)); expect(cancels).toBe(8);
});
it.each(['unverified', 'other'])('checks %s authorization before reading a slow reply body', async kind => {
  const f = await deliveryFixture(); cleanup.push(f.close); let pulled = 0;
  const controller = new AbortController();
  const pending = f.app(kind === 'other' ? 'other' : 'owner', 'jwt', kind !== 'unverified').request(`${peerRoot}/reply`, { method: 'POST',
    headers: { authorization: 'Bearer fixture' }, signal: controller.signal, body: new ReadableStream({ pull() { pulled++; } }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  const response = await pending;
  expect(response.status).toBe(403); expect(pulled).toBe(0);
});
it('bounds cumulative detached ACK reactions through sequential abort churn', async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController();
    const pending = f.app.request(`${peerRoot}/reply`, { ...postBody(f.chunk), signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); expect((await pending).status).toBe(503);
  }
  const excess = f.app.request(`${peerRoot}/reply`, postBody(f.chunk));
  await new Promise(resolve => setImmediate(resolve));
  expect(await f.source.body.next()).toEqual({ value: f.chunk.body, done: false });
  expect((await excess).status).toBe(503);
  const end = await f.app.request(`${peerRoot}/reply`, postBody(f.end)); expect(end.status).toBe(200); await end.json();
});
it.each([false, true])('enforces actual reply bytes with understated Content-Length=%s', async understated => {
  const { CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT } = await import('@matrix-os/contracts');
  const f = await fixture();
  const text = JSON.stringify(f.chunk) + ' '.repeat(CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT);
  const headers: Record<string, string> = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  if (understated) headers['content-length'] = '1';
  const response = await f.app.request(`${peerRoot}/reply`, { method: 'POST', headers,
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), duplex: 'half' } as RequestInit);
  expect(response.status).toBe(413);
});
it('allows capability negotiation when an inference queues before the first poll', async () => {
  const f = await deliveryFixture(); cleanup.push(f.close);
  const source = await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
  expect(f.peers.capabilities('owner', f.session, true)).toMatchObject({ replyDeliveryVersion: 2 });
  const request = (await f.peers.poll('owner', f.session)).requests[0]!;
  const chunk = { ...f.session, id: request.id, ok: true, stream: 'chunk', sequence: 0, body: 'queued' };
  const one = f.peers.reply('owner', chunk), two = f.peers.reply('owner', chunk);
  expect(await source.body.next()).toEqual({ value: 'queued', done: false }); await Promise.all([one, two]);
});
it('times out only the ACK connection, preserving the accepted chunk for its single retry', async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const first = f.app.request(`${peerRoot}/reply`, postBody(f.chunk));
  await new Promise(resolve => setImmediate(resolve)); await vi.advanceTimersByTimeAsync(10000);
  expect((await first).status).toBe(503);
  const retry = f.app.request(`${peerRoot}/reply`, postBody(f.chunk));
  await new Promise(resolve => setImmediate(resolve));
  expect(await f.source.body.next()).toEqual({ value: f.chunk.body, done: false });
  const response = await retry; expect(response.status).toBe(200); await response.json();
});
it('does not accept a complete JSON prefix when a later chunk exceeds actual-byte capacity', async () => {
  const { CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT } = await import('@matrix-os/contracts');
  const f = await fixture();
  const response = await f.app.request(`${peerRoot}/reply`, { method: 'POST', headers: { authorization: 'Bearer fixture' },
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(f.chunk)));
      c.enqueue(new TextEncoder().encode(' '.repeat(CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT))); c.close(); } }), duplex: 'half' } as RequestInit);
  expect(response.status).toBe(413);
  const ack = f.peers.reply('owner', f.chunk);
  expect(await f.source.body.next()).toEqual({ value: f.chunk.body, done: false }); await ack;
});
