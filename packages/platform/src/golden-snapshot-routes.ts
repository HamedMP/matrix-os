import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import { bearerTokenMatches } from './customer-vps-auth.js';
import {
  enqueueGoldenSnapshotBuild,
  GoldenSnapshotBuildRequiresRetryError,
  decodeGoldenSnapshotAffectedMachineCursor,
  decodeGoldenSnapshotOperationalCursor,
  encodeGoldenSnapshotAffectedMachineCursor,
  encodeGoldenSnapshotOperationalCursor,
  getGoldenSnapshot,
  getGoldenSnapshotBuild,
  listGoldenSnapshotAffectedMachines,
  listGoldenSnapshotOperationalStatus,
  retryGoldenSnapshotCleanup,
  retryGoldenSnapshotBuild,
  revokeGoldenSnapshot,
  revokeGoldenSnapshotBaseGeneration,
} from './golden-snapshot-repository.js';
import type { GoldenSnapshotRuntimeConfig } from './golden-snapshot-schema.js';
import {
  GoldenSnapshotBaseGenerationSchema,
  GoldenSnapshotBundleVersionSchema,
} from './golden-snapshot-schema.js';
import {
  GoldenSnapshotCallbackSchema,
  GoldenSnapshotCallbackError,
  type GoldenSnapshotService,
} from './golden-snapshot-service.js';

const SNAPSHOT_ENQUEUE_BODY_LIMIT = 8 * 1024;
const SNAPSHOT_CALLBACK_BODY_LIMIT = 64 * 1024;
const SNAPSHOT_RETRY_BODY_LIMIT = 1024;
const SNAPSHOT_REVOKE_BODY_LIMIT = 4 * 1024;
const BuildIdSchema = z.string().uuid();
const SnapshotIdSchema = z.string().uuid();
const CleanupIdSchema = z.string().uuid();
const StatusCursorSchema = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/).transform((value, ctx) => {
  try {
    return decodeGoldenSnapshotOperationalCursor(value);
  } catch (err: unknown) {
    if (err instanceof Error) {
      ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
      return z.NEVER;
    }
    throw err;
  }
});
const StatusQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: StatusCursorSchema.optional(),
}).strict();
const AffectedMachineCursorParamSchema = z.string().min(16).max(512)
  .regex(/^[A-Za-z0-9_-]+$/).transform((value, ctx) => {
    try {
      return decodeGoldenSnapshotAffectedMachineCursor(value);
    } catch (err: unknown) {
      if (err instanceof Error) {
        ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
        return z.NEVER;
      }
      throw err;
    }
  });
const AffectedMachineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: AffectedMachineCursorParamSchema.optional(),
}).strict();
const RevokeSchema = z.object({ reason: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/) }).strict();
const EnqueueSchema = z.object({
  bundleVersion: GoldenSnapshotBundleVersionSchema,
  testMode: z.boolean().optional().default(false),
}).strict();

export interface GoldenSnapshotRoutesDeps {
  db: PlatformDB;
  service: GoldenSnapshotService;
  config: GoldenSnapshotRuntimeConfig;
  platformSecret: string;
  operatorSecret: string;
  now?: () => string;
  idFactory?: () => string;
}

