import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createNativeGmailLaunchRoutes } from '../../packages/gateway/src/integrations/native-gmail/routes.js';
import { Hono } from 'hono';
import { createNativeGmailRoutes } from '../../packages/gateway/src/integrations/native-gmail/routes.js';
const connection = { id: '11111111-1111-4111-8111-111111111111', user_id: 'owner', service: 'gmail', pipedream_account_id: 'gmail_11111111-1111-4111-8111-111111111111', status: 'active' };
function setup() {
  const oauth = { start: vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque&redirect_uri=https%3A%2F%2Fapp.matrix-os.com%2Fapi%2Fintegrations%2Fgmail%2Foauth%2Fcallback' })),
    authorization: vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque', browserProof: 'ab'.repeat(32) })),
    complete: vi.fn(async () => ({ connectionId: connection.id, accountLabel: 'Gmail' })), cancel: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}), revoke: vi.fn(async () => true) };
  const db = { getUserById: vi.fn(async () => ({ pipedream_external_id: 'external-owner' })),
    updatePipedreamExternalId: vi.fn(), getConnectedService: vi.fn(async () => connection) };
  const broadcast = vi.fn();
  const app = new Hono().route('/', createNativeGmailRoutes({ db, oauth, broadcast, isEligible: async () => true, resolveUserId: async c => c.req.header('x-owner') ?? null }));
  app.route('/auth', createNativeGmailLaunchRoutes({ oauth, resolveUserId: async c => c.req.header('x-owner') ?? null }));
  app.all('*', c => c.json({ legacy: true })); return { app, db, oauth, broadcast };
}
const hash = createHash('sha256').update('opaque').digest('hex');
const proof = 'ab'.repeat(32);
const cookie = `__Host-matrix-gmail-${hash.slice(0,32)}=${proof}`;
const headers = { 'x-owner': 'owner', 'content-type': 'application/json' };
describe('native Gmail lifecycle routes', () => {
  it('uses existing one-click connect contract and persisted external owner ID', async () => {
    const s = setup(); const r = await s.app.request('/connect', { method: 'POST', headers, body: JSON.stringify({ service: 'gmail', label: 'Work Gmail' }) });
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ service: 'gmail', url: 'https://app.matrix-os.com/auth/gmail?state=opaque' });
    expect(s.oauth.start).toHaveBeenCalledWith({ userId: 'owner', externalUserId: 'external-owner', label: 'Work Gmail' });
  });
  it('preserves other services', async () => {
    const s = setup(); const r = await s.app.request('/connect', { method: 'POST', headers, body: JSON.stringify({ service: 'github' }) });
    expect(await r.json()).toEqual({ legacy: true }); expect(s.oauth.start).not.toHaveBeenCalled();
  });
  it('requires authenticated owner and rejects oversized requests', async () => {
    const s = setup(); expect((await s.app.request('/connect', { method: 'POST', body: JSON.stringify({ service: 'gmail' }) })).status).toBe(401);
    expect((await s.app.request('/connect', { method: 'POST', headers, body: 'x'.repeat(5000) })).status).toBe(413);
    expect(s.oauth.start).not.toHaveBeenCalled();
  });
  it('rejects arbitrary redirects and labels', async () => {
    const s = setup();
    for (const body of [{ service: 'gmail', redirectUri: 'https://evil.example' }, { service: 'gmail', label: 'x'.repeat(101) }]) {
      expect((await s.app.request('/connect', { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(s.oauth.start).not.toHaveBeenCalled();
  });
  it('callback binds to stored consent owner, returns no tokens and prevents caching', async () => {
    const s = setup(); const r = await s.app.request('/gmail/oauth/callback?state=opaque&code=code', { headers: { cookie } });
    expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
    expect(s.oauth.complete).toHaveBeenCalledWith('opaque', 'code', proof); expect(await r.text()).toContain('Gmail connected');
    expect(s.broadcast).toHaveBeenCalledWith({ type: 'integration:connected', service: 'gmail', accountLabel: 'Gmail' });
  });
  it('consumes denied consent without calling Google or reflecting its error', async () => {
    const s = setup(); const r = await s.app.request('/gmail/oauth/callback?state=opaque&error=access_denied&error_description=secret', { headers: { cookie } });
    expect(r.status).toBe(400); expect(s.oauth.cancel).toHaveBeenCalledWith('opaque', proof); expect(s.oauth.complete).not.toHaveBeenCalled();
    expect(await r.text()).not.toContain('secret');
  });
  it('keeps callback failures generic', async () => {
    const s = setup(); s.oauth.complete.mockRejectedValue(new Error('credential_secret'));
    const r = await s.app.request('/gmail/oauth/callback?state=opaque&code=code', { headers: { cookie } }); expect(r.status).toBe(502); expect(await r.text()).not.toContain('credential_secret');
  });
  it('requires exact initiating browser consent binding', async () => {
    const s = setup();
    for (const headers of [{}, { cookie: `${cookie}wrong` }]) {
      expect((await s.app.request('/gmail/oauth/callback?state=opaque&code=code', { headers })).status).toBe(403);
    }
    expect(s.oauth.complete).not.toHaveBeenCalled();
  });
  it('authenticates the stored owner before setting a browser consent cookie', async () => {
    const s = setup();
    expect((await s.app.request('/auth/gmail?state=opaque')).status).toBe(401);
    const r = await s.app.request('/auth/gmail?state=opaque', { headers: { 'x-owner': 'owner' } });
    expect(r.status).toBe(302); expect(s.oauth.authorization).toHaveBeenCalledWith('opaque', { userId: 'owner' });
    expect(r.headers.get('set-cookie')).toContain('HttpOnly'); expect(r.headers.get('set-cookie')).toContain('Secure');
    expect(r.headers.get('set-cookie')).toContain('SameSite=Lax'); expect(r.headers.get('set-cookie')).toContain('Max-Age=600');
    s.oauth.authorization.mockRejectedValue(new Error('wrong owner'));
    expect((await s.app.request('/auth/gmail?state=opaque', { headers: { 'x-owner': 'attacker' } })).status).toBe(403);
  });
  it('does not refresh or revoke another owner account', async () => {
    const s = setup(); const r = await s.app.request(`/${connection.id}`, { method: 'DELETE', headers: { 'x-owner': 'other-owner' } });
    expect(r.status).toBe(403); expect(s.oauth.revoke).not.toHaveBeenCalled();
  });
  it('revokes native connection with owner binding', async () => {
    const s = setup(); const r = await s.app.request(`/${connection.id}`, { method: 'DELETE', headers });
    expect(r.status).toBe(200); expect(s.oauth.revoke).toHaveBeenCalledWith({ userId: 'owner', connectionId: connection.id });
    expect(s.broadcast).toHaveBeenCalledWith({ type: 'integration:disconnected', service: 'gmail', id: connection.id });
  });
  it('does not resurrect a connection when refresh failed', async () => {
    const s = setup(); s.oauth.refresh.mockRejectedValue(new Error('invalid_grant'));
    const r = await s.app.request(`/${connection.id}/refresh`, { method: 'POST', headers }); expect(r.status).toBe(502);
    expect(s.oauth.refresh).toHaveBeenCalledWith({ userId: 'owner', connectionId: connection.id });
  });
});
