import { createHash } from 'node:crypto';
import { MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN, serializeManagedGoogleRouteDescriptor } from '@matrix-os/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleQualifiedCredentialManager } from '../../packages/gateway/src/google-data/managed/credential-manager.js';
import { qualifiedRouteFixture, qualifiedLeaseFixture, qualifiedNow as at } from '../helpers/google-qualified-funded-fixture.js';
const protocol = 'matrix-google-qualified-funded-v1';
const config = () => ({ issueUrl: 'https://platform.example.test/internal/containers/qualified-one/ai/funded-credential?runtimeSlot=primary', fundingSummaryUrl: '', routeReadinessUrl: '',
  relayBaseUrl: qualifiedRouteFixture().relayBaseUrl, runtimeAuthToken: 'r'.repeat(32), identity: { ownerId: 'owner_one', machineId: 'machine_one', runtimeSlot: 'primary' }, maxRunMs: 60000, requestTimeoutMs: 500 });
const request = () => ({ api: 'openai-completions' as const, canonicalModelId: qualifiedRouteFixture().canonicalModelId, requestClass: 'interactive' as const });
function issued() { const lease = qualifiedLeaseFixture(); lease.credential.token = `sk-matrix-google-funded-${lease.credential.tokenId}.${'s'.repeat(43)}`;
  return { protocol, lease, binding: { ...qualifiedRouteFixture(), requestClass: 'interactive' } }; }
function fixture() { const response = issued(); const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => String(url).includes('/managed-route')
  ? Response.json({ protocol, route: qualifiedRouteFixture() }) : Response.json(response));
  const manager = createGoogleQualifiedCredentialManager(config(), { fetchFn: fetch, now: () => at.getTime() }); return { manager, fetch, response }; }
