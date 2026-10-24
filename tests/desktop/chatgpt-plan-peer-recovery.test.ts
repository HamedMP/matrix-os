import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createPlanNativePeer } from '../../desktop/src/main/chatgpt-plan/peer';
import { logPlanFailure, observePlanFailures, safePlanFailureRecord, type PlanFailureRecord } from '../../desktop/src/main/chatgpt-plan/diagnostics';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const sessionId = '10000000-0000-4000-8000-000000000001';
const requestId = `${sessionId.slice(0, 24)}000000000001`;
const keys = generateKeyPairSync('ed25519');
const binding = { runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer',
  origin: 'https://fixture.invalid', bearer: 'PRIVATE fixture bearer',
  privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
const snapshot = { deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1, enabled: true, background: false,
  models: [{ id: 'model', displayName: 'Model', input: ['text' as const], contextWindow: 8192, maxOutputTokens: 256 }] };

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitOrAbort(promise: Promise<void>, signal: AbortSignal) {
  let abort!: () => void;
  const stopped = new Promise<void>(resolve => { abort = resolve; });
  signal.addEventListener('abort', abort, { once: true });
  try { if (!signal.aborted) await Promise.race([promise, stopped]); signal.throwIfAborted(); }
  finally { signal.removeEventListener('abort', abort); }
}
type PollStep = (signal: AbortSignal) => Response | Promise<Response>;
async function fixture(steps: PollStep[], options: { ackConflict?: boolean; lateDrain?: boolean; noActiveCall?: boolean } = {}) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const records: PlanFailureRecord[] = [], unobserve = observePlanFailures(row => records.push(row));
  const release = gate(), firstAck = gate(), drain = gate();
  let current = true, polling = 0, inferCount = 0, closed = false, sourceWaiting = false;
  let sourceSignal: AbortSignal | undefined, progress: (() => void) | undefined;
  const connected: boolean[] = [], replies: Record<string, unknown>[] = [], sessions: unknown[] = [];
  const request = { version: 1, action: 'infer', responseMode: 'stream', id: requestId, sequence: 1,
    expiresAt: new Date(Date.now() + 120000).toISOString(), accountId: 'account', grantRevision: 1,
    computerId: 'computer', requestClass: 'interactive', runId: 'run_0123456789abcdef0123456789abcdef', model: 'model',
    body: JSON.stringify({ model: 'model', input: [], stream: true }) };
  const peer = createPlanNativePeer({ current: () => current, connected: value => connected.push(value),
    infer: async () => { throw new Error('Legacy inference forbidden'); },
    inferStream: async function* (_request, signal, onProgress) {
      inferCount++; sourceSignal = signal; progress = onProgress;
      try {
        yield 'data: {"type":"response.output_text.delta","delta":"first"}\n\n';
        sourceWaiting = true;
        await waitOrAbort(release.promise, signal);
        yield 'data: {"type":"response.output_text.delta","delta":"last"}\n\n';
      } finally { if (options.lateDrain) await drain.promise; closed = true; }
    },
    fetchFn: (async (input, init) => {
      const action = new URL(String(input)).pathname.split('/').at(-1);
      if (action === 'challenge') return Response.json({ version: 1, challenge: 'a'.repeat(64),
        ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60000).toISOString() });
      if (action === 'connect') return Response.json({ version: 1, sessionId });
      if (action === 'disconnect') return Response.json({ version: 1, ok: true });
      if (action === 'reply') {
        const value = JSON.parse(String(init?.body)); replies.push(value);
        firstAck.resolve();
        if (options.ackConflict && value.ok) return new Response('', { status: 409 });
        return Response.json({ version: 1, ok: true, sessionId, id: requestId, sequence: value.sequence });
      }
      if (action !== 'poll') throw new Error('Unexpected fixture action');
      sessions.push(JSON.parse(String(init?.body)));
      const index = polling++;
      if (index === 0) return Response.json({ version: 1, requests: options.noActiveCall ? [] : [request] });
      if (!options.noActiveCall) await waitOrAbort(firstAck.promise, init!.signal!);
      if (steps[index - 1]) return steps[index - 1]!(init!.signal!);
      await waitOrAbort(new Promise<void>(() => {}), init!.signal!);
      return Response.json({ version: 1, requests: [] });
    }) as typeof fetch,
  });
  await peer.start(binding, snapshot);
  return { peer, records, release, firstAck, drain, connected, replies, sessions, request,
    get polls() { return polling; }, get inferCount() { return inferCount; }, get closed() { return closed; },
    get sourceWaiting() { return sourceWaiting; },
    get sourceSignal() { return sourceSignal; }, get progress() { return progress; },
    changeBinding() { current = false; },
    async close() { release.resolve(); drain.resolve(); await peer.stop(); unobserve(); },
  };
}
const empty = () => Response.json({ version: 1, requests: [] });

