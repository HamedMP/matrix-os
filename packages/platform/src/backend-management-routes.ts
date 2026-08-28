import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod/v4';
import { ClientTargetSchema } from '@matrix-os/contracts';
import type { PlatformDB } from './db.js';
import { bearerTokenMatches } from './customer-vps-auth.js';
import { buildPlatformVerificationToken } from './platform-token.js';
import { BackendConfigSchema, MachineOverrideSchema } from './backend-management-schema.js';
import { BackendInvalidConfiguration, BackendMachineNotFound, BackendPolicyConflict, clearMachineOverride, readBackendPolicy, readBackendStatus, readMachineOverride, retryMachine, setMachineOverride, updateBackendPolicy } from './backend-management-repository.js';

const MachineId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export function createClientPolicyRoutes({ db }: { db: PlatformDB }): Hono {
  const app = new Hono();
  app.get('/', async c => {
    c.header('cache-control', 'no-store'); c.header('cdn-cache-control', 'no-store');
    const target = ClientTargetSchema.safeParse(c.req.query('target'));
    if (!target.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const policy = await readBackendPolicy(db);
      return c.json({ schemaVersion: 1, revision: policy.revision, policy: policy.config.clients[target.data] ?? null });
    } catch (err: unknown) {
      console.warn('[client-policy] Policy unavailable', err instanceof Error ? err.name : typeof err);
      return c.json({ error: 'Policy unavailable' }, 503);
    }
  });
  return app;
}
export function createBackendManagementRoutes({ db, platformSecret }: { db: PlatformDB; platformSecret: string }): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status === 413) return c.json({ error: 'Request too large' }, 413);
    if (err instanceof BackendPolicyConflict) return c.json({ error: 'Policy conflict' }, 409);
    if (err instanceof BackendMachineNotFound) return c.json({ error: 'Machine not found' }, 404);
    if (err instanceof BackendInvalidConfiguration || err instanceof z.ZodError || err instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 400);
    console.warn('[backend-management] Request failed', err.name);
    return c.json({ error: 'Management unavailable' }, 503);
  });
  // Machine policy is intentionally before the admin middleware. Its bearer is
  // a per-machine operator token, never a customer JWT or a UI feature flag.
  app.get('/machines/:id/policy', async c => {
    const id = MachineId.parse(c.req.param('id'));
    if (!platformSecret) return c.json({ error: 'Management unavailable' }, 503);
    await db.ready;
    const machine = await db.executor.selectFrom('user_machines').select('handle').where('machine_id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!machine || !bearerTokenMatches(c.req.header('authorization'), buildPlatformVerificationToken(machine.handle, platformSecret))) return c.json({ error: 'Unauthorized' }, 401);
    c.header('cache-control', 'no-store');
    return c.json(await readMachineOverride(db, id));
  });
  app.use('*', async (c, next) => {
    if (!platformSecret) return c.json({ error: 'Management unavailable' }, 503);
    if (!bearerTokenMatches(c.req.header('authorization'), platformSecret)) return c.json({ error: 'Unauthorized' }, 401);
    c.header('cache-control', 'no-store');
    await next();
  });
  app.get('/status', async c => {
    const after = z.string().max(128).regex(/^[A-Za-z0-9_-]*$/).parse(c.req.query('after') ?? '');
    return c.json(await readBackendStatus(db, after));
  });
  app.put('/policy', bodyLimit({ maxSize: 32_768 }), async c => {
    const request = z.object({ revision: z.number().int().nonnegative(), config: BackendConfigSchema }).strict().parse(await c.req.json());
    const policy = await updateBackendPolicy(db, request.config, request.revision);
    return c.json({ revision: policy.revision, config: policy.config });
  });
  app.put('/machines/:id/override', bodyLimit({ maxSize: 4096 }), async c => {
    const value = MachineOverrideSchema.parse(await c.req.json());
    const id = MachineId.parse(c.req.param('id'));
    const date = Date.now();
    if (Date.parse(value.until) <= date || Date.parse(value.until) > date + 7 * 86400_000) return c.json({ error: 'Invalid request' }, 400);
    await setMachineOverride(db, id, value);
    return c.json({ ok: true });
  });
  app.post('/machines/:id/retry', bodyLimit({ maxSize: 1024 }), async c => {
    z.object({}).strict().parse(await c.req.json());
    await retryMachine(db, MachineId.parse(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.delete('/machines/:id/override', bodyLimit({ maxSize: 1024 }), async c => {
    await clearMachineOverride(db, MachineId.parse(c.req.param('id')));
    return c.json({ ok: true });
  });
  return app;
}
