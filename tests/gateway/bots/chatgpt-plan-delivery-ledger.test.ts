import { afterEach, expect, it, vi } from 'vitest';
import { createPeerPollDelivery } from '../../../packages/gateway/src/bots/chatgpt-plan-poll-delivery.js';
import { deliveryRequest } from '../../desktop/chatgpt-plan-poll-support.js';
import { Hono } from 'hono';
import { emitPeerPoll } from '../../../packages/gateway/src/bots/chatgpt-plan-poll-route.js';
function fixture() {
  let now = 0, active = true;
  const sessionId = '10000000-0000-4000-8000-000000000001';
  const ledger = createPeerPollDelivery({ sessionId, now: () => now, current: () => active,
    expire: () => { active = false; ledger.close(); } });
  const poll = (ack = 0, signal = new AbortController().signal) => ledger.poll(ack, signal);
  return { ledger, poll, setTime(value: number) { now = value; }, get active() { return active; } };
}
afterEach(() => vi.useRealTimers());
const body = (emission: { encoded: Uint8Array; release(): void }) => {
  const parsed = JSON.parse(new TextDecoder().decode(emission.encoded)); emission.release(); return parsed;
};
it('prioritizes unnumbered Cancel without reordering an already published infer', async () => {
  const f = fixture();
  try {
    const a = deliveryRequest(1), b = deliveryRequest(2);
    f.ledger.enqueue(a); body(await f.poll());
    f.ledger.enqueue(b); f.ledger.cancel(a.id);
    expect(body(await f.poll()).deliveries.map((entry: any) => [entry.deliverySequence, entry.request.action, entry.request.id]))
      .toEqual([[1, 'infer', a.id], [2, 'cancel', a.id], [3, 'infer', b.id]]);
  } finally { f.ledger.close(); }
});
it('removes only provably unsent canceled inference without a delivery gap', async () => {
  const f = fixture();
  try {
    const a = deliveryRequest(1), b = deliveryRequest(2);
    f.ledger.enqueue(a); f.ledger.cancel(a.id); f.ledger.enqueue(b);
    expect(body(await f.poll()).deliveries).toEqual([{ deliverySequence: 1, request: b }]);
  } finally { f.ledger.close(); }
});
it('counts completed but unacknowledged infer bodies against the independent four-body cap', async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 4; i++) f.ledger.enqueue(deliveryRequest(i));
    body(await f.poll()); expect(f.ledger.canAdmit(deliveryRequest(5))).toBe(false);
    const pending = f.poll(4), fifth = deliveryRequest(5); f.ledger.enqueue(fifth);
    expect(body(await pending).deliveries).toEqual([{ deliverySequence: 5, request: fifth }]);
  } finally { f.ledger.close(); }
});
it('never drops retained Cancels to admit work when all 32 slots fill', () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 32; i++) f.ledger.cancel(deliveryRequest(i).id);
    expect(f.ledger.canAdmit(deliveryRequest(33))).toBe(false); expect(f.active).toBe(true);
    f.ledger.cancel(deliveryRequest(33).id); expect(f.active).toBe(false);
  } finally { f.ledger.close(); }
});
it('does not renew fixed receipt TTL when replaying and checks expiry before accepting a late ACK', async () => {
  const f = fixture();
  try {
    f.ledger.enqueue(deliveryRequest()); body(await f.poll());
    f.setTime(29999); body(await f.poll()); f.setTime(30000);
    expect(() => f.poll(1)).toThrow('unavailable'); expect(f.active).toBe(false);
  } finally { f.ledger.close(); }
});
it('makes an ACKed entry old expiry inert while remaining entries keep their original deadlines', async () => {
  vi.useFakeTimers(); const f = fixture();
  try {
    f.ledger.enqueue(deliveryRequest()); body(await f.poll());
    f.setTime(29999); await vi.advanceTimersByTimeAsync(29999);
    f.ledger.enqueue(deliveryRequest(2)); body(await f.poll(1));
    f.setTime(30001); await vi.advanceTimersByTimeAsync(2);
    expect(f.active).toBe(true); expect(body(await f.poll(1)).acknowledgedThrough).toBe(1);
    f.setTime(59999); await vi.advanceTimersByTimeAsync(29998); expect(f.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally { f.ledger.close(); }
});
it('joins two same-ACK waiting requests on one deadline and rejects a third without restarting it', async () => {
  vi.useFakeTimers(); const f = fixture(), firstStop = new AbortController();
  try {
    const first = f.poll(0, firstStop.signal), rejected = expect(first).rejects.toThrow();
    f.setTime(9000); await vi.advanceTimersByTimeAsync(9000);
    const second = f.poll(); expect(() => f.poll()).toThrow('conflict');
    firstStop.abort(); await rejected;
    f.setTime(10000); await vi.advanceTimersByTimeAsync(1000);
    expect(body(await second).deliveries).toEqual([]);
    f.ledger.cancel(deliveryRequest().id);
    expect(body(await f.poll()).deliveries[0]).toMatchObject({ deliverySequence: 1, request: { action: 'cancel' } });
  } finally { f.ledger.close(); }
});
it('anchors emission expiry at publication rather than at a delayed route writer start', async () => {
  const f = fixture();
  try {
    f.ledger.enqueue(deliveryRequest());
    const emission = await f.poll();
    f.setTime(15000);
    const app = new Hono(); app.get('/delayed', c => emitPeerPoll(c, emission));
    expect(await (await app.request('/delayed')).text()).toBe('');
    expect(f.active).toBe(true);
    expect(body(await f.poll()).deliveries[0]).toMatchObject({ deliverySequence: 1 });
  } finally { f.ledger.close(); }
});
