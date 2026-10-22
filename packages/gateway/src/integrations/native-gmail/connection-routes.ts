import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { GmailConnectionMethodSchema, GmailConnectionOptionsSchema } from '@matrix-os/contracts/integration-marketplace';
import type { PlatformDb } from '../../platform-db.js';
import type { NativeGmailLifecycle } from './routes.js';
const Connect = z.object({ service: z.string().min(1).max(100), label: z.string().trim().min(1).max(100).optional(),
  redirectUri: z.literal('matrixos://integrations').optional(), connectionMethod: GmailConnectionMethodSchema.optional() })
  .refine(value => value.connectionMethod === undefined || value.service === 'gmail');

/** Select consent before the legacy handler; explicit Matrix can never fall through. */
export function createNativeGmailConnectionRoutes(options: {
  db: Pick<PlatformDb, 'getUserById' | 'updatePipedreamExternalId'>;
  oauth?: NativeGmailLifecycle;
  isEligible(userId: string): Promise<boolean>;
  resolveUserId(c: Context): Promise<string | null>;
}): Hono {
  const app = new Hono();
  app.get('/gmail/connection-options', async c => {
    const userId = await options.resolveUserId(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    c.header('Cache-Control', 'no-store');
    try {
      const eligible = Boolean(options.oauth) && await options.isEligible(userId);
      return c.json(GmailConnectionOptionsSchema.parse(eligible
        ? { methods: ['matrix', 'pipedream'], defaultMethod: 'matrix' }
        : { methods: ['pipedream'], defaultMethod: 'pipedream' }));
    } catch (error) { console.warn('[native-gmail] Connection options unavailable:', error); return c.json({ error: 'Connection unavailable' }, 503); }
  });
  app.post('/connect', bodyLimit({ maxSize: 4096 }), async (c, next) => {
    const userId = await options.resolveUserId(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    let body: unknown;
    try { body = await c.req.json(); }
    catch (error) { if (error instanceof Error && error.name === 'BodyLimitError') return c.json({ error: 'Request too large' }, 413); if (!(error instanceof SyntaxError)) console.warn('[native-gmail] Connect body unavailable'); return c.json({ error: 'Invalid request' }, 400); }
    const parsed = Connect.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    if (parsed.data.service !== 'gmail' || parsed.data.connectionMethod === 'pipedream') return next();
    try {
      const eligible = Boolean(options.oauth) && await options.isEligible(userId);
      if (parsed.data.connectionMethod === undefined && !eligible) return next();
      if (!options.oauth) return c.json({ error: 'Connection unavailable' }, 503);
      if (!eligible) return c.json({ error: 'Connection unavailable' }, 403);
      const user = await options.db.getUserById(userId);
      if (!user) return c.json({ error: 'Connection unavailable' }, 503);
      const externalUserId = user.pipedream_external_id ?? userId;
      if (!user.pipedream_external_id) await options.db.updatePipedreamExternalId(userId, externalUserId);
      const { url } = await options.oauth.start({ userId, externalUserId,
        ...(parsed.data.label ? { label: parsed.data.label } : {}),
        ...(parsed.data.redirectUri ? { redirectUri: parsed.data.redirectUri } : {}) });
      const authorization = new URL(url);
      const state = authorization.searchParams.get('state');
      const callback = authorization.searchParams.get('redirect_uri');
      if (!state || !callback) throw new Error('Consent unavailable');
      const launch = new URL('/auth/gmail', new URL(callback).origin);
      launch.searchParams.set('state', state);
      return c.json({ url: launch.href, service: 'gmail' });
    } catch (error) { console.warn('[native-gmail] Connection start failed:', error); return c.json({ error: 'Connection unavailable' }, 502); }
  });
  return app;
}
