import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import type { CustomerVpsService } from './customer-vps-types.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { HostBundleVersionSchema } from './customer-vps-schema.js';
import {
  getLatestHostBundleReleaseForPr,
  getUserMachine,
  type PlatformDB,
  type UserMachineRecord,
} from './db.js';
import { listActivePrivatePreviewsForOwner, listActivePrivatePreviewsForPr } from './database/private-previews.js';
import { isActiveOrganizationMember, privatePreviewExpiresAt } from './private-preview-access.js';
import { timingSafeTokenEquals } from './platform-token.js';

const BODY_LIMIT = 1024;
const PrQuerySchema = z.string().regex(/^[1-9][0-9]{0,8}$/).transform(Number);
const MachineIdSchema = z.uuid();
const StartBodySchema = z.object({
  pr: z.number().int().min(1).max(999_999_999),
  bundleVersion: HostBundleVersionSchema,
}).strict();
const UpdateBodySchema = z.object({ bundleVersion: HostBundleVersionSchema }).strict();

type PrivatePreviewService = Pick<CustomerVpsService, 'startPrivatePreview' | 'updatePrivatePreview' | 'delete'>;
type Gate = { actorId: string; service: PrivatePreviewService } | Response;

function view(machine: UserMachineRecord) {
  return {
    machineId: machine.machineId,
    handle: machine.handle,
    pr: machine.sourcePr,
    confirmedBundleVersion: machine.confirmedBundleVersion,
    status: machine.status,
    provisionedAt: machine.provisionedAt,
    expiresAt: privatePreviewExpiresAt(machine.provisionedAt),
  };
}

const TOO_LARGE = Symbol('too-large');

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return undefined;
    // Bodies without a Content-Length reach the limit while being read.
    if (err instanceof Error && err.name === 'BodyLimitError') return TOO_LARGE;
    throw err;
  }
}

/**
 * Spec 537 Private Preview routes. Members of the internal Clerk organization
 * start, list, and update their own machines; an owner may always destroy
 * theirs; the Preview workflow tears down a closed PR's machines with the
 * platform secret. Mount before session routing so these never proxy to a VPS.
 */
