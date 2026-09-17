import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

/** Keep absent integration dependencies out of the platform admin auth guard. */
export function createUnavailableIntegrationRoutes() {
  const app = new Hono<{ Variables: { platformUserId: string; platformHandle: string } }>();
  app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  app.all('*', (c) => {
    c.header('Cache-Control', 'no-store');
    const publicPath = c.req.path === '/api/integrations/available'
      || c.req.path.startsWith('/api/integrations/webhook/');
    if (!publicPath && (!c.get('platformUserId') || !c.get('platformHandle'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ error: 'integrations_unavailable' }, 503);
  });
  return app;
}
