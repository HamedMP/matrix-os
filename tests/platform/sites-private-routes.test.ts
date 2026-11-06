import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
import type { SitesService } from '../../packages/platform/src/sites/service.js';

const siteId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const edgeSecret = 'verified-edge-proof-secret-1234567890';
const privateSite = {
  id: siteId, appSlug: 'launch', title: 'Private customer title', description: 'Private description', slug: null,
  url: `https://matrix.page/${siteId}`, revision: 1, status: 'published' as const, accessMode: 'private_link' as const,
  activeVersion: versionId, versions: [{ id: versionId, createdAt: '2026-11-05T00:00:00.000Z' }], config: { data: {}, forms: [] },
};
function fixture() {
  const resolve = vi.fn(async () => privateSite);
  const authorize = vi.fn(async () => null as typeof privateSite | null);
  const asset = vi.fn(async () => ({ body: Buffer.from('<h1>private app</h1>'), contentType: 'text/html', site: privateSite }));
  const privateFrame = vi.fn(async () => '<h1>private app</h1>');
  const admitted = vi.fn();
  const claimAccessLink = vi.fn(async () => ({
    cookie: `__Secure-matrix_site_viewer_${siteId.replaceAll('-', '')}=${randomUUID()}.${'s'.repeat(43)}; Path=/${siteId}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    link: { id: randomUUID(), status: 'claimed', createdAt: new Date().toISOString(), claimExpiresAt: new Date().toISOString(), claimedAt: new Date().toISOString(), sessionExpiresAt: new Date().toISOString() },
  }));
  const service = { resolve, authorize, asset, privateFrame, admitted, claimAccessLink } as unknown as SitesService;
  return { app: createSitePublicRoutes({ service, edgeSecret, submit: vi.fn() }), resolve, authorize, asset, privateFrame, admitted, claimAccessLink };
}
const request = (path: string, init: RequestInit = {}) => new Request(`https://platform.example.com${path}`, {
  ...init, headers: { 'x-matrix-sites-edge': edgeSecret, 'x-matrix-sites-source': '203.0.113.10', ...init.headers },
});

describe('private Matrix.page routes', () => {
  it('renders a generic explicit claim gate without leaking publication metadata', async () => {
    const { app } = fixture();
    const response = await app.request(request(`/${siteId}`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Open shared app');
    expect(html).toContain('location.hash');
    expect(html).not.toContain(privateSite.title);
    expect(html).not.toContain(privateSite.description);
    const cleared = response.headers.getSetCookie();
    expect(cleared).toContain(`__Secure-matrix_site_viewer_${siteId.replaceAll('-', '')}=; Path=/${siteId}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    expect(cleared.some(value => value.includes('_asset_'))).toBe(false);
  });

  it('denies private frames and assets before loading bytes when the viewer session is absent', async () => {
    const { app, asset } = fixture();
    for (const path of [
      `/${siteId}/frame`,
      `/${siteId}/assets/${versionId}/assets/main.js`,
    ]) expect((await app.request(request(path))).status).toBe(404);
    expect(asset).not.toHaveBeenCalled();
  });

  it('sets only the service-issued secure cookie after a same-origin explicit claim', async () => {
    const { app, claimAccessLink } = fixture();
    const linkId = randomUUID();
    const response = await app.request(request(`/${siteId}/access/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-matrix-sites-origin': 'same-origin' },
      body: JSON.stringify({ linkId, token: 't'.repeat(43) }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get('set-cookie')).toMatch(/^__Secure-matrix_site_viewer_/);
    expect(response.headers.get('set-cookie')).toContain(`Path=/${siteId};`);
    expect(claimAccessLink).toHaveBeenCalledWith(siteId, { linkId, token: 't'.repeat(43) });
  });

  it('serves an authorized private frame and passes the viewer cookie through form admission', async () => {
    const { app, authorize, admitted, asset, privateFrame } = fixture();
    authorize.mockResolvedValue(privateSite);
    admitted.mockImplementation(async (_reference, work) => work(privateSite, {}));
    const cookie = `__Secure-matrix_site_viewer_${siteId.replaceAll('-', '')}=${randomUUID()}.${'s'.repeat(43)}`;
    const frame = await app.request(request(`/${siteId}/frame`, { headers: { cookie } }));
    expect(frame.status).toBe(200);
    expect(frame.headers.get('set-cookie')).toBeNull();
    expect(privateFrame).toHaveBeenCalledWith(siteId, versionId, 'index.html');
    expect(asset).not.toHaveBeenCalled();
    const formSite = { ...privateSite, config: { data: {}, forms: [{ id: 'rsvp', title: 'RSVP', fields: { name: { type: 'text' as const, required: true } } }] } };
    authorize.mockResolvedValue(formSite);
    admitted.mockImplementation(async (_reference, work) => work(formSite, {}));
    const form = await app.request(request(`/${siteId}/forms/rsvp`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { name: 'Ada' }, idempotencyKey: 'valid-private-submission' }),
    }));
    expect(form.status).toBe(200);
    expect(admitted).toHaveBeenCalledWith(siteId, expect.any(Function), cookie);
  });

  it('never serves private files to an unrelated opaque sandbox, even when its browser sends a viewer cookie',async()=>{
    const {app,authorize,asset}=fixture();authorize.mockResolvedValue(privateSite);
    const viewer=`__Secure-matrix_site_viewer_${siteId.replaceAll('-', '')}=${randomUUID()}.${'s'.repeat(43)}`;
    expect((await app.request(request(`/${siteId}/assets/${versionId}/assets/main.js`,{headers:{cookie:viewer,origin:'null'}}))).status).toBe(404);
    expect(asset).not.toHaveBeenCalled();
  });

  it('redirects a private friendly path to the permanent ID before checking site cookies',async()=>{
    const {app,authorize}=fixture();
    const response=await app.request(request('/private-launch'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`/${siteId}`);
    expect(authorize).not.toHaveBeenCalled();
  });
});
