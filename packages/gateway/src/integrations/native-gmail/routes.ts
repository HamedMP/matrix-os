import { createNativeGmailConnectionRoutes } from './connection-routes.js';
import { createNativeGmailDisconnectRoutes } from './disconnect-routes.js';
import { createHash } from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import type { PlatformDb } from '../../platform-db.js';
import type { IntegrationBroadcast } from '../routes.js';
import { isNativeGmailAccount } from './request.js';

export interface NativeGmailLifecycle {
  start(input: { userId: string; externalUserId: string; label?: string; redirectUri?: string }): Promise<{ url: string }>;
  authorization(state: string, owner: { userId: string }): Promise<{ url: string; browserProof: string }>;
  complete(state: string, code: string, browserProof: string): Promise<{ connectionId: string; accountLabel: string; redirectUri?: string }>;
  cancel(state: string, browserProof: string): Promise<void>;
  refresh(input: { userId: string; connectionId: string }): Promise<void>;
  revoke(input: { userId: string; connectionId: string }): Promise<boolean>;
}
const Callback = z.object({ state: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_.-]+$/),
  code: z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/).optional(),
  error: z.string().min(1).max(128).optional() }).refine(v => Boolean(v.code) !== Boolean(v.error));
const Id = z.uuid();
const success = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Gmail connected</title><h1>Gmail connected</h1><p>Return to Matrix to use your account. You can close this tab.</p></html>';

/** Intercept native lifecycle only. Existing action selection, approvals and bot policy stay upstream. */
export function createNativeGmailRoutes(options: {
  db: Pick<PlatformDb, 'getUserById' | 'updatePipedreamExternalId' | 'getConnectedService'>;
  oauth: NativeGmailLifecycle;
  isEligible?: (userId: string) => Promise<boolean>;
  resolveUserId(c: Context): Promise<string | null>;
  broadcast?: IntegrationBroadcast;
}): Hono {
  const app = new Hono().route('/', createNativeGmailConnectionRoutes({ ...options, isEligible: options.isEligible ?? (async () => false) })).route('/', createNativeGmailDisconnectRoutes({ db: options.db, cleanup: options.oauth, resolveUserId: options.resolveUserId, broadcast: options.broadcast }));
  const notify = (event: { type: 'integration:connected'; service: string; accountLabel: string } | { type: 'integration:disconnected'; service: string; id: string }) => {
    try { if (event.type === 'integration:connected') options.broadcast?.(event); else options.broadcast?.(event); }
    catch (error) { console.warn('[native-gmail] Connection notification failed:', error); }
  };
  app.get('/gmail/oauth/callback', async c => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const params = new URL(c.req.url).searchParams;
    if (['state', 'code', 'error'].some(key => params.getAll(key).length > 1)) return c.json({ error: 'Connection unavailable' }, 400);
    const parsed = Callback.safeParse(Object.fromEntries(params));
    if (!parsed.success) return c.json({ error: 'Connection unavailable' }, 400);
    const hash = stateHash(parsed.data.state);
    const cookie = getCookie(c, cookieName(hash));
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return c.json({ error: 'Connection unavailable. Start again from Matrix.' }, 403);
    deleteCookie(c, cookieName(hash), { path: '/', secure: true });
    try {
      if (parsed.data.error) {
        await options.oauth.cancel(parsed.data.state, cookie);
        return c.json({ error: 'Gmail connection was not completed' }, 400);
      }
      const result = await options.oauth.complete(parsed.data.state, parsed.data.code!, cookie);
      notify({ type: 'integration:connected', service: 'gmail', accountLabel: result.accountLabel });
      if (result.redirectUri === 'matrixos://integrations') return c.redirect(result.redirectUri);
      return c.html(success);
    } catch (error) { console.warn('[native-gmail] OAuth callback failed:', error); return c.json({ error: 'Connection unavailable. Start again from Matrix.' }, 502); }
  });
  app.post('/:id/refresh', bodyLimit({ maxSize: 1024 }), async (c, next) => {
    const userId = await options.resolveUserId(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    const id = Id.safeParse(c.req.param('id')); if (!id.success) return c.json({ error: 'Invalid ID' }, 400);
    const row = await options.db.getConnectedService(id.data);
    if (!row || !isNativeGmailAccount(row.pipedream_account_id)) return next();
    if (row.user_id !== userId) return c.json({ error: 'Forbidden' }, 403);
    try {
      await options.oauth.refresh({ userId, connectionId: id.data });
      return c.json({ id: id.data, service: 'gmail', status: 'active' });
    } catch (error) { console.warn('[native-gmail] Account lifecycle failed:', error); return c.json({ error: 'Connection unavailable' }, 502); }
  });
  return app;
}

function stateHash(state: string): string { return createHash('sha256').update(state).digest('hex'); }
function cookieName(hash: string): string { return `__Host-matrix-gmail-${hash.slice(0, 32)}`; }

/** Authenticated Matrix browser identity must match the immutable initiator before Google consent. */
export function createNativeGmailLaunchRoutes(options: { oauth: NativeGmailLifecycle; resolveUserId(c: Context): Promise<string | null> }): Hono {
  const app = new Hono();
  app.get('/gmail', async c => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    const userId = await options.resolveUserId(c);
    if (!userId) return c.json({ error: 'Sign in to Matrix to connect Gmail' }, 401);
    const params = new URL(c.req.url).searchParams;
    const state = Callback.shape.state.safeParse(params.get('state'));
    if (!state.success || params.getAll('state').length !== 1) return c.json({ error: 'Connection unavailable' }, 400);
    try {
      const { url, browserProof } = await options.oauth.authorization(state.data, { userId });
      const hash = stateHash(state.data);
      setCookie(c, cookieName(hash), browserProof, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 });
      return c.redirect(url);
    } catch (error) { console.warn('[native-gmail] Consent owner rejected:', error); return c.json({ error: 'Connection unavailable. Start again from Matrix.' }, 403); }
  });
  return app;
}
