import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod/v4';
import { SyncRuntimeSlotSchema } from '@matrix-os/contracts';
import { getActiveUserMachineByHandle, type PlatformDB } from '../db.js';
import { buildPlatformContainerRuntimeToken, timingSafeTokenEquals } from '../platform-token.js';
import type { ContainerLifecycleService } from './container-lifecycle-service.js';
import { ManifestDigestSchema } from './container-runtime-client.js';

/**
 * Routes a container runtime calls on the platform (contracts/lifecycle.md).
 * Each request carries the per-runtime token for the row's current token
 * epoch, which moves with the generation, so a replaced unit is rejected.
 */

const BODY_LIMIT = 4096;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const RATE_MAX_KEYS = 10_000;
const MIN_SECRET_LENGTH = 32;

const HandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const MachineIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const RegisterBodySchema = z.strictObject({
  generation: z.number().int().min(1).max(2_147_483_647),
  bundleVersion: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
});
const FlushedBodySchema = z.strictObject({
  generation: z.number().int().min(1).max(2_147_483_647),
  manifestDigest: ManifestDigestSchema,
});
/** Advisory only: idleness is decided from traffic the platform observes, so this report never extends a session. */
const ActivityBodySchema = z.strictObject({ unsettledRuns: z.number().int().min(0).max(100_000) });

export interface ContainerInternalRoutesDeps {
  db: PlatformDB;
  lifecycle: Pick<ContainerLifecycleService, 'markRegistered' | 'recordFlush'>;
  platformSecret: string;
  /** Post-registration setup (funded AI). Must be idempotent: a failure asks the runtime to retry. */
  onRegistered?: (machineId: string) => Promise<void>;
  logError?: (message: string, detail: Record<string, string>) => void;
}

interface AuthenticatedRuntime {
  machineId: string;
}

function createRateLimiter() {
  const windows = new Map<string, number[]>();
  return (key: string, at: number): boolean => {
    const recent = (windows.get(key) ?? []).filter((t) => t > at - RATE_WINDOW_MS);
    windows.delete(key);
    if (recent.length >= RATE_MAX) {
      windows.set(key, recent);
      return false;
    }
    recent.push(at);
    windows.set(key, recent);
    while (windows.size > RATE_MAX_KEYS) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
    return true;
  };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) throw err;
    return c.json({ error: 'invalid_request' }, 400);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

export function createContainerInternalRoutes(deps: ContainerInternalRoutesDeps): Hono {
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));
  const allow = createRateLimiter();
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    logError('[container-internal] route failed', { cause: errorName(err) });
    return c.json({ error: 'internal_error' }, 500);
  });

  /** Unauthorized for every mismatch, so callers learn nothing about which part was wrong. */
  async function authenticate(c: Context, route: string): Promise<AuthenticatedRuntime | Response> {
    if (deps.platformSecret.length < MIN_SECRET_LENGTH) return c.json({ error: 'unavailable' }, 503);
    const handle = HandleSchema.safeParse(c.req.param('handle'));
    const machineId = MachineIdSchema.safeParse(c.req.header('x-matrix-machine-id')?.trim());
    const slot = SyncRuntimeSlotSchema.safeParse(c.req.header('x-matrix-runtime-slot')?.trim());
    const authorization = c.req.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!handle.success || !machineId.success || !slot.success || !token) return c.json({ error: 'unauthorized' }, 401);
    const machine = await getActiveUserMachineByHandle(deps.db, handle.data, slot.data);
    if (!machine || machine.substrate !== 'container' || machine.machineId !== machineId.data) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const expected = buildPlatformContainerRuntimeToken(
      { handle: machine.handle, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot },
      deps.platformSecret, machine.runtimeTokenEpoch);
    if (!timingSafeTokenEquals(token, expected)) return c.json({ error: 'unauthorized' }, 401);
    if (!allow(`${route}:${machine.machineId}`, Date.now())) return c.json({ error: 'rate_limited' }, 429);
    return { machineId: machine.machineId };
  }

  app.post('/internal/containers/:handle/register', bodyLimit({ maxSize: BODY_LIMIT }), async (c) => {
    c.header('Cache-Control', 'no-store');
    const runtime = await authenticate(c, 'register');
    if (runtime instanceof Response) return runtime;
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = RegisterBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const outcome = await deps.lifecycle.markRegistered(runtime.machineId, parsed.data.generation, {
      imageVersion: parsed.data.bundleVersion,
    });
    if (outcome === 'unit_pending') {
      // The gateway answered before the platform recorded its unit; registering then would fence it.
      c.header('Retry-After', '1');
      return c.json({ error: 'retry' }, 503);
    }
    if (outcome !== 'ok') return c.json({ error: outcome }, 409);
    if (deps.onRegistered) {
      try {
        await deps.onRegistered(runtime.machineId);
      } catch (err: unknown) {
        logError('[container-internal] post-registration setup failed', { cause: errorName(err) });
        c.header('Retry-After', '5');
        return c.json({ error: 'retry' }, 503);
      }
    }
    return c.json({ ok: true }, 200);
  });

  app.post('/internal/containers/:handle/lifecycle/flushed', bodyLimit({ maxSize: BODY_LIMIT }), async (c) => {
    c.header('Cache-Control', 'no-store');
    const runtime = await authenticate(c, 'flushed');
    if (runtime instanceof Response) return runtime;
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = FlushedBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const outcome = await deps.lifecycle.recordFlush(runtime.machineId, parsed.data.generation, parsed.data.manifestDigest);
    if (outcome !== 'ok') return c.json({ error: outcome }, 409);
    return c.body(null, 204);
  });

  app.post('/internal/containers/:handle/lifecycle/activity', bodyLimit({ maxSize: BODY_LIMIT }), async (c) => {
    c.header('Cache-Control', 'no-store');
    const runtime = await authenticate(c, 'activity');
    if (runtime instanceof Response) return runtime;
    const body = await readJson(c);
    if (body instanceof Response) return body;
    if (!ActivityBodySchema.safeParse(body).success) return c.json({ error: 'invalid_request' }, 400);
    return c.body(null, 204);
  });

  return app;
}
