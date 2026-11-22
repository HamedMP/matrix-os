import { describe, expect, it } from 'vitest';
import { createOwnedCloudflareClient, OwnedCloudflareError } from '../../packages/platform/src/owned-machines/cloudflare.js';
import { loadOwnedMachinesConfig } from '../../packages/platform/src/owned-machines/config.js';

const CF = { apiBase: 'https://cf.test/client/v4', accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), apiToken: 't'.repeat(40) };
const TUNNEL = '11111111-2222-4333-8444-555555555555';

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const seen: Array<{ url: string; method: string; body?: string; redirect?: string; signal: boolean }> = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined, redirect: init.redirect, signal: Boolean(init.signal) });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, seen };
}

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });

describe('owned machine Cloudflare client', () => {
  it('creates a remotely managed tunnel with a timeout and no redirects', async () => {
    const { impl, seen } = fakeFetch(() => ok({ id: TUNNEL, name: 'matrix-owned-x', token: 'abc' }));
    const tunnel = await createOwnedCloudflareClient(CF, impl).createTunnel('matrix-owned-x');
    expect(tunnel.id).toBe(TUNNEL);
    expect(seen[0]).toMatchObject({ method: 'POST', redirect: 'error', signal: true });
    expect(JSON.parse(seen[0]!.body!)).toEqual({ name: 'matrix-owned-x', config_src: 'cloudflare' });
  });

  it('configures ingress with a catch-all rule', async () => {
    const { impl, seen } = fakeFetch(() => ok({}));
    await createOwnedCloudflareClient(CF, impl).configureTunnel(TUNNEL, 'h.m.example.net', 'http://127.0.0.1:8790');
    expect(JSON.parse(seen[0]!.body!).config.ingress).toEqual([
      { hostname: 'h.m.example.net', service: 'http://127.0.0.1:8790', originRequest: {} },
      { service: 'http_status:404' },
    ]);
  });

  it('treats a missing tunnel on delete as done and 5xx as retryable', async () => {
    const gone = fakeFetch(() => new Response('', { status: 404 }));
    await expect(createOwnedCloudflareClient(CF, gone.impl).deleteTunnel(TUNNEL)).resolves.toBeUndefined();
    const down = fakeFetch(() => new Response('', { status: 503 }));
    const err = await createOwnedCloudflareClient(CF, down.impl).createTunnel('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnedCloudflareError);
    expect((err as OwnedCloudflareError).retryable).toBe(true);
    expect((err as Error).message).not.toContain(CF.apiToken);
  });

  it('rejects malformed provider results and tunnel ids', async () => {
    const bad = fakeFetch(() => ok({ id: 'not-a-uuid', name: 'x' }));
    await expect(createOwnedCloudflareClient(CF, bad.impl).createTunnel('x')).rejects.toBeInstanceOf(OwnedCloudflareError);
    await expect(createOwnedCloudflareClient(CF, bad.impl).getTunnelToken('../x')).rejects.toBeInstanceOf(OwnedCloudflareError);
  });
});

describe('owned machine config', () => {
  const base = { publicUrl: 'https://app.example.com/', platformInternalUrl: 'https://p.example.com', platformSecret: 'x'.repeat(40),
    fundedAiEnabled: false, fundedAiRelayUrl: '', platformSpeechEnabled: false };
  const env = {
    MATRIX_OWNED_MACHINES_ENABLED: 'true', MATRIX_OWNED_CF_ACCOUNT_ID: 'a'.repeat(32), MATRIX_OWNED_CF_ZONE_ID: 'b'.repeat(32),
    MATRIX_OWNED_CF_API_TOKEN: 't'.repeat(40), MATRIX_OWNED_HOST_SUFFIX: 'm.example.net',
    MATRIX_OWNED_ACCESS_CLIENT_ID: 'client-id-1', MATRIX_OWNED_ACCESS_CLIENT_SECRET: 'client-secret-123456',
  };

  it('is disabled unless explicitly enabled', () => {
    expect(loadOwnedMachinesConfig({}, base)).toEqual({ status: 'disabled' });
  });

  it('reports which settings are missing without echoing values', () => {
    const result = loadOwnedMachinesConfig({ ...env, MATRIX_OWNED_CF_API_TOKEN: undefined }, base);
    expect(result).toEqual({ status: 'misconfigured', missing: ['MATRIX_OWNED_CF_API_TOKEN'] });
  });

  it('defaults the ingress to the loopback tunnel server', () => {
    const result = loadOwnedMachinesConfig(env, base);
    expect(result.status === 'ready' && result.config.ingressService).toBe('http://127.0.0.1:8790');
    expect(result.status === 'ready' && result.config.publicUrl).toBe('https://app.example.com');
  });
});
