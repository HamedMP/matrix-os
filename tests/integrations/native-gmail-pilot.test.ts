import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { KyselyPGlite } from 'kysely-pglite';
import { createPlatformDb, type PlatformDb } from '../../packages/gateway/src/platform-db.js';
import { createNativeGmailRuntime } from '../../packages/gateway/src/integrations/native-gmail/runtime.js';
import { createIntegrationRoutes } from '../../packages/gateway/src/integrations/routes.js';
import type { PipedreamConnectClient } from '../../packages/gateway/src/integrations/pipedream.js';
import { GMAIL_SCOPE } from '../../packages/gateway/src/integrations/native-gmail/types.js';
const config = { GMAIL_OAUTH_ENABLED: 'true', GMAIL_OAUTH_INTERNAL_CLERK_IDS: 'user_pilot', GMAIL_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com',
  GMAIL_OAUTH_CLIENT_SECRET: 'google-secret', GMAIL_OAUTH_CALLBACK_URL: 'https://app.matrix-os.com/api/integrations/gmail/oauth/callback', GMAIL_CREDENTIAL_ENCRYPTION_KEY: '12'.repeat(32) };
describe('internal Gmail pilot actual runtime', () => {
  let db: PlatformDb; let pilot: string; let outsider: string; let paid: ReturnType<typeof vi.fn>; let consent: ReturnType<typeof vi.fn>; let fetcher: ReturnType<typeof vi.fn>;
  const runtime = (env = config) => createNativeGmailRuntime({ env, db, legacy: { createConnectToken: consent, getOAuthUrl: () => 'https://connect.pipedream.test', proxyGet: paid, getAppInfo: async () => null } as unknown as PipedreamConnectClient,
    resolveUserId: async c => c.req.header('x-owner') ?? null });
  const routes = (r: ReturnType<typeof runtime>) => new Hono().route('/api/integrations', createIntegrationRoutes({ db, pipedream: r.client, nativeGmail: r.oauth,
    nativeGmailCleanup: r.cleanup, nativeGmailEligible: r.isEligible, webhookSecret: '', resolveUserId: async c => c.req.header('x-owner') ?? null })).route('/auth', r.launchRoutes ?? new Hono());
  const connect = (app: Hono, owner: string, body: unknown) => app.request('/api/integrations/connect', { method: 'POST', headers: { 'x-owner': owner, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const begin = async (r: ReturnType<typeof runtime>) => {
    const state = new URL((await r.oauth!.start({ userId: pilot, externalUserId: 'ext-pilot' })).url).searchParams.get('state')!;
    const browser = await r.oauth!.authorization(state, { userId: pilot }); return { state, browser };
  };
  beforeEach(async () => {
    const instance = await KyselyPGlite.create(); db = createPlatformDb({ dialect: instance.dialect }); await db.migrate();
    pilot = (await db.createUser({ clerkId: 'user_pilot', handle: 'pilot', displayName: 'Pilot', email: 'pilot@example.test', containerId: 'pilot', pipedreamExternalId: 'ext-pilot' })).id;
    outsider = (await db.createUser({ clerkId: 'user_other', handle: 'other', displayName: 'Other', email: 'other@example.test', containerId: 'other', pipedreamExternalId: 'ext-other' })).id;
    consent = vi.fn(async () => ({ connectLinkUrl: 'https://connect.pipedream.test', token: 'legacy' }));
    paid = vi.fn(async () => { throw new Error('Paid execution forbidden'); });
    fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', scope: GMAIL_SCOPE, expires_in: 3600 });
      if (url.endsWith('/profile')) return Response.json({ emailAddress: 'pilot@example.test' });
      if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
      return Response.json({ id: 'message' });
    }); vi.stubGlobal('fetch', fetcher);
  });
  afterEach(async () => { vi.unstubAllGlobals(); await db.destroy(); });
  it('derives authenticated options from immutable stored Clerk identity, denying empty and forged identity', async () => {
    const app = routes(runtime());
    const options = (owner?: string) => app.request('/api/integrations/gmail/connection-options', { headers: owner ? { 'x-owner': owner, 'x-clerk-id': 'user_pilot' } : {} });
    expect((await options()).status).toBe(401);
    expect(await (await options(pilot)).json()).toEqual({ methods: ['matrix', 'pipedream'], defaultMethod: 'matrix' });
    expect(await (await options(outsider)).json()).toEqual({ methods: ['pipedream'], defaultMethod: 'pipedream' });
    expect(await runtime({ ...config, GMAIL_OAUTH_INTERNAL_CLERK_IDS: '' }).isEligible(pilot)).toBe(false);
  });
  it('routes explicit Pipedream and nonpilot defaults only through existing consent', async () => {
    const r = runtime(); const app = routes(r);
    expect((await connect(app, pilot, { service: 'gmail', connectionMethod: 'pipedream' })).status).toBe(200);
    expect((await connect(app, outsider, { service: 'gmail' })).status).toBe(200);
    expect(consent).toHaveBeenCalledTimes(2); expect(fetcher).not.toHaveBeenCalled();
    expect((await connect(app, outsider, { service: 'gmail', connectionMethod: 'matrix' })).status).toBe(403);
    expect((await connect(app, pilot, { service: 'github', connectionMethod: 'matrix' })).status).toBe(400);
    expect((await connect(app, pilot, { service: 'gmail', connectionMethod: 'unknown' })).status).toBe(400);
    expect(consent).toHaveBeenCalledTimes(2);
    expect((await connect(app, pilot, { service: 'gmail' })).status).toBe(200); expect(consent).toHaveBeenCalledTimes(2);
  });
  it('carries actual pilot consent and native reads through the full route chain, then blocks writes after removal', async () => {
    const r = runtime(); const app = routes(r);
    const started = await connect(app, pilot, { service: 'gmail', connectionMethod: 'matrix', label: 'Pilot Gmail' });
    expect(started.status).toBe(200); const launch = new URL((await started.json()).url);
    const launched = await app.request(`${launch.pathname}${launch.search}`, { headers: { 'x-owner': pilot } });
    expect(launched.status).toBe(302); const cookie = launched.headers.get('set-cookie')!.split(';')[0]!;
    const state = launch.searchParams.get('state')!;
    expect((await app.request(`/api/integrations/gmail/oauth/callback?state=${state}&code=code`, { headers: { cookie } })).status).toBe(200);
    const action = (app: Hono, path: string, body: unknown) => app.request(`/api/integrations/${path}`, {
      method: 'POST', headers: { 'x-owner': pilot, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await action(app, 'read-call', { service: 'gmail', label: 'Pilot Gmail', action: 'get_message', params: { messageId: 'm1' } })).status).toBe(200);
    const removed = runtime({ ...config, GMAIL_OAUTH_INTERNAL_CLERK_IDS: '' }); const count = fetcher.mock.calls.length;
    const denied = await action(routes(removed), 'call', { service: 'gmail', label: 'Pilot Gmail', action: 'send_email', params: { to: 'synthetic@example.test', subject: 'test', body: 'test' } });
    expect(denied.status).toBeGreaterThanOrEqual(400); expect(fetcher).toHaveBeenCalledTimes(count); expect(paid).not.toHaveBeenCalled(); expect(consent).not.toHaveBeenCalled();
  });
  it('rejects native start, launcher and callback after eligibility removal without Google calls', async () => {
    const r = runtime(); const { state, browser } = await begin(r);
    const removed = runtime({ ...config, GMAIL_OAUTH_INTERNAL_CLERK_IDS: '' });
    await expect(removed.oauth!.start({ userId: pilot, externalUserId: 'ext-pilot' })).rejects.toThrow('Gmail connection unavailable');
    await expect(removed.oauth!.authorization(state, { userId: pilot })).rejects.toThrow('Gmail connection unavailable');
    await expect(removed.oauth!.complete(state, 'code', browser.browserProof)).rejects.toThrow('Gmail connection unavailable');
    expect(fetcher).not.toHaveBeenCalled(); expect(await db.listConnectedServices(pilot)).toEqual([]);
    await expect(r.oauth!.complete(state, 'code', browser.browserProof)).rejects.toThrow();
  });
  it('blocks saved native tokens and refresh after removal while confirmed cleanup remains available', async () => {
    const r = runtime(); const { state, browser } = await begin(r); const connected = await r.oauth!.complete(state, 'code', browser.browserProof);
    const row = (await db.listConnectedServices(pilot))[0]!; const count = fetcher.mock.calls.length;
    const removed = runtime({ ...config, GMAIL_OAUTH_INTERNAL_CLERK_IDS: '' });
    await expect(removed.oauth!.token({ externalUserId: 'ext-pilot', accountId: row.pipedream_account_id })).rejects.toThrow('Gmail connection unavailable');
    await expect(removed.oauth!.refresh({ userId: pilot, connectionId: connected.connectionId })).rejects.toThrow('Gmail connection unavailable');
    expect(fetcher).toHaveBeenCalledTimes(count); expect(paid).not.toHaveBeenCalled();
    const response = await routes(removed).request(`/api/integrations/${connected.connectionId}`, { method: 'DELETE', headers: { 'x-owner': pilot } });
    expect(response.status).toBe(200); expect(await db.getConnectedService(connected.connectionId)).toBeNull();
  });
  it('fails safe on malformed enabled allowlists and never falls back explicit Matrix while off', async () => {
    for (const ids of ['user_pilot,', 'user_pilot,user_pilot', 'pilot@example.test', Array.from({ length: 101 }, (_, i) => `user_test${i}`).join(',')])
      expect(() => runtime({ ...config, GMAIL_OAUTH_INTERNAL_CLERK_IDS: ids })).toThrow('Gmail OAuth configuration unavailable');
    const off = runtime({ ...config, GMAIL_OAUTH_ENABLED: 'false' });
    expect((await connect(routes(off), pilot, { service: 'gmail', connectionMethod: 'matrix' })).status).toBe(503);
    expect(consent).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
