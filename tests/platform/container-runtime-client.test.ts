import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createContainerRuntimeClient, type RuntimeTarget } from '../../packages/platform/src/substrates/container-runtime-client.js';

const SECRET = 's'.repeat(48);
const NOW = new Date('2026-11-12T09:00:00.000Z');
const TARGET: RuntimeTarget = {
  machineId: 'ctr-1', handle: 'idle-alice', clerkUserId: 'user_idle_a', unitId: 'mvm-1',
  endpointHost: 'mvm-1.lambda-microvm.eu-west-1.on.aws',
};
const DIGEST = `sha256:${'c'.repeat(64)}`;

function client(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => reply(String(url), init ?? {}));
  const provider = {
    mintEndpointCredential: vi.fn(async () => ({ headers: { 'x-aws-proxy-auth': 'unit-token' }, expiresAt: new Date(NOW.getTime() + 30 * 60_000) })),
  };
  const runtime = createContainerRuntimeClient({
    provider, platformSecret: SECRET, endpointHostSuffix: '.on.aws', fetch, now: () => NOW, logError: () => undefined,
  });
  return { runtime, fetch, provider };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('container runtime client', () => {
  it('calls the gateway with the endpoint credential, the platform token, and the owner proof, with a timeout and no redirects', async () => {
    const { runtime, fetch } = client(() => json(200, { unsettledRuns: 2 }));
    expect(await runtime.quiesce(TARGET, AbortSignal.timeout(5_000))).toEqual({ ok: true, unsettledRuns: 2 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://mvm-1.lambda-microvm.eu-west-1.on.aws/internal/runtime/quiesce');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    const bearer = buildPlatformVerificationToken('idle-alice', SECRET);
    expect(headers.get('x-aws-proxy-auth')).toBe('unit-token');
    expect(headers.get('authorization')).toBe(`Bearer ${bearer}`);
    expect(headers.get('x-platform-user-id')).toBe('user_idle_a');
    expect(headers.get('x-platform-verified')).toBe(createHmac('sha256', bearer).update('user_idle_a').digest('hex'));
  });

  it('reuses a minted credential across calls to the same unit', async () => {
    const { runtime, provider } = client(() => json(200, { unsettledRuns: 0 }));
    await runtime.quiesce(TARGET, AbortSignal.timeout(5_000));
    await runtime.quiesce(TARGET, AbortSignal.timeout(5_000));
    expect(provider.mintEndpointCredential).toHaveBeenCalledTimes(1);
  });

  it('maps gateway refusals to fixed outcomes', async () => {
    expect(await client(() => json(409, { error: 'busy' })).runtime.quiesce(TARGET, AbortSignal.timeout(5_000)))
      .toEqual({ ok: false, error: 'busy' });
    expect(await client(() => json(503, { error: 'unavailable' })).runtime.quiesce(TARGET, AbortSignal.timeout(5_000)))
      .toEqual({ ok: false, error: 'unavailable' });
    expect(await client(() => json(503, { error: 'flush_failed' })).runtime.flush(TARGET, AbortSignal.timeout(5_000)))
      .toEqual({ ok: false, error: 'flush_failed' });
    expect(await client(() => json(503, { error: 'not_ready' })).runtime.flush(TARGET, AbortSignal.timeout(5_000)))
      .toEqual({ ok: false, error: 'not_ready' });
    expect(await client(() => { throw new TypeError('fetch failed'); }).runtime.flush(TARGET, AbortSignal.timeout(5_000)))
      .toEqual({ ok: false, error: 'unavailable' });
    expect(await client(() => new Response('x'.repeat(10_000), { status: 200 })).runtime.quiesce(TARGET, AbortSignal.timeout(5_000)))
      .toEqual({ ok: false, error: 'unavailable' });
  });

  it('stops reading an oversized reply at the limit and cancels the rest of the stream', async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x61));
      },
      cancel() { cancelled = true; },
    });
    const { runtime } = client(() => new Response(endless, { status: 200 }));
    expect(await runtime.quiesce(TARGET, AbortSignal.timeout(5_000))).toEqual({ ok: false, error: 'unavailable' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(8);
  });

  it('accepts a flush only when the home and manifest are durable', async () => {
    const parts = { home: 'persisted', ownerDatabase: 'persisted', kernelDatabase: 'local_only' };
    expect(await client(() => json(200, { manifestDigest: DIGEST, parts })).runtime.flush(TARGET, AbortSignal.timeout(5_000)))
      .toEqual({ ok: true, manifestDigest: DIGEST });
    expect(await client(() => json(200, { manifestDigest: 'sha256:short', parts })).runtime.flush(TARGET, AbortSignal.timeout(5_000)))
      .toEqual({ ok: false, error: 'flush_failed' });
    expect(await client(() => json(200, { manifestDigest: DIGEST, parts: { ...parts, home: 'local_only' } }))
      .runtime.flush(TARGET, AbortSignal.timeout(5_000))).toEqual({ ok: false, error: 'flush_failed' });
  });

  it('refuses an endpoint outside the provider suffix without calling it', async () => {
    const { runtime, fetch, provider } = client(() => json(200, { unsettledRuns: 0 }));
    expect(await runtime.quiesce({ ...TARGET, endpointHost: '169.254.169.254' }, AbortSignal.timeout(5_000)))
      .toEqual({ ok: false, error: 'unavailable' });
    expect(await runtime.resume({ ...TARGET, endpointHost: 'evil.example.com' }, AbortSignal.timeout(5_000))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(provider.mintEndpointCredential).not.toHaveBeenCalled();
  });

  it('propagates the caller abort so a shutdown is not mistaken for an unreachable runtime', async () => {
    const controller = new AbortController();
    const { runtime } = client((_url, init) => new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason);
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const pending = runtime.quiesce(TARGET, controller.signal);
    controller.abort(new DOMException('shutdown', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
