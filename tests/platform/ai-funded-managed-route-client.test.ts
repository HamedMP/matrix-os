import { describe, expect, it, vi } from 'vitest';
import { createFundedManagedRouteClient } from '../../packages/platform/src/ai-funded-managed-route-client.js';
import { qualifiedNow, qualifiedRouteFixture } from '../helpers/google-qualified-funded-fixture.js';
describe('fixed qualified route control transport', () => {
  const token = 'synthetic-control-'.repeat(3); const selector = { api: 'openai-completions' as const, canonicalModelId: qualifiedRouteFixture().canonicalModelId };
  const response = () => Response.json({ descriptor: qualifiedRouteFixture().descriptor, digest: qualifiedRouteFixture().digest });
  it('uses only operator endpoint/auth and verifies actual returned descriptor/digest', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => { expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(new Headers(init?.headers).get('content-length')).toBe(String(Buffer.byteLength(JSON.stringify(selector))));
      return response(); });
    const client = createFundedManagedRouteClient({ relayBaseUrl: 'https://relay.example.test/private', controlToken: token, fetchFn, now: () => qualifiedNow });
    expect(await client.resolve(selector, new AbortController().signal)).toEqual(qualifiedRouteFixture());
    expect(fetchFn.mock.calls[0]![0]).toBe('https://relay.example.test/internal/google-managed-route/resolve');
  });
  it.each(['digest', 'relay', 'model', 'oversize', 'status'] as const)('rejects unsafe control result %s without fallback', async fault => {
    const value = qualifiedRouteFixture(); if (fault === 'digest') value.digest = 'f'.repeat(64);
    if (fault === 'relay') value.descriptor.relay.endpoint = 'https://wrong.example.test/v1/chat/completions';
    if (fault === 'model') value.descriptor.upstream.canonicalModelId = '@cf/meta/llama-4-scout-17b-16e-instruct' as any;
    const fetchFn = vi.fn<typeof fetch>(async () => fault === 'status' ? new Response('private', { status: 500 }) : fault === 'oversize' ? new Response('x'.repeat(65537)) : Response.json({ descriptor: value.descriptor, digest: value.digest }));
    const client = createFundedManagedRouteClient({ relayBaseUrl: 'https://relay.example.test/private', controlToken: token, fetchFn, now: () => qualifiedNow });
    await expect(client.resolve(selector, new AbortController().signal)).rejects.toThrow('Qualified AI unavailable'); expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['before review', '2026-10-21T11:59:59.999Z', false],
    ['at review', '2026-10-21T12:00:00.000Z', true],
    ['before expiry', '2026-10-23T11:59:59.999Z', true],
    ['at expiry', '2026-10-23T12:00:00.000Z', false],
    ['after expiry', '2026-10-23T12:00:00.001Z', false],
  ] as const)('enforces evidence validity %s with an explicit clock', async (_label, at, allowed) => {
    const fetchFn = vi.fn<typeof fetch>(async () => response());
    const client = createFundedManagedRouteClient({ relayBaseUrl: 'https://relay.example.test/private',
      controlToken: token, fetchFn, now: () => new Date(at) });
    const result = client.resolve(selector, new AbortController().signal);
    if (allowed) await expect(result).resolves.toEqual(qualifiedRouteFixture());
    else await expect(result).rejects.toThrow('Qualified AI unavailable');
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it('cancels a stalled response body on caller abort', async () => {
    const abort = new AbortController(); const cancelled = vi.fn(); const client = createFundedManagedRouteClient({ relayBaseUrl: 'https://relay.example.test/private', controlToken: token, now: () => qualifiedNow,
      fetchFn: async () => new Response(new ReadableStream({ pull() {}, cancel: cancelled })) });
    const task = client.resolve(selector, abort.signal); await new Promise(resolve => setTimeout(resolve, 10)); abort.abort();
    await expect(task).rejects.toThrow('Qualified AI unavailable'); expect(cancelled).toHaveBeenCalledOnce();
  });
});
