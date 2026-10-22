import { describe, expect, it, vi } from 'vitest';
import { ChatOutboxDelivery } from '../../packages/gateway/src/chat/outbox-delivery.js';
import type { ChatOutboxEvent } from '../../packages/gateway/src/chat/records.js';
const event = (cursor: number) => ({ owner: { type: 'personal' as const, ownerId: 'owner_one' },
  event: { cursor, chatId: 'chat_one', revision: 1, eventType: 'chat.updated', payload: {}, createdAt: new Date().toISOString() } as ChatOutboxEvent });

describe('outer transaction outbox release batches', () => {
  it('checks every lease before any sink and disposes failed batches', () => {
    const delivery = new ChatOutboxDelivery(); const sink = vi.fn(); delivery.registerSink(sink);
    const tx = {}; const batch = delivery.begin(tx); const checked = vi.fn(() => true as const);
    delivery.beforeRelease(tx, checked); delivery.beforeRelease(tx, () => { throw new Error('expired'); });
    delivery.capture(tx, event(1)); delivery.capture(tx, event(2)); delivery.seal(tx);
    expect(() => delivery.commit(batch)).toThrow('expired');
    expect(checked).toHaveBeenCalledOnce(); expect(sink).not.toHaveBeenCalled();
    delivery.end(tx); expect(() => delivery.beforeRelease(tx, checked)).toThrow();
  });
  it('requires a live exact outer ledger and refuses registration after sealing', () => {
    const delivery = new ChatOutboxDelivery(); const tx = {}; delivery.begin(tx);
    expect(() => delivery.beforeRelease({}, () => true)).toThrow();
    delivery.seal(tx); expect(() => delivery.beforeRelease(tx, () => true)).toThrow();
    delivery.end(tx);
  });
  it('rollback performs no checks; subsequent batches and ordinary ordering are independent', () => {
    const delivery = new ChatOutboxDelivery(); const sink = vi.fn(); delivery.registerSink(sink);
    const first = {}; const check = vi.fn(() => true as const); delivery.begin(first);
    delivery.beforeRelease(first, check); delivery.capture(first, event(1)); delivery.end(first);
    const second = {}; const batch = delivery.begin(second);
    delivery.capture(second, event(2)); delivery.capture(second, event(3)); delivery.seal(second); delivery.commit(batch); delivery.end(second);
    expect(check).not.toHaveBeenCalled(); expect(sink.mock.calls.map(([input]) => input.event.cursor)).toEqual([2, 3]);
    expect(() => delivery.commit(batch)).toThrow();
  });
  it('bounds events, checks, and batches through the committing interval and reclaims capacity', () => {
    const delivery = new ChatOutboxDelivery(); const tx = {}; delivery.begin(tx);
    for (let i = 0; i < 100; i++) { delivery.capture(tx, event(i)); delivery.beforeRelease(tx, () => true); }
    expect(() => delivery.capture(tx, event(101))).toThrow(); expect(() => delivery.beforeRelease(tx, () => true)).toThrow();
    delivery.seal(tx);
    const transactions = Array.from({ length: 127 }, () => ({})); transactions.forEach(item => delivery.begin(item));
    expect(() => delivery.begin({})).toThrow(); delivery.end(tx); const replacement = {}; delivery.begin(replacement);
    [...transactions, replacement].forEach(item => delivery.end(item));
  });
  it('checks without a sink and isolates ordinary sink failures', () => {
    const delivery = new ChatOutboxDelivery(); const tx = {}; const batch = delivery.begin(tx);
    const check = vi.fn(() => true as const); delivery.beforeRelease(tx, check); delivery.seal(tx); delivery.commit(batch); delivery.end(tx);
    expect(check).toHaveBeenCalledOnce();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sink = vi.fn().mockImplementationOnce(() => { throw new Error('sink'); }); delivery.registerSink(sink);
    delivery.flush([event(1), event(2)]); expect(sink).toHaveBeenCalledTimes(2); log.mockRestore();
    delivery.release(); delivery.flush([event(3)]); expect(sink).toHaveBeenCalledTimes(2);
  });
});
