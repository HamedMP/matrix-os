import {
  MatrixComputerListSchema,
  MatrixComputerSchema,
  type MatrixComputer,
  type MatrixComputerAvailability,
  type MatrixComputerVersionLabel,
} from '@matrix-os/contracts';
import { Hono, type Context } from 'hono';

import type { ClerkAuth } from './clerk-auth.js';
import type { PlatformDB } from './db.js';
import {
  listUserRuntimeComputersByClerkId,
  type UserRuntimeComputerRecord,
} from './computer-repository.js';
import { isPreviewMachine } from './customer-vps-preview.js';
import {
  resolveAppDomainIdentity,
  type AppDomainIdentity,
} from './session-routing-identity.js';

const COMPUTER_LIST_LIMIT = 20;
const COMPUTER_QUERY_LIMIT = COMPUTER_LIST_LIMIT + 1;
const COMPUTER_CAPABILITIES = ['matrixComputerInventoryV1'] as const;
const RELEASE_DATE_PATTERN = /^(?:v|matrix-os-host-)(\d{4}\.\d{2}\.\d{2})(?:$|-)/;

function computerAvailability(status: string): MatrixComputerAvailability {
  if (status === 'running') return 'available';
  if (status === 'provisioning' || status === 'recovering' || status === 'resizing') return 'starting';
  return 'unavailable';
}

function computerVersionLabel(imageVersion: string | null): MatrixComputerVersionLabel {
  if (imageVersion === 'stable' || imageVersion === 'dev' || imageVersion === 'canary' || imageVersion === 'beta') {
    return imageVersion;
  }
  const releaseDate = imageVersion?.match(RELEASE_DATE_PATTERN)?.[1];
  return releaseDate ? `v${releaseDate}` as MatrixComputerVersionLabel : 'Version pending';
}

function projectComputer(machine: UserRuntimeComputerRecord): MatrixComputer | null {
  const preview = isPreviewMachine(machine);
  const parsed = MatrixComputerSchema.safeParse({
    handle: machine.handle,
    runtimeSlot: machine.runtimeSlot,
    label: machine.runtimeSlot === 'primary'
      ? 'Main Computer'
      : preview
        ? 'Preview Computer'
        : 'Additional Computer',
    availability: computerAvailability(machine.status),
    kind: preview ? 'preview' : 'customer',
    versionLabel: computerVersionLabel(machine.imageVersion),
    gatewayPath: `/vm/${machine.handle}`,
    capabilities: COMPUTER_CAPABILITIES,
  });
  return parsed.success ? parsed.data : null;
}

export function createComputerRoutes(opts: {
  db: PlatformDB;
  clerkAuth?: ClerkAuth;
  platformJwtSecret: string;
  legacyContainerRoutingEnabled: boolean;
  resolveIdentity?: typeof resolveAppDomainIdentity;
  applyNoStoreHeaders: (c: Context) => void;
  logRouteError: (route: string, err: unknown) => void;
}) {
  const routes = new Hono();
  const resolveIdentity = opts.resolveIdentity ?? resolveAppDomainIdentity;

  routes.get('/api/auth/computers', async (c) => {
    if (!opts.platformJwtSecret && !opts.clerkAuth) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Computers unavailable' }, 503);
    }

    let identity: AppDomainIdentity | null;
    try {
      identity = await resolveIdentity({
        authHeader: c.req.header('authorization'),
        cookieHeader: c.req.header('cookie'),
        clerkAuth: opts.clerkAuth,
        db: opts.db,
        platformJwtSecret: opts.platformJwtSecret,
        allowUnroutedClerkIdentity: true,
        legacyContainerRoutingEnabled: opts.legacyContainerRoutingEnabled,
        runtimeSlot: 'primary',
      });
    } catch (err: unknown) {
      opts.logRouteError('/api/auth/computers auth', err);
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Computers unavailable' }, 503);
    }
    if (!identity) {
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const selectedSlot = identity.source === 'auth' ? identity.runtimeSlot ?? null : null;
      const records = await listUserRuntimeComputersByClerkId(
        opts.db,
        identity.userId,
        COMPUTER_QUERY_LIMIT,
        selectedSlot ?? undefined,
      );
      const projected = records.flatMap((record) => {
        const computer = projectComputer(record);
        return computer ? [computer] : [];
      });
      const items = projected.slice(0, COMPUTER_LIST_LIMIT);
      const payload = MatrixComputerListSchema.parse({
        items,
        selectedSlot,
        hasMore: projected.length > items.length,
        limit: COMPUTER_LIST_LIMIT,
      });
      opts.applyNoStoreHeaders(c);
      return c.json(payload);
    } catch (err: unknown) {
      opts.logRouteError('/api/auth/computers', err);
      opts.applyNoStoreHeaders(c);
      return c.json({ error: 'Computers unavailable' }, 503);
    }
  });

  return routes;
}
