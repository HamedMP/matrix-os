import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createSitePlatformClient, SitePlatformError } from '../../packages/gateway/src/sites/platform-client.js';
import { createSiteRoutes } from '../../packages/gateway/src/sites/routes.js';
import { markAuthContextReady, setPlatformVerifiedPrincipal } from '../../packages/gateway/src/request-principal.js';

// Outcome: the owner's Share popover can read and save link-preview settings
// through the gateway. Faults detected: forwarding unvalidated bodies, letting
// a collaborator edit, accepting a malformed platform response, and treating
// an older platform without the resource as a server failure.

const settings = { title: 'Party', description: null, imagePath: 'og.png', imageOptions: ['og.png'] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('platform social transport', () => {
  const client = () => createSitePlatformClient({ url: 'https://platform.example', token: 'machine-token', handle: 'owner', runtimeSlot: 'main' });
  it('reads and writes the social resource with a validated response', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(settings)));
    vi.stubGlobal('fetch', fetch);
    expect(await client().social('event')).toEqual(settings);
    expect(await client().social('event', { title: 'Party', description: null, imagePath: 'og.png' })).toEqual(settings);
    expect(fetch.mock.calls.map(([url, options]) => [new URL(String(url)).pathname, options.method])).toEqual([
      ['/internal/containers/owner/sites/event/social', 'GET'], ['/internal/containers/owner/sites/event/social', 'PATCH'],
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...settings, imagePath: 'https://evil.example/x.png' }))));
    await expect(client().social('event')).rejects.toMatchObject({ status: 503 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));
    await expect(client().social('event')).rejects.toMatchObject({ status: 404 });
  });
});

describe('owner social routes', () => {
  function ownerApp(user = 'owner', social = vi.fn().mockResolvedValue(settings)) {
    const app = new Hono();
    app.use('*', async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, user); await next(); });
    app.route('/', createSiteRoutes({ homePath: '/unused', ownerIds: ['owner'], platform: { request: vi.fn(), social } as never, submissions: null }));
    return { app, social };
  }
  const patch = (body: string) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body });

  it('forwards validated reads and writes for the owner only', async () => {
    const { app, social } = ownerApp();
    expect(await (await app.request('/api/apps/event/site/social')).json()).toEqual(settings);
    expect((await app.request('/api/apps/event/site/social', patch(JSON.stringify({ title: 'Party', description: null, imagePath: 'og.png' })))).status).toBe(200);
    expect(social).toHaveBeenNthCalledWith(1, 'event');
    expect(social).toHaveBeenNthCalledWith(2, 'event', { title: 'Party', description: null, imagePath: 'og.png' });
    for (const body of [JSON.stringify({ title: null, description: null, imagePath: 'https://evil.example/x.png' }), JSON.stringify({ title: 'x' }), '{']) {
      expect((await app.request('/api/apps/event/site/social', patch(body))).status).toBe(400);
    }
    expect(social).toHaveBeenCalledTimes(2);
    const collaborator = ownerApp('collaborator');
    expect((await collaborator.app.request('/api/apps/event/site/social')).status).toBe(403);
    expect(collaborator.social).not.toHaveBeenCalled();
  });

  it('maps platform failures to safe statuses', async () => {
    const { app } = ownerApp('owner', vi.fn().mockRejectedValue(new SitePlatformError(404)));
    const response = await app.request('/api/apps/event/site/social');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Site not found' });
  });
});
