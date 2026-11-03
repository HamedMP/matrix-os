import { afterEach, expect, it, vi } from 'vitest';
import { createPlanNativePeer } from '../../../desktop/src/main/chatgpt-plan/peer.js';
import { deliveryFixture } from './chatgpt-plan-delivery-support.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

it.each(['chunk', 'end'] as const)('actual Host consumes %s once after an own-deadline lost ACK', async lostKind => {
  const original = AbortSignal.timeout;
  const deadlines: AbortController[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    if (ms !== 10_000) return original(ms);
    const controller = new AbortController(); deadlines.push(controller); return controller.signal;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      if (reply) sent.push(String(init?.body));
      const response = await app.request(String(input), init);
      if (path !== 'reply') return response;
      const ack = await response.json();
      if (reply?.stream === lostKind && !lost) {
        lost = true;
        const deadline = deadlines.at(-1)!;
        setTimeout(() => deadline.abort(new DOMException('Own POST deadline', 'TimeoutError')), 0);
        return await new Promise<Response>(() => {});
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
  const attempts = sent.filter(value => JSON.parse(value).stream === lostKind);
  const repeated = lostKind === 'chunk' ? attempts.filter(value => JSON.parse(value).sequence === 0) : attempts;
  expect(repeated).toHaveLength(2); expect(repeated[0]).toBe(repeated[1]);
});
