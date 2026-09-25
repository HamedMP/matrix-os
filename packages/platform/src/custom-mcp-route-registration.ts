import { CUSTOM_MCP_UNAVAILABLE } from '@matrix-os/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { getContainer, getRunningUserMachineByHandle, type PlatformDB, type UserMachineRecord } from './db.js';
import { getActivePreviewMachineByHandle } from './customer-vps-preview.js';
import { buildPlatformVerificationToken, timingSafeTokenEquals } from './platform-token.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';

const HandleSchema = z.string().regex(HANDLE_PATTERN);
const BODY_LIMIT = 64 * 1024;
const OAUTH_CALLBACK_PATH = '/api/mcp-servers/oauth/callback';
const PREVIEW_FIXTURE_ACCOUNT_PREFIX = '~preview:';

function isIsolatedPreviewFixture(machine: UserMachineRecord | undefined, handle: string): boolean {
  return Boolean(machine?.provisioningClass === 'preview'
    && machine.status === 'running'
    && machine.runtimeSlot === handle
    && /^pr-[1-9][0-9]{0,8}$/.test(handle)
    && machine.clerkUserId === `chat-share-preview-fixture-${handle}`);
}

/** Resolve the machine for the account that owns an MCP projection. */
export async function getCustomMcpProjectionMachine(
  db: PlatformDB,
  user: { handle: string; clerk_id: string },
): Promise<UserMachineRecord | null> {
  if (user.handle.startsWith(PREVIEW_FIXTURE_ACCOUNT_PREFIX)) {
    const handle = user.handle.slice(PREVIEW_FIXTURE_ACCOUNT_PREFIX.length);
    const preview = await getActivePreviewMachineByHandle(db, handle);
    return isIsolatedPreviewFixture(preview, handle) && preview?.clerkUserId === user.clerk_id
      ? preview
      : null;
  }
  return (await getRunningUserMachineByHandle(db, user.handle)) ?? null;
}

/** Resolve the same synthetic Preview owner admitted by the internal route. */
export async function resolveCustomMcpUserIdForMachine(
  db: PlatformDB,
  accounts: {
    getUserByClerkId(clerkId: string): Promise<{ id: string } | null>;
    ensureUser(input: {
      clerkId: string; handle: string; displayName: string; email: string; containerId: string;
    }): Promise<{ id: string }>;
  },
  clerkUserId: string | undefined,
  handle: string | undefined,
): Promise<string | null> {
  if (!clerkUserId || !handle) return null;
  const preview = await getActivePreviewMachineByHandle(db, handle);
  if (preview && (!isIsolatedPreviewFixture(preview, handle) || preview.clerkUserId !== clerkUserId)) {
    return null;
  }
  // Always upsert the fixture so an account created before the isolated key
  // was introduced is migrated before any projection uses it.
  if (!preview) {
    const existing = await accounts.getUserByClerkId(clerkUserId);
    if (existing) return existing.id;
  }
  const owner = preview ?? (await getRunningUserMachineByHandle(db, handle)) ?? (await getContainer(db, handle));
  if (!owner || owner.clerkUserId !== clerkUserId) return null;
  return (await accounts.ensureUser({
    clerkId: clerkUserId,
    // users.handle is globally unique; a customer may own the pr-N handle.
    // This prefix is outside the valid customer handle grammar.
    handle: preview ? `${PREVIEW_FIXTURE_ACCOUNT_PREFIX}${handle}` : handle,
    displayName: handle,
    email: `${handle}@matrix-os.local`,
    containerId: `platform:${clerkUserId}`,
  })).id;
}

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
    // The handle-derived bearer cannot distinguish a preview from a customer
    // primary row with the same handle. Select a preview slot first.
    const preview = await getActivePreviewMachineByHandle(options.db, handle);
    // Shared preview Terminals can obtain that bearer. The isolated platform
    // preview fixture is the only synthetic account allowed through.
    const isolatedFixture = isIsolatedPreviewFixture(preview, handle);
    if (preview && !isolatedFixture) return c.json({ error: 'Forbidden' }, 403);
    const record = preview ?? (await getRunningUserMachineByHandle(options.db, handle))
      ?? (await getContainer(options.db, handle));
    if (!record?.clerkUserId) return c.json({ error: 'Unknown handle' }, 404);
    c.set('internalContainerHandle', handle);
    c.set('internalContainerClerkUserId', record.clerkUserId);
    return next();
  });
  mountBackend(internal, options.internalCustomMcpRoutes);
  app.route('/internal/containers/:handle/mcp-servers', internal);
}