it('keeps the same active stream after one poll connection-establishment failure, without replaying inference', async () => {
  const x = await fixture([() => { throw new Error('net::ERR_CONNECTION_REFUSED at https://PRIVATE.invalid'); }, empty]);
  try {
    await vi.waitFor(() => expect(x.polls).toBe(4));
    expect(x.sourceSignal?.aborted).toBe(false);
    expect(x.inferCount).toBe(1); expect(x.connected).toEqual([false, true]);
    expect(x.sessions.every(value => JSON.stringify(value) === JSON.stringify({ version: 1, sessionId }))).toBe(true);
    x.release.resolve();
    await vi.waitFor(() => expect(x.replies.some(reply => reply.stream === 'end')).toBe(true));
    expect(x.replies.filter(reply => reply.stream === 'chunk')).toHaveLength(2);
    expect(x.replies.filter(reply => reply.ok === false)).toHaveLength(0);
  } finally { await x.close(); }
});

it.each(['ERR_CONNECTION_RESET', 'ERR_NETWORK_CHANGED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_ACCESS_DENIED',
  'ERR_FAILED', 'ERR_ABORTED', 'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_HTTP2_PING_FAILED', 'ERR_HTTP2_SERVER_REFUSED_STREAM',
  'ERR_QUIC_PROTOCOL_ERROR', 'ERR_NETWORK_IO_SUSPENDED', 'ERR_CONTENT_DECODING_FAILED'])(
  'records only fixed Chromium code %s and stops rather than recovering uncertain or security failures', async code => {
    const x = await fixture([() => { throw new Error(`net::${code} at https://PRIVATE.invalid/token`); }]);
    try {
      await vi.waitFor(() => expect(x.closed).toBe(true));
      expect(x.polls).toBe(2);
      expect(x.records).toContainEqual(expect.objectContaining({ stage: 'peer_poll', category: 'network_error',
        networkDiagnostic: { errorName: 'Error', chromiumCode: code, phase: 'before_headers' } }));
      expect(JSON.stringify(x.records)).not.toContain('PRIVATE');
    } finally { await x.close(); }
  });

it.each([
  ['primary certificate', { code: 'CERT_HAS_EXPIRED' }],
  ['nested certificate', { cause: { code: 'CERT_HAS_EXPIRED' } }],
  ['deeper certificate', { cause: { code: 'ECONNREFUSED', cause: { code: 'CERT_HAS_EXPIRED' } } }],
  ['unknown primary', { code: 'UNRECOGNIZED_SECURITY_FAILURE' }],
  ['unknown nested cause', { cause: { code: 'UNRECOGNIZED_SECURITY_FAILURE' } }],
  ['non-object cause', { cause: 'PRIVATE cause' }],
] as const)('gives %s precedence over a legacy preconnect Chromium error', async (_name, fields) => {
  const x = await fixture([() => { throw Object.assign(new Error('net::ERR_CONNECTION_REFUSED'), fields); }]);
  try {
    await vi.waitFor(() => expect(x.closed).toBe(true));
    expect(x.polls).toBe(2);
    expect(x.inferCount).toBe(1);
    expect(x.sourceSignal?.aborted).toBe(true);
    expect(JSON.stringify(x.records)).not.toContain('PRIVATE');
  } finally { await x.close(); }
});

