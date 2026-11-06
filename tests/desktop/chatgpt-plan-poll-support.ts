import { generateKeyPairSync } from 'node:crypto';
import { createPlanNativePeer } from '../../desktop/src/main/chatgpt-plan/peer';
import { observePlanFailures, type PlanFailureRecord } from '../../desktop/src/main/chatgpt-plan/diagnostics';
const sessionId = '10000000-0000-4000-8000-000000000001';
const keys = generateKeyPairSync('ed25519');
export const deliveryRequest = (sequence = 1) => ({ version: 1 as const, action: 'infer' as const, responseMode: 'stream' as const,
  id: `${sessionId.slice(0, 24)}${sequence.toString(16).padStart(12, '0')}`, sequence, expiresAt: new Date(Date.now() + 120000).toISOString(),
  accountId: 'account', grantRevision: 1, computerId: 'computer', requestClass: 'interactive' as const, runId: 'run', model: 'model', body: '{}' });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function wait(promise: Promise<void>, signal: AbortSignal) {
  let abort!: () => void;
  const stop = new Promise<never>((_r, reject) => { abort = () => reject(signal.reason); });
  signal.addEventListener('abort', abort, { once: true });
  try { signal.throwIfAborted(); await Promise.race([promise, stop]); signal.throwIfAborted(); }
  finally { signal.removeEventListener('abort', abort); }
}
export function nativeDeliveryFixture(options: {
  capability?: () => Response; steps?: Array<(signal: AbortSignal) => Response | Promise<Response>>;
  first?: unknown[];
} = {}) {
  const ready = gate(), release = gate();
  const records: PlanFailureRecord[] = [], replies: Record<string, unknown>[] = [], polls: Record<string, unknown>[] = [], paths: string[] = [];
  const unobserve = observePlanFailures(row => records.push(row));
  const state = { current: true, connected: false, executions: 0, closed: false, signal: undefined as AbortSignal | undefined };
  const request = deliveryRequest();
  const peer = createPlanNativePeer({ deliveryVersion: 2, current: () => state.current, connected: value => { state.connected = value; },
    infer: async () => { throw new Error('Legacy inference forbidden'); },
    inferStream: async function* (_input, signal) {
      state.executions++; state.signal = signal;
      try {
        yield 'first'; ready.resolve(); await wait(release.promise, signal); yield 'last';
      } finally { state.closed = true; }
    },
    fetchFn: (async (input, init) => {
      const action = new URL(String(input)).pathname.split('/').at(-1)!; paths.push(action);
      if (action === 'challenge') return Response.json({ version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60000).toISOString() });
      if (action === 'connect') return Response.json({ version: 1, sessionId });
      if (action === 'capabilities') return options.capability?.() ?? Response.json({ version: 1, sessionId, pollDeliveryVersion: 2 });
      if (action === 'disconnect') return Response.json({ version: 1, ok: true });
      const body = JSON.parse(String(init?.body));
      if (action === 'reply') { replies.push(body); return Response.json({ version: 1, ok: true, sessionId, id: body.id, sequence: body.sequence }); }
      if (action !== 'poll-v2') throw new Error('Unexpected legacy/foreign request');
      const index = polls.length; polls.push(body);
      if (index === 0) return Response.json({ version: 2, sessionId, acknowledgedThrough: 0,
        deliveries: (options.first ?? [request]).map((value, i) => ({ deliverySequence: i + 1, request: value })) });
      await wait(ready.promise, init!.signal!);
      if (options.steps?.[index - 1]) return options.steps[index - 1]!(init!.signal!);
      await wait(new Promise<void>(() => {}), init!.signal!);
      return Response.json({ version: 2, sessionId, acknowledgedThrough: body.ackThrough, deliveries: [] });
    }) as typeof fetch,
  });
  return { peer, state, records, replies, polls, paths, ready, release, sessionId,
    start: () => peer.start({ runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer', origin: 'https://fixture.invalid', bearer: 'synthetic',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
      { deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1, enabled: true, background: false, models: [{ id: 'model', displayName: 'Model', input: ['text'], contextWindow: 8192, maxOutputTokens: 256 }] }),
    async close() { release.resolve(); await peer.stop(); unobserve(); },
  };
}
