import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlatformIntegrationTransport } from '../../../packages/gateway/src/bots/integration-client.js';
import { createInternalIntegrationGuard } from '../../../packages/platform/src/internal-integration-guard.js';
import { GOOGLE_PROCESSING_HEADER, verifyGoogleProcessingEnvelope } from '../../../packages/gateway/src/google-data/runtime/envelope.js';

const OWNER = 'user_pacing_fixture';
const request = (path = '/') => ({ method: 'GET' as const, path, signal: new AbortController().signal });
const json = () => Response.json({ ok: true });
const TOKEN = 'synthetic-machine-token';
const claim = () => ({ ownerId: OWNER, googleAccountId: 'reviewed', runId: 'run_fixture',
  runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1',
  profileId: '00000000-0000-4000-8000-000000000001', profileRevision: 1,
  consentId: '00000000-0000-4000-8000-000000000002', consentRevision: 1,
  purposeId: 'mail-assistance', routeDigest: 'b'.repeat(64),
  policyExpiresAt: new Date(60_000).toISOString(), collectionExpiresAt: new Date(60_000).toISOString() });

describe('platform integration request pacing', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('completes a consent-sized burst through the actual unchanged platform guard', async () => {
    const app = new Hono();
    const guard = createInternalIntegrationGuard();
    app.use('*', async (c, next) => { c.set('internalContainerHandle' as never, 'fixture' as never); await next(); });
    app.use('*', guard.middleware);
    app.all('*', c => c.json({ ok: true }));
    const starts: number[] = [];
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/integrations', machineToken: 'fixture',
      fetchImpl: (async (url, init) => { starts.push(Date.now()); return app.request(String(url), init); }) as typeof fetch });
    const pending = Promise.all(Array.from({ length: 16 }, () => transport(OWNER, request())));
    await vi.runAllTimersAsync();
    expect((await pending).every(r => r.status === 200)).toBe(true);
    expect(guard.snapshot().limited).toBe(0);
    expect(starts.slice(1).every((at, i) => at - starts[i]! >= 500)).toBe(true);
  });

  it('removes cancelled waiting requests without dispatching and spaces later starts independently of responses', async () => {
    let release!: (response: Response) => void;
    const firstResponse = new Promise<Response>(resolve => { release = resolve; });
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => { paths.push(new URL(url).pathname); return paths.length === 1 ? firstResponse : json(); });
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/i', machineToken: 'fixture', fetchImpl: fetchImpl as never });
    const first = transport(OWNER, request('/first'));
    await vi.advanceTimersByTimeAsync(0);
    const abort = new AbortController();
    const second = transport(OWNER, { ...request('/cancelled'), signal: abort.signal }).then(() => 'sent', () => 'cancelled');
    const third = transport(OWNER, request('/third'));
    abort.abort();
    expect(await second).toBe('cancelled');
    expect(paths).toEqual(['/i/first']);
    await vi.advanceTimersByTimeAsync(600);
    expect(paths).toEqual(['/i/first', '/i/third']);
    release(json());
    await vi.runAllTimersAsync();
    await Promise.all([first, third]);
    expect(paths).toEqual(['/i/first', '/i/third']);
  });

  it('lets ordinary account checks finish within their existing deadline during a slow sync', async () => {
    let finish!: (response: Response) => void;
    const slow = new Promise<Response>(resolve => { finish = resolve; });
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('/sync') ? slow : Response.json([]));
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/i', machineToken: TOKEN, fetchImpl: fetchImpl as never });
    const syncing = transport(OWNER, { ...request('/sync'), method: 'POST' });
    await vi.advanceTimersByTimeAsync(0);
    const { createBotIntegrationClient } = await import('../../../packages/gateway/src/bots/integration-client.js');
    const inventory = createBotIntegrationClient(transport).inventory(OWNER);
    let done = false; void inventory.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(600);
    expect(done).toBe(true);
    expect(await inventory).toEqual([]);
    finish(json()); await syncing;
  });

  it('bounds outstanding work and never replays an uncertain write response', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/i', machineToken: 'fixture', fetchImpl: fetchImpl as never });
    const pending = Array.from({ length: 40 }, () => transport(OWNER, { ...request('/call'), method: 'POST' as const,
      body: { service: 'gmail', action: 'create_label' } }).then(r => r.status, () => 'refused'));
    await vi.runAllTimersAsync();
    const result = await Promise.all(pending);
    expect(result.filter(x => x === 'refused').length).toBeGreaterThan(0);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(16);
    expect(fetchImpl.mock.calls.length).toBe(result.filter(x => x === 503).length);
  });

  it('does not poison the queue after a failed fetch and refuses an already-aborted request', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('fixture')).mockResolvedValueOnce(json());
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/i', machineToken: 'fixture', fetchImpl });
    const aborted = new AbortController(); aborted.abort();
    const denied = transport(OWNER, { ...request(), signal: aborted.signal }).then(() => false, () => true);
    const first = transport(OWNER, request('/first')).then(() => false, () => true);
    const second = transport(OWNER, request('/second'));
    await vi.runAllTimersAsync();
    expect(await denied).toBe(true);
    expect(await first).toBe(true);
    expect((await second).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('preserves the reviewed target while queued and signs only when dispatched', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/i', machineToken: TOKEN,
      fetchImpl: (async (url, init) => { calls.push({ url: String(url), init: init! }); return json(); }) as typeof fetch });
    const first = transport(OWNER, request('/first'));
    const queued = { ...request('/read-call'), method: 'POST' as const, processingClaim: claim(),
      body: { service: 'gmail', connectionId: 'reviewed', action: 'get_thread_ids', params: { threadId: 'selected' } } };
    const second = transport(OWNER, queued);
    queued.path = '/call'; queued.body.params.threadId = 'different';
    queued.processingClaim.consentRevision = 99;
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(calls[1]!.url).toBe('https://fixture.invalid/i/read-call');
    expect(JSON.parse(String(calls[1]!.init.body)).params.threadId).toBe('selected');
    expect(verifyGoogleProcessingEnvelope(new Headers(calls[1]!.init.headers).get(GOOGLE_PROCESSING_HEADER)!, {
      ownerId: OWNER, machineToken: TOKEN, method: 'POST', path: '/read-call', body: String(calls[1]!.init.body),
    })).toMatchObject({ issuedAt: 600, consentRevision: 1 });
  });

  it('aborts during spacing without sending and drains cancelled slots for later work', async () => {
    const starts: number[] = [];
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/i', machineToken: 'fixture',
      fetchImpl: (async () => { starts.push(Date.now()); return json(); }) as typeof fetch });
    await transport(OWNER, request());
    const abort = new AbortController();
    const waiting = transport(OWNER, { ...request(), signal: abort.signal }).then(() => false, () => true);
    await vi.advanceTimersByTimeAsync(100); abort.abort();
    expect(await waiting).toBe(true);
    const next = transport(OWNER, request());
    await vi.runAllTimersAsync(); await next;
    expect(starts).toEqual([0, 600]);
  });

  it('refuses authority that expires while queued without renewing it or fetching', async () => {
    const fetchImpl = vi.fn(async () => json());
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/i', machineToken: TOKEN, fetchImpl });
    await transport(OWNER, request());
    const expired = transport(OWNER, { ...request('/read-call'), method: 'POST',
      body: { service: 'gmail', connectionId: 'reviewed' },
      processingClaim: { ...claim(), collectionExpiresAt: new Date(400).toISOString() },
    }).then(() => false, () => true);
    await vi.runAllTimersAsync();
    expect(await expired).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds active fetches and does not dispatch cancelled work waiting for active capacity', async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { releases.push(resolve); }));
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/i', machineToken: TOKEN, fetchImpl });
    const abort = new AbortController();
    const pending = Array.from({ length: 8 }, () => transport(OWNER, { ...request(), signal: abort.signal }).catch(() => null));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    abort.abort();
    await Promise.all(pending);
    const next = transport(OWNER, request());
    await vi.advanceTimersByTimeAsync(600);
    // These injected fetches ignore abort. Caller cancellation must not free
    // their active capacity before actual response settlement.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    releases.forEach(resolve => resolve(json()));
    await vi.runAllTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    releases[4]!(json()); await next;
  });

  it('releases active capacity after an aborted fetch settles and preserves later progress', async () => {
    const fetchImpl = vi.fn((async (_url, init) => {
      if (fetchImpl.mock.calls.length > 1) return json();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }) as typeof fetch);
    const transport = createPlatformIntegrationTransport({ baseUrl: 'https://fixture.invalid/i', machineToken: TOKEN, fetchImpl });
    const abort = new AbortController();
    const first = transport(OWNER, { ...request(), signal: abort.signal }).catch(() => null);
    await vi.advanceTimersByTimeAsync(0); abort.abort(); await first;
    const second = transport(OWNER, request());
    await vi.runAllTimersAsync(); expect((await second).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