async function readJson(c: import('hono').Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

export function createGoldenSnapshotRoutes(deps: GoldenSnapshotRoutesDeps): Hono {
  if (!deps.db || !deps.service) throw new Error('Golden snapshot routes require dependencies');
  const routes = new Hono();
  const now = deps.now ?? (() => new Date().toISOString());
  const idFactory = deps.idFactory ?? randomUUID;

  function requireBearerAuth(c: import('hono').Context, secret: string): Response | null {
    if (!secret) return c.json({ error: 'Snapshot automation not configured' }, 503);
    if (!bearerTokenMatches(c.req.header('authorization'), secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return null;
  }

  routes.post('/snapshot-builds', bodyLimit({ maxSize: SNAPSHOT_ENQUEUE_BODY_LIMIT }), async (c) => {
    const authorization = c.req.header('authorization');
    if (!bearerTokenMatches(authorization, deps.platformSecret)
      && !bearerTokenMatches(authorization, deps.operatorSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const parsed = EnqueueSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    const authError = requireBearerAuth(
      c,
      parsed.data.testMode ? deps.operatorSecret : deps.platformSecret,
    );
    if (authError) return authError;
    if (!deps.config.buildsEnabled) return c.json({ error: 'Snapshot builds disabled' }, 503);
    try {
      const result = await enqueueGoldenSnapshotBuild(deps.db, {
        bundleVersion: parsed.data.bundleVersion,
        compatibility: deps.config.compatibility,
        snapshotId: idFactory(),
        buildId: idFactory(),
        testMode: parsed.data.testMode,
        now: now(),
      });
      if (result.reused && result.build.status === 'failed') {
        return c.json({ error: 'Snapshot build requires retry' }, 409);
      }
      return c.json({
        snapshotId: result.snapshot.snapshotId,
        buildId: result.build.buildId,
        status: result.build.status,
        reused: result.reused,
      }, 202);
    } catch (err: unknown) {
      if (err instanceof GoldenSnapshotBuildRequiresRetryError) {
        return c.json({ error: 'Snapshot build requires retry' }, 409);
      }
      console.error(`[golden-snapshot] enqueue failed: ${err instanceof Error ? err.name : typeof err}`);
      return c.json({ error: 'Snapshot build request failed' }, 500);
    }
  });

  routes.get('/snapshot-builds/:buildId', async (c) => {
    const authError = requireBearerAuth(c, deps.operatorSecret);
    if (authError) return authError;
    const parsedId = BuildIdSchema.safeParse(c.req.param('buildId'));
    if (!parsedId.success) return c.json({ error: 'Invalid request' }, 400);
    const build = await getGoldenSnapshotBuild(deps.db, parsedId.data);
    if (!build) return c.json({ error: 'Snapshot build not found' }, 404);
    const snapshot = await getGoldenSnapshot(deps.db, build.snapshotId);
    if (!snapshot) return c.json({ error: 'Snapshot build unavailable' }, 503);
    return c.json({
      buildId: build.buildId,
      snapshotId: snapshot.snapshotId,
      phase: build.phase,
      status: build.status,
      attempts: build.attempts,
      state: snapshot.state,
      failureCode: build.lastErrorCode ?? snapshot.failureCode,
    });
  });

  routes.get('/snapshots', async (c) => {
    const authError = requireBearerAuth(c, deps.operatorSecret);
    if (authError) return authError;
    const query = StatusQuerySchema.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    });
    if (!query.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const page = await listGoldenSnapshotOperationalStatus(deps.db, query.data);
      return c.json({
        snapshots: page.snapshots,
        ...(page.nextCursor ? { nextCursor: encodeGoldenSnapshotOperationalCursor(page.nextCursor) } : {}),
      });
    } catch (err: unknown) {
      console.error(`[golden-snapshot] status failed: ${err instanceof Error ? err.name : typeof err}`);
      return c.json({ error: 'Snapshot status unavailable' }, 500);
    }
  });

  routes.post('/snapshot-builds/:buildId/retry', bodyLimit({ maxSize: SNAPSHOT_RETRY_BODY_LIMIT }), async (c) => {
    const authError = requireBearerAuth(c, deps.operatorSecret);
    if (authError) return authError;
    const buildId = BuildIdSchema.safeParse(c.req.param('buildId'));
    if (!buildId.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      return c.json({ retried: await retryGoldenSnapshotBuild(deps.db, buildId.data, now()) });
    } catch (err: unknown) {
      console.error(`[golden-snapshot] retry failed: ${err instanceof Error ? err.name : typeof err}`);
      return c.json({ error: 'Snapshot retry unavailable' }, 500);
    }
  });

  routes.post('/snapshots/:snapshotId/revoke', bodyLimit({ maxSize: SNAPSHOT_REVOKE_BODY_LIMIT }), async (c) => {
    const authError = requireBearerAuth(c, deps.operatorSecret);
    if (authError) return authError;
    const snapshotId = SnapshotIdSchema.safeParse(c.req.param('snapshotId'));
    const body = RevokeSchema.safeParse(await readJson(c));
    if (!snapshotId.success || !body.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      return c.json({ revoked: await revokeGoldenSnapshot(deps.db, snapshotId.data, body.data.reason, now()) });
    } catch (err: unknown) {
      console.error(`[golden-snapshot] revocation failed: ${err instanceof Error ? err.name : typeof err}`);
      return c.json({ error: 'Snapshot revocation unavailable' }, 500);
    }
  });

  routes.post(
    '/snapshot-base-generations/:baseGeneration/revoke',
    bodyLimit({ maxSize: SNAPSHOT_REVOKE_BODY_LIMIT }),
    async (c) => {
      const authError = requireBearerAuth(c, deps.operatorSecret);
      if (authError) return authError;
      const baseGeneration = GoldenSnapshotBaseGenerationSchema.safeParse(c.req.param('baseGeneration'));
      const body = RevokeSchema.safeParse(await readJson(c));
      if (!baseGeneration.success || !body.success) return c.json({ error: 'Invalid request' }, 400);
      try {
        await revokeGoldenSnapshotBaseGeneration(
          deps.db,
          baseGeneration.data,
          body.data.reason,
          now(),
        );
        return c.json({ revoked: true });
      } catch (err: unknown) {
        console.error(`[golden-snapshot] base generation revocation failed: ${err instanceof Error ? err.name : typeof err}`);
        return c.json({ error: 'Snapshot revocation unavailable' }, 500);
      }
    },
  );

  routes.get('/snapshot-base-generations/:baseGeneration/affected-machines', async (c) => {
    const authError = requireBearerAuth(c, deps.operatorSecret);
    if (authError) return authError;
    const baseGeneration = GoldenSnapshotBaseGenerationSchema.safeParse(c.req.param('baseGeneration'));
    const query = AffectedMachineQuerySchema.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    });
    if (!baseGeneration.success || !query.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const page = await listGoldenSnapshotAffectedMachines(deps.db, baseGeneration.data, query.data);
      return c.json({
        machines: page.machines,
        ...(page.nextCursor ? {
          nextCursor: encodeGoldenSnapshotAffectedMachineCursor(page.nextCursor),
        } : {}),
      });
    } catch (err: unknown) {
      console.error(`[golden-snapshot] affected machines failed: ${err instanceof Error ? err.name : typeof err}`);
      return c.json({ error: 'Affected machine inventory unavailable' }, 500);
    }
  });

  routes.post('/snapshot-cleanup/:cleanupId/retry', bodyLimit({ maxSize: SNAPSHOT_RETRY_BODY_LIMIT }), async (c) => {
    const authError = requireBearerAuth(c, deps.operatorSecret);
    if (authError) return authError;
    const cleanupId = CleanupIdSchema.safeParse(c.req.param('cleanupId'));
    if (!cleanupId.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      return c.json({ retried: await retryGoldenSnapshotCleanup(deps.db, cleanupId.data, now()) });
    } catch (err: unknown) {
      console.error(`[golden-snapshot] cleanup retry failed: ${err instanceof Error ? err.name : typeof err}`);
      return c.json({ error: 'Snapshot cleanup retry unavailable' }, 500);
    }
  });

  routes.post('/snapshot-builds/:buildId/callback', bodyLimit({ maxSize: SNAPSHOT_CALLBACK_BODY_LIMIT }), async (c) => {
    const buildId = BuildIdSchema.safeParse(c.req.param('buildId'));
    if (!buildId.success) return c.json({ error: 'Invalid request' }, 400);
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token.length < 16 || token.length > 512) {
      return c.json({ error: 'Snapshot callback rejected' }, 401);
    }
    const parsed = GoldenSnapshotCallbackSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      await deps.service.consumeCallback(buildId.data, token, parsed.data);
      return c.json({ accepted: true });
    } catch (err: unknown) {
      if (err instanceof GoldenSnapshotCallbackError) {
        return c.json(
          { error: 'Snapshot callback rejected' },
          err.code === 'unauthorized' ? 401 : 409,
        );
      }
      console.error(`[golden-snapshot] callback failed: ${err instanceof Error ? err.name : typeof err}`);
      return c.json({ error: 'Snapshot callback failed' }, 500);
    }
  });

  return routes;
}