it.each(['CERT_HAS_EXPIRED', 'UNRECOGNIZED_SECURITY_FAILURE'])(
  'does not borrow a safe primary Node code over the forbidden cause %s', async code => {
    const x = await fixture([() => { throw Object.assign(new TypeError('Connection failed'), { code: 'ECONNREFUSED', cause: { code } }); }]);
    try {
      await vi.waitFor(() => expect(x.closed).toBe(true));
      expect(x.polls).toBe(2);
      expect(x.inferCount).toBe(1);
      expect(x.sourceSignal?.aborted).toBe(true);
    } finally { await x.close(); }
  },
);

it('marks binding changes after reading poll as stale source and immediately closes admitted work', async () => {
  const go = gate();
  const x = await fixture([async signal => { await waitOrAbort(go.promise, signal); x.changeBinding(); return empty(); }]);
  try {
    await vi.waitFor(() => expect(x.sourceWaiting).toBe(true));
    go.resolve(); await vi.waitFor(() => expect(x.closed).toBe(true));
    expect(x.polls).toBe(2);
    expect(x.records).toContainEqual(expect.objectContaining({ stage: 'peer_poll', category: 'stale_source' }));
  } finally { await x.close(); }
});

it('maps the fixed peer changed failure safely even before a post can start', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const rows: PlanFailureRecord[] = [], unobserve = observePlanFailures(row => rows.push(row));
  try { logPlanFailure('peer_poll', new Error('peer changed')); }
  finally { unobserve(); }
  expect(rows).toEqual([{ observedAt: expect.any(String), stage: 'peer_poll', category: 'stale_source' }]);
});

it('retains unknown Chromium errors only as unknown, discarding arbitrary messages and nested payloads', async () => {
  const x = await fixture([() => { throw Object.assign(new Error('net::ERR_PRIVATE_NEW ' + 'PRIVATE'.repeat(100_000)),
    { cause: { code: 'PRIVATE', token: 'PRIVATE'.repeat(100_000) } }); }]);
  try {
    await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.polls).toBe(2);
    expect(x.records).toContainEqual(expect.objectContaining({ stage: 'peer_poll', category: 'network_error',
      networkDiagnostic: { errorName: 'Error', chromiumCode: 'unknown', causeCode: 'unknown', phase: 'before_headers' } }));
    expect(JSON.stringify(x.records)).not.toContain('PRIVATE');
    expect(safePlanFailureRecord({ observedAt: '2026-10-22T00:00:00.000Z', stage: 'peer_poll', category: 'network_error',
      networkDiagnostic: { chromiumCode: 'ERR_PRIVATE_NEW', phase: 'PRIVATE', token: 'PRIVATE' } }))
      .toEqual({ observedAt: '2026-10-22T00:00:00.000Z', stage: 'peer_poll', category: 'network_error' });
  } finally { await x.close(); }
});

it.each(['before_headers', 'body_read'] as const)('does not lose a dequeued cancel after uncertain delivery failure at %s', async phase => {
  const serverQueue = [{ version: 1, action: 'cancel', id: requestId }];
  let dequeued = false;
  const x = await fixture([() => {
    // Mirror the existing poll's splice-on-send protocol: no delivery ACK exists.
    const requests = serverQueue.splice(0, 32); dequeued = requests.length === 1;
    if (phase === 'before_headers') throw new Error('net::ERR_CONNECTION_RESET');
    const json = JSON.stringify({ version: 1, requests });
    let began = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!began) { began = true; controller.enqueue(new TextEncoder().encode(json.slice(0, 10))); }
      else controller.error(new Error('net::ERR_CONNECTION_REFUSED'));
    } }));
  }]);
  try {
    await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.polls).toBe(2);
    expect(dequeued).toBe(true); expect(serverQueue).toHaveLength(0);
    expect(x.sourceSignal?.aborted).toBe(true);
    expect(x.records).toContainEqual(expect.objectContaining({ stage: 'peer_poll', networkDiagnostic: expect.objectContaining({ phase }) }));
  } finally { await x.close(); }
});

