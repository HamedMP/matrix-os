import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import type { PlatformDb } from '../../platform-db.js';
import type { IntegrationBroadcast } from '../routes.js';
import type { NativeGmailLifecycle } from './routes.js';
import { isNativeGmailAccount } from './request.js';

/** Revocation stays available independently of consent and mailbox execution. */
export function createNativeGmailDisconnectRoutes(options: {
  db: Pick<PlatformDb, 'getConnectedService'>;
  cleanup: Pick<NativeGmailLifecycle, 'revoke'>;
  resolveUserId(c: Context): Promise<string | null>;
  broadcast?: IntegrationBroadcast;
}): Hono {
  const app = new Hono();
  app.delete('/:id', bodyLimit({ maxSize: 1024 }), async (c, next) => {
    const userId = await options.resolveUserId(c);
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid ID' }, 400);
    try {
      const row = await options.db.getConnectedService(id.data);
      if (!row || !isNativeGmailAccount(row.pipedream_account_id)) return next();
      if (row.user_id !== userId) return c.json({ error: 'Forbidden' }, 403);
      if (row.service !== 'gmail' || !await options.cleanup.revoke({ userId, connectionId: id.data }))
        return c.json({ error: 'Connection unavailable' }, 502);
    } catch (error) {
      console.warn('[native-gmail] Disconnect failed:', error);
      return c.json({ error: 'Connection unavailable' }, 502);
    }
    // Revocation owns the durable deletion; there is no second local mutation or optimistic success.
    try { options.broadcast?.({ type: 'integration:disconnected', service: 'gmail', id: id.data }); }
    catch (error) { console.warn('[native-gmail] Disconnect notification failed:', error); }
    return c.json({ ok: true });
  });
  return app;
}
