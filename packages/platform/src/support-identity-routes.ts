import { createHmac } from 'node:crypto';
import type { Hono } from 'hono';
import { SupportIdentityResponseSchema } from '@matrix-os/contracts';
import { isSyncJwtConfigError, verifySyncJwt, type SyncJwtClaims } from './sync-jwt.js';

export function registerSupportIdentityRoute(app: Hono, config: {
  jwtSecret: string;
  supportIdentitySecret?: string;
}): void {
  // Copied/generated secret configuration may include a terminal newline. It is not key material.
  const signingSecret = config.supportIdentitySecret?.trim();

  app.get('/api/support/identity', async (c) => {
    const auth = c.req.header('authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);

    let claims: SyncJwtClaims;
    try {
      claims = await verifySyncJwt(auth.slice(7), { secret: config.jwtSecret });
    } catch (err: unknown) {
      if (isSyncJwtConfigError(err)) throw err;
      return c.json({ error: 'unauthorized' }, 401);
    }

    if (!signingSecret) {
      return c.json(SupportIdentityResponseSchema.parse({ status: 'unavailable' }), 503);
    }
    return c.json(SupportIdentityResponseSchema.parse({
      status: 'verified',
      distinctId: claims.sub,
      identityHash: createHmac('sha256', signingSecret).update(claims.sub).digest('hex'),
    }));
  });
}
