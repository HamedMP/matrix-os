import { CHATGPT_PLAN_PEER_MAX_SEQUENCE, CHATGPT_PLAN_PEER_POLL_BYTE_LIMIT, type ChatGptPlanPeerRequest } from '@matrix-os/contracts';
import { ChatGptPlanPeerError } from './chatgpt-plan-peer-error.js';

type Entry = { request: ChatGptPlanPeerRequest; sequence?: number; expires?: number };
type Batch = { encoded: Uint8Array; expires: number };
type Waiting = { ack: number; count: number; promise: Promise<Batch>; resolve(value: Batch): void;
  reject(error: unknown): void; timer: ReturnType<typeof setTimeout> };
export interface PeerPollEmission {
  encoded: Uint8Array;
  signal: AbortSignal;
  verify(): void;
  remainingMs(): number;
  release(): void;
}

/** Ephemeral receipt ledger for one exact signed session. Never retries inference. */
export function createPeerPollDelivery(deps: { sessionId: string; now(): number; current(): boolean; expire(): void }) {
  let entries: Entry[] = []; // <=32, <=4 infer bodies; Cancel always has four reserved slots.
  const slots = new Set<AbortController>(); // <=2 application-owned waits/emissions, released on abort/drain.
  let lastAcked = 0, highestSent = 0, closed = false;
  let waiting: Waiting | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const unavailable = () => new ChatGptPlanPeerError('unavailable');
  const conflict = () => new ChatGptPlanPeerError('conflict');
  const expired = () => entries.some(entry => entry.expires !== undefined && entry.expires <= deps.now());
  function verify() {
    if (expired()) deps.expire();
    if (closed || !deps.current()) throw unavailable();
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const first = entries.filter(entry => entry.expires !== undefined).sort((a, b) => a.expires! - b.expires!)[0];
    if (closed || !first) return;
    expiryTimer = setTimeout(() => {
      if (entries.includes(first) && first.expires! <= deps.now()) deps.expire();
      else scheduleExpiry();
    }, Math.max(1, first.expires! - deps.now()));
    expiryTimer.unref?.();
  }
  const encode = (ack: number, values: Entry[]) => JSON.stringify({ version: 2, sessionId: deps.sessionId,
    acknowledgedThrough: ack, deliveries: values.map(entry => ({ deliverySequence: entry.sequence ?? CHATGPT_PLAN_PEER_MAX_SEQUENCE, request: entry.request })) });
  function canAdmit(request: ChatGptPlanPeerRequest) {
    verify();
    return entries.length < 28 && entries.filter(entry => entry.request.action === 'infer').length < 4
      && Buffer.byteLength(encode(CHATGPT_PLAN_PEER_MAX_SEQUENCE, [...entries, { request }])) + 65536 <= CHATGPT_PLAN_PEER_POLL_BYTE_LIMIT;
  }
  function publish(value: Waiting) {
    if (waiting !== value) return;
    waiting = undefined; // Publication retires the logical poll, never an HTTP tail.
    clearTimeout(value.timer);
    try {
      verify();
      const sent = entries.filter(entry => entry.sequence !== undefined);
      const tail = entries.filter(entry => entry.sequence === undefined);
      entries = [...sent, ...tail.filter(entry => entry.request.action === 'cancel'), ...tail.filter(entry => entry.request.action === 'infer')];
      for (const entry of entries) if (entry.sequence === undefined) {
        if (highestSent >= CHATGPT_PLAN_PEER_MAX_SEQUENCE) { deps.expire(); throw unavailable(); }
        entry.sequence = ++highestSent;
        entry.expires ??= deps.now() + 30000;
      }
      const encoded = encode(value.ack, entries);
      if (Buffer.byteLength(encoded) > CHATGPT_PLAN_PEER_POLL_BYTE_LIMIT) { deps.expire(); throw unavailable(); }
      scheduleExpiry();
      value.resolve({ encoded: new TextEncoder().encode(encoded), expires: deps.now() + 15000 });
    } catch (error: unknown) { value.reject(error); }
  }
  function enqueue(request: ChatGptPlanPeerRequest) {
    if (!canAdmit(request)) throw unavailable();
    entries.push({ request: Object.freeze(request) });
    if (waiting) publish(waiting);
  }
  function cancel(id: string) {
    if (closed || !deps.current()) return;
    if (expired()) { deps.expire(); return; }
    const unsent = entries.find(entry => entry.request.action === 'infer' && entry.request.id === id && entry.sequence === undefined);
    if (unsent) { entries = entries.filter(entry => entry !== unsent); scheduleExpiry(); return; }
    if (entries.some(entry => entry.request.action === 'cancel' && entry.request.id === id)) return;
    if (entries.length >= 32) { deps.expire(); return; }
    entries.push({ request: Object.freeze({ version: 1, action: 'cancel', id }), expires: deps.now() + 30000 });
    scheduleExpiry();
    if (waiting) publish(waiting);
  }
  function poll(ack: number, signal: AbortSignal): Promise<PeerPollEmission> {
    verify(); signal.throwIfAborted();
    if (ack < lastAcked || ack > highestSent || slots.size >= 2
      || waiting && (waiting.ack !== ack || waiting.count >= 2)) throw conflict();
    // All validation precedes mutation; ACK is a continuous published prefix.
    entries = entries.filter(entry => entry.sequence === undefined || entry.sequence > ack);
    lastAcked = ack;
    scheduleExpiry();
    const slot = new AbortController();
    slots.add(slot);
    const abort = () => slot.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const release = () => { signal.removeEventListener('abort', abort); slots.delete(slot); };
    if (!waiting) {
      let resolve!: (value: Batch) => void, reject!: (error: unknown) => void;
      const promise = new Promise<Batch>((ok, fail) => { resolve = ok; reject = fail; });
      const value = { ack, count: 0, promise, resolve, reject, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      waiting = value;
      value.timer = setTimeout(() => publish(value), 10000);
      value.timer.unref?.();
    }
    const value = waiting;
    value.count++;
    const result = new Promise<PeerPollEmission>((resolve, reject) => {
      const interrupted = () => { release(); reject(slot.signal.reason); };
      slot.signal.addEventListener('abort', interrupted, { once: true });
      void value.promise.then(batch => {
        slot.signal.removeEventListener('abort', interrupted);
        slot.signal.throwIfAborted(); verify();
        resolve({ encoded: batch.encoded, signal: slot.signal, verify, release, remainingMs: () => batch.expires - deps.now() });
      }).catch((error: unknown) => { slot.signal.removeEventListener('abort', interrupted); release(); reject(error); });
    });
    if (entries.length) publish(value);
    return result;
  }
  function close() {
    closed = true;
    clearTimeout(expiryTimer);
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(unavailable()); waiting = undefined; }
    for (const slot of slots) slot.abort(unavailable());
    slots.clear(); entries = [];
  }
  return { canAdmit, enqueue, cancel, poll, close, expired };
}