it.each([
  ['HTTP auth', () => new Response('', { status: 401 })],
  ['invalid schema', () => Response.json({ version: 1, requests: 'invalid' })],
  ['poll timeout', () => { throw new DOMException('PRIVATE timeout', 'TimeoutError'); }],
  ['unknown TypeError', () => { throw new TypeError('PRIVATE'); }],
] as const)('does not retry %s with an admitted stream', async (_name, step) => {
  const x = await fixture([step]);
  try { await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.polls).toBe(2); }
  finally { await x.close(); }
});

it('stops after a second consecutive preconnect failure', async () => {
  const fail = () => { throw new Error('net::ERR_CONNECTION_REFUSED'); };
  const x = await fixture([fail, fail]);
  try { await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.polls).toBe(3); expect(x.inferCount).toBe(1); }
  finally { await x.close(); }
});

it('clears the consecutive failure budget only after a complete valid poll', async () => {
  const fail = () => { throw Object.assign(new TypeError('PRIVATE'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); };
  const x = await fixture([fail, empty, fail, empty]);
  try { await vi.waitFor(() => expect(x.polls).toBe(6)); expect(x.sourceSignal?.aborted).toBe(false); }
  finally { await x.close(); }
});

it('does not retry a preconnect failure without any admitted call', async () => {
  const x = await fixture([() => { throw new Error('net::ERR_CONNECTION_REFUSED'); }], { noActiveCall: true });
  try { await vi.waitFor(() => expect(x.connected).toEqual([false, true, false])); expect(x.polls).toBe(2); }
  finally { await x.close(); }
});

it('does not treat a cancelled call that is still draining as active recovery authority', async () => {
  const x = await fixture([() => Response.json({ version: 1, requests: [{ version: 1, action: 'cancel', id: requestId }] }),
    () => { throw new Error('net::ERR_CONNECTION_REFUSED'); }], { lateDrain: true });
  try { await vi.waitFor(() => expect(x.sourceSignal?.aborted).toBe(true)); expect(x.polls).toBe(3); }
  finally { await x.close(); }
});

it('Stop during the recovery poll immediately closes the source without another poll or inference', async () => {
  const x = await fixture([() => { throw new Error('net::ERR_CONNECTION_REFUSED'); }]);
  try {
    await vi.waitFor(() => expect(x.polls).toBe(3)); await x.peer.stop();
    expect(x.closed).toBe(true); expect(x.inferCount).toBe(1); expect(x.polls).toBe(3);
  } finally { await x.close(); }
});

it('keeps ACK409 terminal for the source, without retrying or replaying inference', async () => {
  const x = await fixture([], { ackConflict: true });
  try {
    await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.inferCount).toBe(1);
    expect(x.replies).toHaveLength(1); expect(x.replies[0]?.stream).toBe('chunk');
  } finally { await x.close(); }
});

it('retains the request high-water mark across recovery and still receives a subsequent cancel', async () => {
  const go = gate();
  const x = await fixture([async signal => { await waitOrAbort(go.promise, signal); throw new Error('net::ERR_CONNECTION_REFUSED'); },
    () => Response.json({ version: 1, requests: [x.request, { version: 1, action: 'cancel', id: requestId }] })]);
  try {
    go.resolve(); await vi.waitFor(() => expect(x.closed).toBe(true));
    expect(x.inferCount).toBe(1); expect(x.sourceSignal?.aborted).toBe(true);
    expect(x.replies.filter(reply => reply.stream === 'chunk')).toHaveLength(1);
  } finally { await x.close(); }
});

