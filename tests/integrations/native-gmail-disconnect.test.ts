import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { KyselyPGlite } from 'kysely-pglite';
import { createPlatformDb, type PlatformDb } from '../../packages/gateway/src/platform-db.js';
import { createNativeGmailRuntime } from '../../packages/gateway/src/integrations/native-gmail/runtime.js';
import { createIntegrationRoutes } from '../../packages/gateway/src/integrations/routes.js';
import type { PipedreamConnectClient } from '../../packages/gateway/src/integrations/pipedream.js';
import { GMAIL_SCOPE } from '../../packages/gateway/src/integrations/native-gmail/types.js';

describe('feature-off native Gmail user disconnect', () => {
  let db: PlatformDb;
  let owner: string;
  let other: string;
  let connectionId: string;
  let app: Hono;
  let fetcher: ReturnType<typeof vi.fn>;
  let paid: ReturnType<typeof vi.fn>;
  let broadcast: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const instance = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: instance.dialect });
    await db.migrate();
    owner = (await db.createUser({ clerkId: 'user_owner', handle: 'owner', displayName: 'Owner', email: 'owner@example.test',
      containerId: 'owner', pipedreamExternalId: 'external-owner' })).id;
    other = (await db.createUser({ clerkId: 'user_other', handle: 'other', displayName: 'Other', email: 'other@example.test',
      containerId: 'other', pipedreamExternalId: 'external-other' })).id;
    paid = vi.fn(async () => { throw new Error('Paid fallback must never execute'); });
    const legacy = { revokeAccount: paid, getAppInfo: async () => null } as unknown as PipedreamConnectClient;
    const env = { GMAIL_OAUTH_INTERNAL_CLERK_IDS: 'user_owner', GMAIL_OAUTH_ENABLED: 'true', GMAIL_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com', GMAIL_OAUTH_CLIENT_SECRET: 'client-secret',
      GMAIL_OAUTH_CALLBACK_URL: 'https://app.matrix-os.com/api/integrations/gmail/oauth/callback', GMAIL_CREDENTIAL_ENCRYPTION_KEY: '12'.repeat(32) };
    fetcher = vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer',
        expires_in: 3600, scope: GMAIL_SCOPE });
      if (url.endsWith('/profile')) return Response.json({ emailAddress: 'owner@example.test' });
      if (url === 'https://oauth2.googleapis.com/revoke') return new Response(null, { status: 200 });
      throw new Error('Unexpected request');
    });
    vi.stubGlobal('fetch', fetcher);
    const enabled = createNativeGmailRuntime({ env, db, legacy });
    const state = new URL((await enabled.oauth!.start({ userId: owner, externalUserId: 'external-owner' })).url).searchParams.get('state')!;
    const browser = await enabled.oauth!.authorization(state, { userId: owner });
    connectionId = (await enabled.oauth!.complete(state, 'code', browser.browserProof)).connectionId;
    const disabled = createNativeGmailRuntime({ env: { ...env, GMAIL_OAUTH_ENABLED: 'false' }, db, legacy });
    broadcast = vi.fn();
    app = new Hono().route('/api/integrations', createIntegrationRoutes({ db, pipedream: disabled.client, nativeGmailCleanup: disabled.cleanup,
      webhookSecret: '', broadcast, resolveUserId: async c => c.req.header('x-owner') ?? null }));
  });
  afterEach(async () => { vi.unstubAllGlobals(); await db.destroy(); });
  const disconnect = (userId?: string) => app.request(`/api/integrations/${connectionId}`, { method: 'DELETE', headers: userId ? { 'x-owner': userId } : {} });

  it('revokes and deletes only the owned grant after provider confirmation, notifying once', async () => {
    const response = await disconnect(owner);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await db.getConnectedService(connectionId)).toBeNull();
    expect(paid).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2][0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(broadcast).toHaveBeenCalledExactlyOnceWith({ type: 'integration:disconnected', service: 'gmail', id: connectionId });
    expect((await disconnect(owner)).status).toBe(404);
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('retains the exact local connection and emits nothing when Google revocation fails', async () => {
    fetcher.mockResolvedValueOnce(new Response('private-provider-error', { status: 500 }));
    const response = await disconnect(owner);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Connection unavailable' });
    expect((await db.getConnectedService(connectionId))?.status).toBe('active');
    expect(broadcast).not.toHaveBeenCalled();
    expect(paid).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated or different owners without either provider call', async () => {
    expect((await disconnect()).status).toBe(401);
    expect((await disconnect(other)).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(paid).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('keeps confirmed disconnect successful when a notification subscriber fails', async () => {
    broadcast.mockImplementation(() => { throw new Error('Dead subscriber'); });
    expect((await disconnect(owner)).status).toBe(200);
    expect(await db.getConnectedService(connectionId)).toBeNull();
    expect(paid).not.toHaveBeenCalled();
  });

  it('does not expose OAuth callback or launcher through the cleanup capability', async () => {
    expect((await app.request('/api/integrations/gmail/oauth/callback?state=x&code=x')).status).toBe(404);
    expect((await app.request('/auth/gmail?state=x')).status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
