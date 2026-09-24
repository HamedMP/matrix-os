import { CUSTOM_MCP_UNAVAILABLE } from '@matrix-os/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { getContainer, getRunningUserMachineByHandle, type PlatformDB } from './db.js';
import { buildPlatformVerificationToken, timingSafeTokenEquals } from './platform-token.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';

const HandleSchema = z.string().regex(HANDLE_PATTERN);
const BODY_LIMIT = 64 * 1024;
const OAUTH_CALLBACK_PATH = '/api/mcp-servers/oauth/callback';

type McpVariables = {
  platformUserId: string;
  platformHandle: string;
  internalContainerHandle: string;
  internalContainerClerkUserId: string;
};

/** Own the entire namespace, including disabled and unrecognized routes. */
function mountBackend(app: Hono<{ Variables: McpVariables }>, backend?: Hono<any>): void {
  if (backend) app.route('/', backend);
  app.all('*', (c) => {
    c.header('Cache-Control', 'no-store');
    return backend
      ? c.json({ error: 'Custom MCP route not found' }, 404)
      : c.json({ error: CUSTOM_MCP_UNAVAILABLE }, 503);
  });
}

/** Register after session routing and before the platform admin API guard. */
export function registerCustomMcpRoutes(app: Hono<any>, options: {
  db: PlatformDB;
  platformSecret: string;
  customMcpRoutes?: Hono<any>;
  internalCustomMcpRoutes?: Hono<any>;
}): void {
  const external = new Hono<{ Variables: McpVariables }>();
  external.use('*', bodyLimit({ maxSize: BODY_LIMIT }), async (c, next) => {
    if (c.req.method === 'GET' && c.req.path === OAUTH_CALLBACK_PATH) {
      c.header('Cache-Control', 'no-store, private');
      c.header('CDN-Cache-Control', 'no-store');
      c.header('Cloudflare-CDN-Cache-Control', 'no-store');
      return next();
    }
    // Session routing supplies these only after verifying the personal identity.
    if (!c.get('platformUserId') || !c.get('platformHandle')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });
  mountBackend(external, options.customMcpRoutes);
  app.route('/api/mcp-servers', external);

  const internal = new Hono<{ Variables: McpVariables }>();
  internal.use('*', bodyLimit({ maxSize: BODY_LIMIT }), async (c, next) => {
    const parsedHandle = HandleSchema.safeParse(c.req.param('handle'));
    if (!parsedHandle.success) return c.json({ error: 'Invalid handle' }, 400);
    if (!options.platformSecret) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: CUSTOM_MCP_UNAVAILABLE }, 503);
    }
    const handle = parsedHandle.data;
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!timingSafeTokenEquals(token, buildPlatformVerificationToken(handle, options.platformSecret))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const record = (await getRunningUserMachineByHandle(options.db, handle)) ?? (await getContainer(options.db, handle));
    if (!record?.clerkUserId) return c.json({ error: 'Unknown handle' }, 404);
    c.set('internalContainerHandle', handle);
    c.set('internalContainerClerkUserId', record.clerkUserId);
    return next();
  });
  mountBackend(internal, options.internalCustomMcpRoutes);
  app.route('/internal/containers/:handle/mcp-servers', internal);
}
