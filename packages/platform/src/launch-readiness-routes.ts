import { Hono } from 'hono';
import { timingSafeTokenEquals } from './platform-token.js';
import type { LaunchReadinessService } from './launch-readiness.js';

export function createLaunchReadinessRoutes(options: {
  service: LaunchReadinessService;
  platformSecret: string;
}): Hono {
  const app = new Hono();

  app.get('/launch-readiness', async (c) => {
    if (!options.platformSecret) {
      return c.json({ error: 'Platform admin not configured' }, 503);
    }
    const token = parseBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEquals(token, options.platformSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      return c.json(await options.service.getReport());
    } catch (err: unknown) {
      console.error(
        '[launch-readiness] Failed to build operator readiness report:',
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: 'Launch readiness unavailable' }, 503);
    }
  });

  return app;
}

function parseBearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length);
}
