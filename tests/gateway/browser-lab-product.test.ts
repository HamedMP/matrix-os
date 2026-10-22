import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAppSessionKey, signAppSession } from '../../packages/gateway/src/app-runtime/app-session.js';
const pools = vi.hoisted(() => [] as any[]);
vi.mock('../../packages/gateway/src/browser-lab/viewer-sockets.js', () => ({ createViewerSockets: () => {
  const callbacks: Array<() => void> = [];
  const pool = { callbacks, connect: vi.fn(async (_expiry: number, drop: () => void) => { callbacks.push(drop); return { onClose: drop }; }),
    closeConnections: vi.fn(() => { callbacks.splice(0).forEach(callback => callback()); }), close: vi.fn() };
  pools.push(pool); return pool;
} }));
import { registerBrowserLabRoutes } from '../../packages/gateway/src/browser-lab/routes.js';
const closers: Array<() => void> = [];
afterEach(() => { closers.splice(0).forEach(close => close()); pools.length = 0; vi.restoreAllMocks(); });
const state = { available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true };
function setup() {
  const key = deriveAppSessionKey('matrix-product-test-secret-at-least32', 'browser-lab');
  const cookie = `matrix_app_session__browser-lab=${signAppSession(key, { v: 1, slug: 'browser-lab', principal: 'gateway-owner', scope: 'personal', iat: 1, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const app = new Hono(); const fetcher = vi.fn(async () => Response.json(state));
  const close = registerBrowserLabRoutes(app, { enabled: true, deriveKey: () => key, viewerAuthorization: 'Basic synthetic', isAllowedOrigin: origin => ['https://app.matrix-os.com', 'http://localhost:3000'].includes(origin), fetcher, upgradeWebSocket: (() => async (c: any) => c.text('upgraded')) as any }).close;
  closers.push(close);
  const claim = (surface = 'browser') => app.request('/apps/browser-lab/api/browser-session', { method: 'POST', headers: { cookie, origin: 'https://app.matrix-os.com' }, body: JSON.stringify({ surface }) });
  const diagnostic = () => app.request('/apps/browser-lab/api/viewer-session', { headers: { cookie } });
  const connect = (ticket: string) => app.request(`/apps/browser-lab/viewer/websockify?lab_ticket=${ticket}`, { headers: { upgrade: 'websocket', origin: 'https://app.matrix-os.com' } });
  return { app, cookie, claim, diagnostic, connect, fetcher, close, pool: pools.at(-1) };
}
describe('exclusive owner product stream claims', () => {
  it('rechecks diagnostic ownership after a delayed request body completes', async () => {
    const { app, cookie, claim, fetcher } = setup();
    let finish!: () => void;
    const body = new ReadableStream({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode('{"action":"start","engine":"agent-browser"}')); controller.close(); }; } });
    const headers = { cookie, 'content-type': 'application/json' };
    const pending = app.request(new Request('http://localhost/apps/browser-lab/api/control', { method: 'POST', headers, body, duplex: 'half' } as RequestInit));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await claim()).status).toBe(200); finish();
    expect((await pending).status).toBe(409);
    expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/control'))).toBe(false);
  });
  it('claims desktop without issuing show-desktop or hiding existing workspace windows', async () => {
    const { claim, fetcher } = setup();
    expect((await claim('desktop')).status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:8730/browser-session');
    expect(fetcher.mock.calls[0][1].body).toBe('{"surface":"desktop"}');
  });
  it('revokes old streams and tickets, ignores stale close, releases on matching disconnect', async () => {
    const { claim, connect, diagnostic, pool } = setup();
    const first = await (await claim()).json(); await connect(first.ticket);
    const staleClose = pool.callbacks[0];
    const second = await (await claim('desktop')).json();
    expect(pool.closeConnections).toHaveBeenCalledTimes(2);
    await connect(second.ticket); staleClose();
    expect((await diagnostic()).status).toBe(409);
    pool.callbacks[0]();
    expect((await diagnostic()).status).toBe(200);
    expect((await connect(first.ticket)).status).toBe(401);
  });
  it('expires an unconnected claim and rejects its late ticket', async () => {
    const { claim, diagnostic, connect } = setup();
    const first = await (await claim()).json();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    expect((await diagnostic()).status).toBe(200);
    expect((await connect(first.ticket)).status).toBe(401);
  });
  it('does not mint late tickets for a superseded in-flight claim', async () => {
    const { claim, fetcher, diagnostic } = setup();
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const old = claim(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const fresh = await claim('desktop'); expect(fresh.status).toBe(200);
    release(Response.json(state)); expect((await old).status).toBe(409);
    expect((await diagnostic()).status).toBe(409);
  });
  it('fails closed on unacknowledged input gating or raw upstream status fields', async () => {
    const { claim, fetcher, diagnostic } = setup();
    fetcher.mockResolvedValueOnce(Response.json({ ...state, humanControlAvailable: false }));
    expect((await claim()).status).toBe(502);
    expect((await diagnostic()).status).toBe(200);
    fetcher.mockResolvedValueOnce(Response.json({ ...state, privateTitle: 'never expose' }));
    expect(await (await claim()).text()).not.toContain('never expose');
  });
  it('injects only product viewer roots and validates a distinct dev parent origin', async () => {
    const { app, cookie, fetcher } = setup();
    const html = () => new Response('<html><body>viewer</body></html>', { headers: { 'content-type': 'text/html' } });
    fetcher.mockImplementation(html);
    const viewer = await app.request('/apps/browser-lab/viewer/?matrix_product=1&matrix_parent_origin=http%3A%2F%2Flocalhost%3A3000', { headers: { cookie } });
    expect(await viewer.text()).toContain('matrix-parent-origin');
    expect((await app.request('/apps/browser-lab/viewer/?matrix_product=1&matrix_parent_origin=https%3A%2F%2Fattacker.test', { headers: { cookie } })).status).toBe(403);
    const diagnostic = await app.request('/apps/browser-lab/viewer/', { headers: { cookie } });
    expect(await diagnostic.text()).not.toContain('matrix-viewer-bridge');
  });
  it('blocks diagnostic commands during product ownership and denies all routes after shutdown', async () => {
    const { app, cookie, claim, close } = setup(); await claim();
    expect((await app.request('/apps/browser-lab/api/control', { method: 'POST', headers: { cookie }, body: '{"action":"start","engine":"agent-browser"}' })).status).toBe(409);
    close(); expect((await app.request('/apps/browser-lab/api/browser-status', { headers: { cookie } })).status).toBe(404);
  });
});