describe('exact qualified lease manager', () => {
  it('discovers current server route and caches only exact class/API/model/digest leases', async () => {
    const { manager, fetch } = fixture(); try { const first = await manager.getCredential(request()); expect(first.token).toMatch(/^sk-matrix-google-funded-/);
      expect(JSON.stringify(first.binding)).not.toContain(first.token); expect(first.binding.descriptor.credential.fingerprint).toBe(qualifiedRouteFixture().descriptor.credential.fingerprint);
      expect(await manager.getCredential(request())).toEqual(first); expect(fetch.mock.calls.filter(([url]) => String(url).includes('/funded-credential'))).toHaveLength(1);
      expect(fetch.mock.calls.filter(([url]) => String(url).includes('/managed-route'))).toHaveLength(2);
      for (const [url, init] of fetch.mock.calls) { expect(String(url)).toContain('/ai/qualified/'); expect(init?.redirect).toBe('error');
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${config().runtimeAuthToken}`); expect(new Headers(init?.headers).get('content-length')).toBe(String(Buffer.byteLength(String(init?.body)))); }
    } finally { await manager.close(); }
  });
  it.each(['class', 'digest', 'owner', 'relay', 'legacy'])('rejects mismatched %s issuance without caching or legacy retry', async mismatch => {
    const f = fixture(); const value: any = f.response;
    if (mismatch === 'class') value.lease.requestClass = 'background'; if (mismatch === 'digest') value.binding.digest = 'd'.repeat(64);
    if (mismatch === 'owner') value.lease.identity.ownerId = 'other'; if (mismatch === 'relay') value.binding.relayBaseUrl = 'https://other.example.test';
    if (mismatch === 'legacy') value.lease.credential.token = `sk-matrix-funded-token_one.${'s'.repeat(43)}`;
    try { await expect(f.manager.getCredential(request())).rejects.toThrow('Qualified AI unavailable'); expect(f.fetch).toHaveBeenCalledTimes(2); }
    finally { await f.manager.close(); }
  });
  it('never serves a cached lease when current control is unavailable', async () => {
    const f = fixture(); try { await f.manager.getCredential(request()); f.fetch.mockResolvedValue(Response.json({ error: 'private failure' }, { status: 503 }));
      await expect(f.manager.getCredential(request())).rejects.toThrow('Qualified AI unavailable'); expect(f.fetch).toHaveBeenCalledTimes(3);
    } finally { await f.manager.close(); }
  });
  it('isolates returned cached objects and invalidates exact tokens without legacy acquisition', async () => {
    const f = fixture(); try { const first = await f.manager.getCredential(request()); first.binding.descriptor.routeRevision = 999;
      expect((await f.manager.getCredential(request())).binding.descriptor.routeRevision).toBe(1); f.manager.invalidate(first.tokenId);
      expect((await f.manager.getCredential(request())).binding.descriptor.routeRevision).toBe(1);
      expect(f.fetch.mock.calls.filter(([url]) => String(url).includes('/funded-credential'))).toHaveLength(2);
    } finally { await f.manager.close(); }
  });
  it('refuses a different requested class instead of borrowing the interactive cache', async () => {
    const f = fixture(); try { await f.manager.getCredential(request()); await expect(f.manager.getCredential({ ...request(), requestClass: 'background' })).rejects.toThrow('Qualified AI unavailable');
      expect(f.fetch.mock.calls.filter(([url]) => String(url).includes('/funded-credential'))).toHaveLength(2);
    } finally { await f.manager.close(); }
  });
  it('caps independent concurrent operations and closes all readers without a pool of queued work', async () => {
    const cancel = vi.fn(); const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel })));
    const manager = createGoogleQualifiedCredentialManager(config(), { fetchFn: fetch, now: () => at.getTime() });
    const pending = Array.from({ length: 4 }, () => manager.resolveRoute(request()).catch(error => error));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4)); await expect(manager.resolveRoute(request())).rejects.toThrow('Qualified AI unavailable');
    expect(fetch).toHaveBeenCalledTimes(4); await manager.close(); expect((await Promise.all(pending)).every(value => value instanceof Error)).toBe(true); expect(cancel).toHaveBeenCalledTimes(4);
  });
  it('does not commit a lease invalidated while an actual response body awaits', async () => {
    const f = fixture(); f.fetch.mockImplementation(async url => {
      if (String(url).includes('/managed-route')) return Response.json({ protocol, route: qualifiedRouteFixture() });
      f.manager.invalidate(); return Response.json(f.response);
    });
    try { await expect(f.manager.getCredential(request())).rejects.toThrow('Qualified AI unavailable'); expect(f.fetch).toHaveBeenCalledTimes(2); }
    finally { await f.manager.close(); }
  });
  it.each(['oversize', 'chunks', 'timeout', 'aborted'])('bounds %s HTTP bodies and cancels rejected readers', async mode => {
    const cancel = vi.fn(), controller = new AbortController(); const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream<Uint8Array>({ pull(c) {
      if (mode === 'oversize') c.enqueue(new Uint8Array(65537)); else if (mode === 'chunks') c.enqueue(new Uint8Array([32]));
      else { if (mode === 'aborted') queueMicrotask(() => controller.abort()); return new Promise(() => undefined); }
    }, cancel })));
    const manager = createGoogleQualifiedCredentialManager(config(), { fetchFn: fetch, now: () => at.getTime() });
    try { await expect(manager.resolveRoute(request(), controller.signal)).rejects.toThrow('Qualified AI unavailable'); expect(cancel).toHaveBeenCalledOnce(); } finally { await manager.close(); }
  });
  it('evicts the oldest of32 exact route entries instead of growing with operator revisions', async () => {
    let revision = 1; const route = () => { const value = qualifiedRouteFixture(); value.descriptor.routeRevision = revision;
      value.digest = createHash('sha256').update(MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN).update(serializeManagedGoogleRouteDescriptor(value.descriptor)).digest('hex'); return value; };
    const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).includes('/managed-route') ? Response.json({ protocol, route: route() })
      : Response.json({ ...issued(), binding: { ...route(), requestClass: 'interactive' } }));
    const manager = createGoogleQualifiedCredentialManager(config(), { fetchFn: fetch, now: () => at.getTime() });
    try { for (revision = 1; revision <= 33; revision++) await manager.getCredential(request());
      expect(fetch.mock.calls.filter(([url]) => String(url).includes('/funded-credential'))).toHaveLength(33); revision = 1; await manager.getCredential(request());
      expect(fetch.mock.calls.filter(([url]) => String(url).includes('/funded-credential'))).toHaveLength(34);
    } finally { await manager.close(); }
  });
  it('refreshes before lease expiry and never returns a short remaining cached lifetime', async () => {
    let clock = at.getTime(); const value = issued(); const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).includes('/managed-route')
      ? Response.json({ protocol, route: qualifiedRouteFixture() }) : Response.json(value));
    const manager = createGoogleQualifiedCredentialManager(config(), { fetchFn: fetch, now: () => clock });
    try { await manager.getCredential(request()); clock += 14 * 60000;
      await expect(manager.getCredential(request())).rejects.toThrow('Qualified AI unavailable');
      expect(fetch.mock.calls.filter(([url]) => String(url).includes('/funded-credential'))).toHaveLength(2);
    } finally { await manager.close(); }
  });
  it('aborting one caller does not cancel another independently admitted request', async () => {
    const cancel = vi.fn(), caller = new AbortController(); const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel })));
    const manager = createGoogleQualifiedCredentialManager(config(), { fetchFn: fetch, now: () => at.getTime() });
    const first = manager.resolveRoute(request(), caller.signal).catch(error => error), second = manager.resolveRoute(request()).catch(error => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); caller.abort(); expect(await first).toBeInstanceOf(Error); expect(cancel).toHaveBeenCalledOnce();
    await manager.close(); expect(await second).toBeInstanceOf(Error); expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('never shares cancellation ownership and drains active HTTP readers on shutdown', async () => {
    const cancel = vi.fn(); const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel })));
    const manager = createGoogleQualifiedCredentialManager(config(), { fetchFn: fetch, now: () => at.getTime() });
    const pending = manager.resolveRoute(request(), new AbortController().signal); const outcome = expect(pending).rejects.toThrow('Qualified AI unavailable');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); await manager.close(); await outcome; expect(cancel).toHaveBeenCalledOnce();
    await expect(manager.getCredential(request())).rejects.toThrow('Qualified AI unavailable');
  });
});
