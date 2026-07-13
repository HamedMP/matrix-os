import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';

import {
  ensurePlatformUser,
  type PlatformDB,
} from './db.js';
import {
  LegacyContainerOrchestrationDisabledError,
  type Orchestrator,
} from './orchestrator.js';
import type { MatrixProvisioner } from './matrix-provisioning.js';
import type { CustomerVpsService } from './customer-vps.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { buildPlatformVerificationToken, timingSafeTokenEquals } from './platform-token.js';
import { HetznerServerTypeSchema, RuntimeSlotSchema } from './customer-vps-schema.js';
import { DeveloperToolsSchema } from './developer-tools.js';
import {
  HANDLE_PATTERN,
  ensureProvisionedPlatformUser,
  isPostgresUniqueViolation,
  requireValidHandle,
} from './platform-route-utils.js';

const ProvisionBodySchema = z.object({
  handle: z.string().regex(HANDLE_PATTERN),
  clerkUserId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(100).optional(),
  email: z.string().email().max(320).optional(),
  runtimeSlot: RuntimeSlotSchema.optional().default('primary'),
  serverType: HetznerServerTypeSchema.optional(),
  developerTools: DeveloperToolsSchema.optional(),
});

const ClerkUserSyncBodySchema = z.object({
  handle: z.string().regex(HANDLE_PATTERN),
  clerkUserId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(100).optional(),
  email: z.string().email().max(320).optional(),
});

function isMissingContainerError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('No container for handle:');
}

function isLegacyContainerOrchestrationUnavailable(err: unknown): boolean {
  return err instanceof LegacyContainerOrchestrationDisabledError;
}

