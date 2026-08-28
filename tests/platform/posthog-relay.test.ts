import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { proxyPostHogRelay } from '../../packages/platform/src/posthog-relay.js';

describe('platform PostHog relay', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('forwards the public Conversations token without forwarding Matrix authorization', async () => {
    const upstreamFetch = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', upstreamFetch);
    const app = new Hono();
    app.all('/relay/*', (c) => proxyPostHogRelay(c, { logRouteError: vi.fn() }));

    const response = await app.request('/relay/api/conversations/v1/widget/message?ip=0', {
      method: 'POST',
      headers: {
        authorization: 'Bearer matrix-session-token',
        'content-type': 'application/json',
        origin: 'null',
        referer: 'https://app.matrix-os.com/',
        'x-conversations-token': 'public-widget-token',
      },
      body: JSON.stringify({ message: 'support request' }),
    });

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe('https://eu.i.posthog.com/api/conversations/v1/widget/message?ip=0');
    expect(headers.get('x-conversations-token')).toBe('public-widget-token');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('referer')).toBe('https://app.matrix-os.com/');
  });
});