export function createPrivatePreviewRoutes(opts: {
  db: PlatformDB;
  service?: PrivatePreviewService;
  resolveActor: (c: Context) => Promise<string | null>;
  internalOrganizationId: string | null;
  platformSecret: string;
  logRouteError: (route: string, err: unknown) => void;
}): Hono {
  const app = new Hono();
  const limit = bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'Request too large' }, 413) });

  async function authenticate(c: Context): Promise<Gate> {
    if (!opts.internalOrganizationId || !opts.service) {
      return c.json({ error: 'Private Preview unavailable' }, 503);
    }
    const actorId = await opts.resolveActor(c);
    if (!actorId) return c.json({ error: 'Unauthorized' }, 401);
    return { actorId, service: opts.service };
  }

  async function requireMember(c: Context): Promise<Gate> {
    const gate = await authenticate(c);
    if (gate instanceof Response) return gate;
    try {
      if (!await isActiveOrganizationMember(opts.db, opts.internalOrganizationId as string, gate.actorId)) {
        return c.json({ error: 'Forbidden' }, 403);
      }
    } catch (err: unknown) {
      opts.logRouteError('private preview membership', err);
      return c.json({ error: 'Private Preview unavailable' }, 503);
    }
    return gate;
  }

  function failure(c: Context, route: string, err: unknown): Response {
    if (err instanceof CustomerVpsError) return c.json({ error: err.publicMessage }, err.status as never);
    opts.logRouteError(route, err);
    return c.json({ error: 'Private Preview unavailable' }, 503);
  }

  app.get('/api/private-previews', async (c) => {
    const gate = await requireMember(c);
    if (gate instanceof Response) return gate;
    try {
      const machines = await listActivePrivatePreviewsForOwner(opts.db, gate.actorId);
      c.header('Cache-Control', 'no-store');
      return c.json({ privatePreviews: machines.map(view) });
    } catch (err: unknown) {
      return failure(c, '/api/private-previews', err);
    }
  });

  app.get('/api/private-previews/bundles', async (c) => {
    const gate = await requireMember(c);
    if (gate instanceof Response) return gate;
    const pr = PrQuerySchema.safeParse(c.req.query('pr') ?? '');
    if (!pr.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const release = await getLatestHostBundleReleaseForPr(opts.db, pr.data);
      if (!release) return c.json({ error: 'Not found' }, 404);
      c.header('Cache-Control', 'no-store');
      return c.json({
        pr: pr.data,
        version: release.version,
        gitCommit: release.gitCommit,
        author: release.sourceAuthor,
        createdAt: release.createdAt,
      });
    } catch (err: unknown) {
      return failure(c, '/api/private-previews/bundles', err);
    }
  });

  app.post('/api/private-previews', limit, async (c) => {
    const gate = await requireMember(c);
    if (gate instanceof Response) return gate;
    const raw = await readJson(c);
    if (raw === TOO_LARGE) return c.json({ error: 'Request too large' }, 413);
    const body = StartBodySchema.safeParse(raw);
    if (!body.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const started = await gate.service.startPrivatePreview(
        { clerkUserId: gate.actorId, sourcePr: body.data.pr, bundleVersion: body.data.bundleVersion },
        { dispatch: 'detached' },
      );
      return c.json(started, 202);
    } catch (err: unknown) {
      return failure(c, 'POST /api/private-previews', err);
    }
  });

  app.post('/api/private-previews/:machineId/deploy', limit, async (c) => {
    const gate = await requireMember(c);
    if (gate instanceof Response) return gate;
    const raw = await readJson(c);
    if (raw === TOO_LARGE) return c.json({ error: 'Request too large' }, 413);
    const machineId = MachineIdSchema.safeParse(c.req.param('machineId'));
    const body = UpdateBodySchema.safeParse(raw);
    if (!machineId.success || !body.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const updated = await gate.service.updatePrivatePreview({
        clerkUserId: gate.actorId,
        machineId: machineId.data,
        bundleVersion: body.data.bundleVersion,
      });
      return c.json(updated, 202);
    } catch (err: unknown) {
      return failure(c, 'POST /api/private-previews/:machineId/deploy', err);
    }
  });

  // Membership is not required: an owner who left the organization can still clean up.
  app.delete('/api/private-previews/:machineId', limit, async (c) => {
    const gate = await authenticate(c);
    if (gate instanceof Response) return gate;
    const machineId = MachineIdSchema.safeParse(c.req.param('machineId'));
    if (!machineId.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const machine = await getUserMachine(opts.db, machineId.data);
      if (!machine || machine.deletedAt || machine.provisioningClass !== 'private-preview'
        || machine.clerkUserId !== gate.actorId) {
        return c.json({ error: 'Not found' }, 404);
      }
      return c.json(await gate.service.delete(machine.machineId), 202);
    } catch (err: unknown) {
      return failure(c, 'DELETE /api/private-previews/:machineId', err);
    }
  });

  app.delete('/vps/private-previews', limit, async (c) => {
    const authorization = c.req.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!opts.platformSecret || !timingSafeTokenEquals(token, opts.platformSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!opts.service) return c.json({ error: 'Private Preview unavailable' }, 503);
    const pr = PrQuerySchema.safeParse(c.req.query('pr') ?? '');
    if (!pr.success) return c.json({ error: 'Invalid request' }, 400);
    let machines: UserMachineRecord[];
    try {
      machines = await listActivePrivatePreviewsForPr(opts.db, pr.data);
    } catch (err: unknown) {
      return failure(c, 'DELETE /vps/private-previews', err);
    }
    let destroyed = 0;
    let failed = 0;
    for (const machine of machines) {
      try {
        await opts.service.delete(machine.machineId);
        destroyed += 1;
      } catch (err: unknown) {
        failed += 1;
        opts.logRouteError(`DELETE /vps/private-previews machineId=${machine.machineId}`, err);
      }
    }
    return c.json({ destroyed, failed }, failed > 0 ? 502 : 200);
  });

  return app;
}