export function createLegacyContainerRoutes(opts: {
  db: PlatformDB;
  orchestrator: Orchestrator;
  customerVpsService?: CustomerVpsService;
  matrixProvisioner?: MatrixProvisioner;
  platformSecret: string;
  adminBodyLimit: number;
  logRouteError: (route: string, err: unknown) => void;
}) {
  const {
    db,
    orchestrator,
    customerVpsService,
    matrixProvisioner,
    platformSecret,
    logRouteError,
  } = opts;
  const routes = new Hono();

  // --- Container management ---

  routes.post('/containers/provision', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e: unknown) {
      logRouteError('/containers/provision parse', e);
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const parsed = ProvisionBodySchema.safeParse(body);
    if (!parsed.success) {
      const data = body as { handle?: unknown; clerkUserId?: unknown } | null;
      if (!data || typeof data !== 'object' || data.handle === undefined || data.clerkUserId === undefined) {
        return c.json({ error: 'handle and clerkUserId required' }, 400);
      }
      if (typeof data.handle !== 'string' || !HANDLE_PATTERN.test(data.handle)) {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      return c.json({ error: 'Validation error' }, 400);
    }

    const { handle, clerkUserId, displayName, email, runtimeSlot, serverType, developerTools } = parsed.data;
    if (!handle || !clerkUserId) {
      return c.json({ error: 'handle and clerkUserId required' }, 400);
    }
    try {
      if (customerVpsService) {
        const machine = await customerVpsService.provision({
          handle,
          clerkUserId,
          runtimeSlot,
          serverType,
          ...(developerTools ? { developerTools } : {}),
        });
        await ensureProvisionedPlatformUser(db, {
          clerkUserId,
          handle,
          displayName,
          email,
          runtimeId: `vps:${machine.machineId}`,
        });

        // Provision Matrix accounts (non-blocking: log error but don't fail VPS provision)
        if (matrixProvisioner) {
          try {
            await matrixProvisioner.provisionUser(handle);
          } catch (matrixErr) {
            console.error(`[matrix] Failed to provision Matrix accounts for ${handle}:`, matrixErr instanceof Error ? matrixErr.message : String(matrixErr));
          }
        }

        return c.json({
          runtime: 'customer_vps',
          handle,
          clerkUserId,
          ...machine,
          runtimeSlot,
        }, 202);
      }

      const record = await orchestrator.provision(handle, clerkUserId, displayName);
      await ensureProvisionedPlatformUser(db, {
        clerkUserId,
        handle,
        displayName,
        email,
        runtimeId: `legacy:${handle}`,
      });

      // Provision Matrix accounts (non-blocking: log error but don't fail container provision)
      if (matrixProvisioner) {
        try {
          await matrixProvisioner.provisionUser(handle);
        } catch (matrixErr) {
          console.error(`[matrix] Failed to provision Matrix accounts for ${handle}:`, matrixErr instanceof Error ? matrixErr.message : String(matrixErr));
        }
      }

      return c.json(record, 201);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.startsWith('Container already exists for handle:')) {
        return c.json({ error: 'Container already exists' }, 409);
      }
      if (e instanceof CustomerVpsError) {
        return c.json({ error: e.publicMessage }, e.status as never);
      }
      if (isLegacyContainerOrchestrationUnavailable(e)) {
        return c.json({ error: 'Not supported in this runtime mode' }, 503);
      }
      logRouteError('/containers/provision', e);
      return c.json({ error: 'Provision failed' }, 500);
    }
  });

  routes.post('/users/sync', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e: unknown) {
      logRouteError('/users/sync parse', e);
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const parsed = ClerkUserSyncBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation error' }, 400);
    }

    const { handle, clerkUserId, displayName, email } = parsed.data;
    try {
      const user = await ensurePlatformUser(db, {
        clerkId: clerkUserId,
        handle,
        displayName: displayName ?? handle,
        email: email ?? `${handle}@matrix-os.local`,
        containerId: `clerk:${clerkUserId}`,
        plan: 'free',
        status: 'active',
      });
      return c.json({
        id: user.id,
        clerkUserId: user.clerkId,
        handle: user.handle,
        status: user.status,
      });
    } catch (e: unknown) {
      if (isPostgresUniqueViolation(e)) {
        return c.json({ error: 'Handle unavailable', code: 'handle_unavailable' }, 409);
      }
      logRouteError('/users/sync', e);
      return c.json({ error: 'User sync failed' }, 500);
    }
  });

  routes.post('/containers/:handle/start', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    try {
      await orchestrator.start(requireValidHandle(c.req.param('handle')));
      return c.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isLegacyContainerOrchestrationUnavailable(e)) {
        return c.json({ error: 'Not supported in this runtime mode' }, 503);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logRouteError('/containers/:handle/start', e);
      return c.json({ error: 'Failed to start container' }, 500);
    }
  });

  routes.post('/containers/:handle/stop', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    try {
      await orchestrator.stop(requireValidHandle(c.req.param('handle')));
      return c.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isLegacyContainerOrchestrationUnavailable(e)) {
        return c.json({ error: 'Not supported in this runtime mode' }, 503);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logRouteError('/containers/:handle/stop', e);
      return c.json({ error: 'Failed to stop container' }, 500);
    }
  });

  routes.post('/containers/:handle/upgrade', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    try {
      const record = await orchestrator.upgrade(requireValidHandle(c.req.param('handle')));
      return c.json(record);
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isLegacyContainerOrchestrationUnavailable(e)) {
        return c.json({ error: 'Not supported in this runtime mode' }, 503);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logRouteError('/containers/:handle/upgrade', e);
      return c.json({ error: 'Upgrade failed' }, 500);
    }
  });

  routes.post('/containers/:handle/self-upgrade', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    if (!platformSecret) {
      return c.json({ error: 'Self-upgrade not configured' }, 503);
    }
    let handle: string;
    try {
      handle = requireValidHandle(c.req.param('handle'));
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message === 'Invalid handle')) {
        console.error('[platform] Unexpected self-upgrade handle validation failure:', err);
      }
      return c.json({ error: 'Invalid handle' }, 400);
    }
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

    const expected = buildPlatformVerificationToken(handle, platformSecret);
    if (!timingSafeTokenEquals(token, expected)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const record = await orchestrator.upgrade(handle);
      return c.json(record);
    } catch (e: unknown) {
      if (isLegacyContainerOrchestrationUnavailable(e)) {
        return c.json({ error: 'Not supported in this runtime mode' }, 503);
      }
      logRouteError('/containers/:handle/self-upgrade', e);
      return c.json({ error: 'Upgrade failed' }, 500);
    }
  });

  routes.post('/containers/rolling-restart', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    try {
      const result = await orchestrator.rollingRestart();
      return c.json(result);
    } catch (e: unknown) {
      if (isLegacyContainerOrchestrationUnavailable(e)) {
        return c.json({ error: 'Not supported in this runtime mode' }, 503);
      }
      logRouteError('/containers/rolling-restart', e);
      return c.json({ error: 'Rolling restart failed' }, 500);
    }
  });

  routes.delete('/containers/:handle', bodyLimit({ maxSize: opts.adminBodyLimit }), async (c) => {
    try {
      await orchestrator.destroy(requireValidHandle(c.req.param('handle')));
      return c.json({ ok: true });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'Invalid handle') {
        return c.json({ error: 'Invalid handle' }, 400);
      }
      if (isLegacyContainerOrchestrationUnavailable(e)) {
        return c.json({ error: 'Not supported in this runtime mode' }, 503);
      }
      if (isMissingContainerError(e)) {
        return c.json({ error: 'Container not found' }, 404);
      }
      logRouteError('/containers/:handle', e);
      return c.json({ error: 'Failed to destroy container' }, 500);
    }
  });

  routes.get('/containers', async (c) => {
    await orchestrator.syncStates();
    const status = c.req.query('status');
    return c.json(await orchestrator.listAll(status));
  });

  routes.get('/containers/:handle', async (c) => {
    const info = await orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json({ ...info, image: orchestrator.getImage() });
  });

  routes.get('/containers/check-handle/:handle', async (c) => {
    const info = await orchestrator.getInfo(c.req.param('handle'));
    if (!info) return c.json({ error: 'Not found' }, 404);
    return c.json({ exists: true, status: info.status });
  });

  // --- Admin dashboard ---

  routes.get('/admin/dashboard', async (c) => {
    await orchestrator.syncStates();
    const all = await orchestrator.listAll();
    const running = all.filter((r) => r.status === 'running');
    const stopped = all.filter((r) => r.status !== 'running');

    const containerResults = await Promise.all(
      running.map(async (r) => {
        const base = `http://matrixos-${r.handle}:4000`;
        const timeout = 3000;

        const fetchJson = async (url: string, label: string) => {
          try {
            const res = await fetch(url, {
              signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok) {
              console.warn(`[platform] ${label} returned ${res.status}`);
              return null;
            }
            return await res.json();
          } catch (err: unknown) {
            console.warn(
              `[platform] ${label} failed:`,
              err instanceof Error ? err.message : String(err),
            );
            return null;
          }
        };

        const [health, systemInfo, conversations] = await Promise.all([
          fetchJson(`${base}/health`, `${r.handle} health check`),
          fetchJson(`${base}/api/system/info`, `${r.handle} system info`),
          fetchJson(`${base}/api/conversations`, `${r.handle} conversations`),
        ]);

        return {
          handle: r.handle,
          status: r.status,
          lastActive: r.lastActive,
          health,
          systemInfo,
          conversationCount: Array.isArray(conversations) ? conversations.length : null,
        };
      }),
    );

    let usageSummary = null;
    try {
      const res = await fetch('http://proxy:8080/usage/summary', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) usageSummary = await res.json();
      else console.warn(`[platform] usage summary returned ${res.status}`);
    } catch (err: unknown) {
      console.warn(
        '[platform] usage summary fetch failed:',
        err instanceof Error ? err.message : String(err),
      );
    }

    return c.json({
      timestamp: new Date().toISOString(),
      summary: {
        total: all.length,
        running: running.length,
        stopped: stopped.length,
      },
      containers: containerResults,
      stoppedContainers: stopped.map((r) => ({
        handle: r.handle,
        status: r.status,
        lastActive: r.lastActive,
      })),
      usageSummary,
    });
  });

  return routes;
}
