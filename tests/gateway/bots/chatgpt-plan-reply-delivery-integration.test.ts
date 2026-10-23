import { afterEach, expect, it, vi } from 'vitest';
import { createPlanNativePeer } from '../../../desktop/src/main/chatgpt-plan/peer.js';
import { deliveryFixture } from './chatgpt-plan-delivery-support.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it.each(['chunk-before', 'chunk-after', 'end-before', 'end-after', 'chunk-read'])('actual Native/Hono/Host recovers %s loss once without duplicate bytes', async failure => {
  const f = await deliveryFixture(); cleanup.push(f.close); const app = f.app();
  let lost = false, executions = 0, endReplies = 0;
  const received: string[] = [], sent: string[] = [];
  const native = createPlanNativePeer({ deliveryVersion: 2, current: () => true, connected: () => {},
    infer: async () => { throw new Error('Legacy forbidden'); },
    inferStream: async function* () { executions++; yield 'first'; yield 'second'; },
    fetchFn: (async (input, init) => {
      const url = new URL(String(input)); if (url.origin !== 'https://fixture.invalid') throw new Error('External forbidden');
      const path = url.pathname.split('/').at(-1)!;
      const reply = path === 'reply' ? JSON.parse(String(init?.body)) : undefined;
      if (path === 'capabilities') expect(url.searchParams.get('includeReplyDeliveryV2')).toBe('true');
      const target = reply?.stream === failure.split('-')[0] && !lost;
      if (reply) sent.push(String(init?.body));
      if (target && failure.endsWith('before')) { lost = true; throw new Error('net::ERR_SSL_PROTOCOL_ERROR'); }
      const response = await app.request(String(input), init);
      if (path !== 'reply') return response;
      const ack = await response.json();
      if (target) {
        lost = true;
        if (failure.endsWith('read')) return new Response(new ReadableStream({ start(c) { c.error(new Error('net::ERR_SSL_PROTOCOL_ERROR')); } }));
        throw new Error('net::ERR_SSL_PROTOCOL_ERROR');
      }
      if (reply.stream === 'end') endReplies++;
      return Response.json(ack, { status: response.status });
    }) as typeof fetch,
  });
  cleanup.push(() => native.stop()); await native.start(f.nativeBinding, f.snapshot);
  const source = await f.peers.inferStream(await f.binding(), '{}', new AbortController().signal);
  for await (const part of source.body) received.push(part);
  await vi.waitFor(() => expect(endReplies).toBe(1), { interval: 2 });
  expect(received).toEqual(['first', 'second']); expect(executions).toBe(1); expect(lost).toBe(true);
  const attempts = sent.filter(value => JSON.parse(value).stream === failure.split('-')[0]);
  const repeated = failure.startsWith('chunk') ? attempts.filter(value => JSON.parse(value).sequence === 0) : attempts;
  expect(repeated).toHaveLength(2); expect(repeated[0]).toBe(repeated[1]);
});
