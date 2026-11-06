import { afterEach, expect, it } from 'vitest';
import { INFERENCE_RESPONSE_CHUNK_MAX_BYTES } from '@matrix-os/contracts';
import { ChatGptPlanPeerPollSchema, ChatGptPlanPeerReplySchema } from '../../fixtures/desktop-v0.1.19/chatgpt-plan-peer.js';
import { deliveryFixture, peerRoot, postBody } from './chatgpt-plan-delivery-support.js';
import { createPlanNativePeer } from '../../../desktop/src/main/chatgpt-plan/peer.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const completion = 'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-server"}}\n\n';

it('completes streaming caller inference through the released 0.1.19 strict native wire', async () => {
  const f = await deliveryFixture(undefined, { streaming: false }); cleanup.push(f.close);
  const app = f.app();
  const pending = f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
  const response = await app.request(`${peerRoot}/poll`, postBody(f.session));
  const poll = ChatGptPlanPeerPollSchema.parse(await response.json());
  expect(poll.requests).toHaveLength(1);
  expect(poll.requests[0]).not.toHaveProperty('responseMode');
  const body = 'data: {"type":"response.output_text.delta","delta":"' + 'é'.repeat(40000) + '"}\n\n' + completion;
  const reply = ChatGptPlanPeerReplySchema.parse({ ...f.session, id: poll.requests[0]!.id, ok: true,
    status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  expect((await app.request(`${peerRoot}/reply`, postBody(reply))).status).toBe(200);
  const result = await pending;
  const chunks: string[] = [];
  for await (const chunk of result.body) {
    expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(INFERENCE_RESPONSE_CHUNK_MAX_BYTES);
    chunks.push(chunk);
  }
  expect(chunks.join('')).toBe(body);
  expect(chunks.length).toBeGreaterThan(1);
});

it('enables stream fields only after authenticated same-session inference capability opt-in', async () => {
  const f = await deliveryFixture(undefined, { streaming: false }); cleanup.push(f.close);
  const path = `${peerRoot}/capabilities?includeInferenceStream=true`;
  expect((await f.app('other').request(path, postBody(f.session))).status).toBe(403);
  const negotiated = await f.app().request(path, postBody(f.session));
  expect(await negotiated.json()).toMatchObject({ ...f.session, inferenceStream: true });
  const source = await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
  const request = (await f.peers.poll('owner', f.session)).requests[0]!;
  expect(request).toHaveProperty('responseMode', 'stream');
  const iterator = source.body[Symbol.asyncIterator]();
  const chunk = f.peers.reply('owner', { ...f.session, id: request.id, ok: true, stream: 'chunk', sequence: 0, body: completion });
  expect(await iterator.next()).toMatchObject({ value: completion, done: false }); await chunk;
  f.peers.reply('owner', { ...f.session, id: request.id, ok: true, stream: 'end', sequence: 1 });
  expect(await iterator.next()).toMatchObject({ done: true });
});

it.each([
  { optIn: true, olderGateway: false },
  { optIn: false, olderGateway: false },
  { optIn: false, olderGateway: true },
])('current native peer executes once with optIn=$optIn and olderGateway=$olderGateway', async ({ optIn, olderGateway }) => {
  const f = await deliveryFixture(undefined, { streaming: false }); cleanup.push(f.close);
  const app = f.app();
  let legacyCalls = 0, streamCalls = 0;
  const native = createPlanNativePeer({ deliveryVersion: 2, current: () => true, connected: () => {},
    infer: async () => { legacyCalls++; return completion; },
    inferStream: async function* () { streamCalls++; yield completion; },
    fetchFn: (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/capabilities')) {
        expect(url.searchParams.get('includeInferenceStream')).toBe('true');
        if (!optIn) url.searchParams.delete('includeInferenceStream');
        const response = await app.request(url.toString(), init);
        if (olderGateway) {
          // The previous streaming gateway omitted the new capability response
          // field but dispatched streaming requests unconditionally.
          f.peers.capabilities('owner', JSON.parse(String(init?.body)), false, true);
          expect(await response.clone().json()).not.toHaveProperty('inferenceStream');
        }
        return response;
      }
      return app.request(url.toString(), init);
    }) as typeof fetch,
  });
  cleanup.push(() => native.stop());
  await native.start(f.nativeBinding, f.snapshot);
  const source = await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
  let body = '';
  for await (const chunk of source.body) body += chunk;
  expect(body).toBe(completion);
  expect({ legacyCalls, streamCalls }).toEqual(optIn || olderGateway ? { legacyCalls: 0, streamCalls: 1 } : { legacyCalls: 1, streamCalls: 0 });
});

it('keeps cancellation and late-reply rejection on the bounded legacy path without replay', async () => {
  const f = await deliveryFixture(undefined, { streaming: false }); cleanup.push(f.close);
  const stop = new AbortController();
  const pending = f.peers.inferStream(await f.binding(), '{}', stop.signal);
  const rejected = expect(pending).rejects.toThrow('unavailable');
  const poll = ChatGptPlanPeerPollSchema.parse(await f.peers.poll('owner', f.session));
  const id = poll.requests[0]!.id;
  stop.abort(); await rejected;
  expect(ChatGptPlanPeerPollSchema.parse(await f.peers.poll('owner', f.session)).requests)
    .toEqual([{ version: 1, action: 'cancel', id }]);
  expect(() => f.peers.reply('owner', { ...f.session, id, ok: true, status: 200,
    headers: { 'content-type': 'text/event-stream' }, body: completion })).toThrow('conflict');
});

it('does not inherit streaming capability when the native session reconnects', async () => {
  const f = await deliveryFixture(undefined, { streaming: false }); cleanup.push(f.close);
  f.peers.capabilities('owner', f.session, false, true);
  const stale = await f.binding();
  const session = await f.connect();
  const staleOptIn = await f.app().request(`${peerRoot}/capabilities?includeInferenceStream=true`, postBody(f.session));
  expect(staleOptIn.status).toBe(503);
  await expect(f.peers.inferStream(stale, '{}', new AbortController().signal)).rejects.toThrow('unavailable');
  const pending = f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
  const poll = ChatGptPlanPeerPollSchema.parse(await f.peers.poll('owner', session));
  f.peers.reply('owner', { ...session, id: poll.requests[0]!.id, ok: true, status: 200,
    headers: { 'content-type': 'text/event-stream' }, body: completion });
  const source = await pending;
  expect(await source.body.next()).toMatchObject({ value: completion });
  expect(await source.body.next()).toMatchObject({ done: true });
});

it('omits new capability response fields unless requested and rejects malformed opt-in', async () => {
  const f = await deliveryFixture(undefined, { streaming: false }); cleanup.push(f.close);
  const app = f.app();
  const plain = await app.request(`${peerRoot}/capabilities`, postBody(f.session));
  expect(await plain.json()).toEqual({ ...f.session, pollDeliveryVersion: 2 });
  for (const query of ['false', 'true&includeInferenceStream=true']) {
    expect((await app.request(`${peerRoot}/capabilities?includeInferenceStream=${query}`, postBody(f.session))).status).toBe(400);
  }
  const pending = f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
  const poll = ChatGptPlanPeerPollSchema.parse(await f.peers.poll('owner', f.session));
  f.peers.reply('owner', { ...f.session, id: poll.requests[0]!.id, ok: true, status: 200,
    headers: { 'content-type': 'text/event-stream' }, body: completion });
  await pending;
});
