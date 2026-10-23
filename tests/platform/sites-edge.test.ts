import { expect, it, vi } from 'vitest';
import worker from '../../packages/edge-router/src/sites.js';
it.each(['/launch-2026', '/launch-2026/frame', '/launch-2026/assets/11111111-1111-4111-8111-111111111111/assets/main.js'])('serves accepted public reads with query-bearing references (%s)', async path => {
 const forward = vi.fn(async (_request: Request) => new Response('app'));
 vi.stubGlobal('fetch', forward);
 try {
  const response = await worker.fetch(new Request(`https://matrix.page${path}?v=3&visitor=private`), { SITES_PLATFORM_ORIGIN: 'https://platform.example.com', SITES_EDGE_SECRET: 'x'.repeat(40) });
  expect(response.status).toBe(200);
  expect(forward).toHaveBeenCalledOnce();
  expect(forward.mock.calls[0]![0].url).toBe(`https://platform.example.com/public/sites${path}`);
 } finally { vi.unstubAllGlobals(); }
});
it('rejects query-bearing form requests without forwarding them', async () => {
 const forward = vi.fn(async (_request: Request) => new Response('app'));
 vi.stubGlobal('fetch', forward);
 try {
  const response = await worker.fetch(new Request('https://matrix.page/launch-2026/forms/rsvp?token=private', { method: 'POST', body: '{}' }), { SITES_PLATFORM_ORIGIN: 'https://platform.example.com', SITES_EDGE_SECRET: 'x'.repeat(40) });
  expect(response.status).toBe(400); expect(forward).not.toHaveBeenCalled();
 } finally { vi.unstubAllGlobals(); }
});
it('redirects only the homepage to Matrix without forwarding queries or requiring site configuration', async () => {
 const forward = vi.fn(async () => new Response('app'));
 vi.stubGlobal('fetch', forward);
 const env = { SITES_PLATFORM_ORIGIN: '', SITES_EDGE_SECRET: '' };
 try {
  for (const method of ['GET', 'HEAD']) {
   const response = await worker.fetch(new Request('https://matrix.page/?visitor=private', { method }), env);
   expect(response.status).toBe(302);
   expect(response.headers.get('location')).toBe('https://matrix-os.com');
   expect(response.headers.get('cache-control')).toBe('no-store');
   expect(await response.text()).toBe('');
  }
  expect(forward).not.toHaveBeenCalled();
  expect((await worker.fetch(new Request('https://matrix.page/', { method: 'POST' }), env)).status).toBe(404);
  const app = await worker.fetch(new Request('https://matrix.page/launch-2026'), { SITES_PLATFORM_ORIGIN: 'https://platform.example.com', SITES_EDGE_SECRET: 'x'.repeat(40) });
  expect(app.status).toBe(200); expect(await app.text()).toBe('app');
  expect(forward).toHaveBeenCalledOnce();
 } finally { vi.unstubAllGlobals(); }
});
it('only forwards sites routes and strips visitor credentials', async () => {
    const forward = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', forward);
    try {
        const response = await worker.fetch(new Request('https://matrix.page/launch-2026/forms/rsvp', {
            method: 'POST', headers: { authorization: 'secret', cookie: 'private', 'x-forwarded-for': 'fake', 'content-type': 'application/json' }, body: '{}',
        }), { SITES_PLATFORM_ORIGIN: 'https://platform.example.com', SITES_EDGE_SECRET: 'x'.repeat(40) });
        expect(response.status).toBe(200);
        const request = forward.mock.calls[0]![0] as Request;
        expect(request.url).toBe('https://platform.example.com/public/sites/launch-2026/forms/rsvp');
        expect(request.headers.get('authorization')).toBeNull();
        expect(request.headers.get('cookie')).toBeNull();
        expect(request.headers.get('x-forwarded-for')).toBeNull();
        expect(request.headers.get('x-matrix-sites-edge')).toBe('x'.repeat(40));
        expect((await worker.fetch(new Request('https://matrix.page/api/private'), { SITES_PLATFORM_ORIGIN: 'https://platform.example.com', SITES_EDGE_SECRET: 'x'.repeat(40) })).status).toBe(404);
    }
    finally {
        vi.unstubAllGlobals();
    }
});
it('logs only coarse error types and keeps configuration/upstream failures generic', async () => {
 const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
 const forward = vi.fn().mockRejectedValue(new TypeError('private upstream credential'));
 vi.stubGlobal('fetch', forward);
 try {
  const request = () => new Request('https://matrix.page/launch-2026');
  const bad = await worker.fetch(request(), { SITES_PLATFORM_ORIGIN: 'not-a-url', SITES_EDGE_SECRET: 'x'.repeat(40) });
  expect(bad.status).toBe(503); expect(await bad.text()).toBe('Site unavailable');
  const failed = await worker.fetch(request(), { SITES_PLATFORM_ORIGIN: 'https://platform.example.com', SITES_EDGE_SECRET: 'x'.repeat(40) });
  expect(failed.status).toBe(503); expect(await failed.text()).toBe('Site unavailable');
  expect(log).toHaveBeenCalledTimes(2); expect(JSON.stringify(log.mock.calls)).not.toContain('credential');
 } finally { log.mockRestore(); vi.unstubAllGlobals(); }
});
it('keeps request body stream failures generic instead of throwing upstream details', async () => {
 const body = new ReadableStream({ start(controller) { controller.error(new Error('private stream details')); } });
 const request = new Request('https://matrix.page/launch-2026/forms/rsvp', { method: 'POST', body, duplex: 'half' } as RequestInit);
 const response = await worker.fetch(request, { SITES_PLATFORM_ORIGIN: 'https://platform.example.com', SITES_EDGE_SECRET: 'x'.repeat(40) });
 expect(response.status).toBe(400); expect(await response.text()).toBe('Invalid submission');
});