it('does not reset the inference idle deadline when a poll recovers', async () => {
  vi.useFakeTimers();
  const nativeTimeout = AbortSignal.timeout;
  // Park the unrelated mock long poll; advance only the production infer idle clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 15000 ? new AbortController().signal : nativeTimeout(ms));
  const fail = gate();
  const x = await fixture([async signal => { await waitOrAbort(fail.promise, signal); throw new Error('net::ERR_CONNECTION_REFUSED'); }]);
  try {
    await vi.advanceTimersByTimeAsync(0); expect(x.replies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(119000); expect(x.sourceSignal?.aborted).toBe(false);
    fail.resolve(); await vi.advanceTimersByTimeAsync(0); expect(x.polls).toBe(3);
    await vi.advanceTimersByTimeAsync(1001); expect(x.sourceSignal?.aborted).toBe(true);
    expect(x.records).toContainEqual(expect.objectContaining({ stage: 'responses', category: 'timeout' }));
  } finally { await x.close(); }
});

it('retains the existing response oversize category while failing closed', async () => {
  const x = await fixture([() => { throw new Error('response too large'); }]);
  try {
    await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.polls).toBe(2);
    expect(x.records).toContainEqual(expect.objectContaining({ stage: 'peer_poll', category: 'response_oversize' }));
  } finally { await x.close(); }
});

it('never retries a TLS failure even if a nested error resembles a connect failure', async () => {
  const x = await fixture([() => { throw Object.assign(new Error('net::ERR_CERT_AUTHORITY_INVALID'), { cause: { code: 'ECONNREFUSED' } }); }]);
  try { await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.polls).toBe(2); }
  finally { await x.close(); }
});

it.each([
  ['ERR_ADDRESS_UNREACHABLE', () => new Error('net::ERR_ADDRESS_UNREACHABLE')],
  ['ENETUNREACH', () => Object.assign(new TypeError('PRIVATE'), { cause: { code: 'ENETUNREACH' } })],
  ['EHOSTUNREACH', () => Object.assign(new TypeError('PRIVATE'), { cause: { code: 'EHOSTUNREACH' } })],
] as const)('does not retry %s because routing errors can occur after an HTTP request was sent', async (_code, error) => {
  const x = await fixture([() => { throw error(); }]);
  try { await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.polls).toBe(2); }
  finally { await x.close(); }
});

it.each([
  ['unknown Chrome', () => Object.assign(new Error('net::ERR_PRIVATE_NEW'), { cause: { code: 'ECONNREFUSED' } })],
  ['permission Chrome', () => Object.assign(new Error('net::ERR_ACCESS_DENIED'), { cause: { code: 'ECONNREFUSED' } })],
  ['primary Node TLS', () => Object.assign(new TypeError('PRIVATE'), { code: 'CERT_HAS_EXPIRED', cause: { code: 'ECONNREFUSED' } })],
] as const)('does not let a safe cause override %s', async (_name, error) => {
  const x = await fixture([() => { throw error(); }]);
  try { await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.polls).toBe(2); }
  finally { await x.close(); }
});

it('does not let a safe cause override an unknown primary Node error code', async () => {
  const x = await fixture([() => { throw Object.assign(new TypeError('PRIVATE'), { code: 'PRIVATE_UNKNOWN_CODE', cause: { code: 'ECONNREFUSED' } }); }]);
  try { await vi.waitFor(() => expect(x.closed).toBe(true)); expect(x.polls).toBe(2); expect(JSON.stringify(x.records)).not.toContain('PRIVATE'); }
  finally { await x.close(); }
});


it('keeps legacy polling fail-closed for a 502 without negotiated receipts', async () => {
  const f = await fixture([() => new Response('', { status: 502 })]);
  try {
    await vi.waitFor(() => expect(f.closed).toBe(true));
    expect(f.polls).toBe(2); expect(f.inferCount).toBe(1); expect(f.sourceSignal?.aborted).toBe(true);
  } finally { await f.close(); }
});
