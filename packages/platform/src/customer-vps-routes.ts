import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CustomerVpsError, logCustomerVpsError } from './customer-vps-errors.js';
import { bearerTokenMatches } from './customer-vps-auth.js';
import {
  MachineIdParamSchema,
  ProvisionRequestSchema,
  RegisterRequestSchema,
  RecoverRequestSchema,
  DeployRequestSchema,
} from './customer-vps-schema.js';
import type { CustomerVpsService } from './customer-vps.js';
import { buildFleetSummary, type FleetMachineView } from './customer-vps-fleet.js';
import { refreshVpsMetrics, refreshVpsRuntimeMetrics } from './metrics.js';
import type { VpsRuntimeMetricInput } from './metrics.js';

const VPS_BODY_LIMIT = 4096;

export interface MessagingResourceShape {
  vcpu: number;
  memoryGiB: number;
  diskGiB: number;
}

const MESSAGING_RESOURCE_FLOOR = {
  default: { vcpu: 2, memoryGiB: 4, diskGiB: 40 },
  synapse: { vcpu: 2, memoryGiB: 6, diskGiB: 60 },
} as const;

export function meetsMessagingResourceFloor(
  resources: MessagingResourceShape,
  profile: keyof typeof MESSAGING_RESOURCE_FLOOR = 'synapse',
): boolean {
  const floor = MESSAGING_RESOURCE_FLOOR[profile];
  return resources.vcpu >= floor.vcpu && resources.memoryGiB >= floor.memoryGiB && resources.diskGiB >= floor.diskGiB;
}

export interface CustomerVpsRoutesDeps {
  service: CustomerVpsService;
  platformSecret: string;
  probeMachineHealth?: (machine: { machineId: string; handle: string; publicIPv4: string | null }) => Promise<boolean>;
  probeMachineRuntime?: (machine: { machineId: string; handle: string; publicIPv4: string | null }) => Promise<{
    healthy: boolean;
    runtimeVersion?: string | null;
    probeLatencyMs?: number;
    load1?: number | null;
    cpuCount?: number | null;
    memoryTotalBytes?: number | null;
    memoryFreeBytes?: number | null;
    diskTotalBytes?: number | null;
    diskFreeBytes?: number | null;
  }>;
  recordRuntimeMetrics?: (machines: Array<VpsRuntimeMetricInput & {
    machineId: string;
    status: string;
    publicIPv4: string | null;
    imageVersion: string | null;
  }>) => void;
}

function jsonError(c: import('hono').Context, err: unknown, fallback: string) {
  if (err instanceof CustomerVpsError) {
    return c.json({ error: err.publicMessage }, err.status as never);
  }
  logCustomerVpsError(fallback, err);
  return c.json({ error: 'Provisioning failed' }, 500);
}

async function readJson(c: import('hono').Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) {
      logCustomerVpsError('request body parse failed', err);
    }
    throw new CustomerVpsError(400, 'invalid_state', 'Invalid request');
  }
}

export function createCustomerVpsRoutes(deps: CustomerVpsRoutesDeps): Hono {
  if (!deps.service) {
    throw new Error('customer VPS routes require service dependency');
  }
  const app = new Hono();

  function requirePlatformAuth(c: import('hono').Context): Response | null {
    if (!deps.platformSecret) {
      return c.json({ error: 'VPS provisioning not configured' }, 503);
    }
    if (!bearerTokenMatches(c.req.header('authorization'), deps.platformSecret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return null;
  }

  app.post('/provision', bodyLimit({ maxSize: VPS_BODY_LIMIT }), async (c) => {
    const authError = requirePlatformAuth(c);
    if (authError) return authError;
    try {
      const parsed = ProvisionRequestSchema.safeParse(await readJson(c));
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400);
      }
      return c.json(await deps.service.provision(parsed.data), 202);
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/provision');
    }
  });

  app.post('/register', bodyLimit({ maxSize: VPS_BODY_LIMIT }), async (c) => {
    try {
      const parsed = RegisterRequestSchema.safeParse(await readJson(c));
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400);
      }
      const auth = c.req.header('authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
      return c.json(await deps.service.register(token, parsed.data), 200);
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/register');
    }
  });

  app.post('/recover', bodyLimit({ maxSize: VPS_BODY_LIMIT }), async (c) => {
    const authError = requirePlatformAuth(c);
    if (authError) return authError;
    try {
      const parsed = RecoverRequestSchema.safeParse(await readJson(c));
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400);
      }
      return c.json(await deps.service.recover(parsed.data), 202);
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/recover');
    }
  });

  app.get('/:machineId/status', async (c) => {
    const authError = requirePlatformAuth(c);
    if (authError) return authError;
    const parsed = MachineIdParamSchema.safeParse({ machineId: c.req.param('machineId') });
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    try {
      return c.json(await deps.service.status(parsed.data.machineId), 200);
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/:machineId/status');
    }
  });

  app.delete('/:machineId', async (c) => {
    const authError = requirePlatformAuth(c);
    if (authError) return authError;
    const parsed = MachineIdParamSchema.safeParse({ machineId: c.req.param('machineId') });
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    try {
      return c.json(await deps.service.delete(parsed.data.machineId), 200);
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/:machineId');
    }
  });

  app.post('/deploy', bodyLimit({ maxSize: VPS_BODY_LIMIT }), async (c) => {
    const authError = requirePlatformAuth(c);
    if (authError) return authError;
    try {
      const parsed = DeployRequestSchema.safeParse(await readJson(c));
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400);
      }
      return c.json(await deps.service.deploy(parsed.data), 200);
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/deploy');
    }
  });

  app.get('/fleet', async (c) => {
    const authError = requirePlatformAuth(c);
    if (authError) return authError;
    try {
      const statuses = await deps.service.listAllMachines();
      const probed = await Promise.allSettled(
        statuses.map(async (s): Promise<FleetMachineView> => {
          if (s.status !== 'running' || !s.publicIPv4 || (!deps.probeMachineHealth && !deps.probeMachineRuntime)) {
            return { ...s, healthy: false };
          }
          if (deps.probeMachineRuntime) {
            const runtime = await deps.probeMachineRuntime(s).catch((err: unknown) => {
              logCustomerVpsError(`fleet runtime probe failed for ${s.handle}`, err);
              return { healthy: false };
            });
            return { ...s, ...runtime, healthy: runtime.healthy };
          }
          const healthy = await deps.probeMachineHealth!(s).catch((err: unknown) => {
            logCustomerVpsError(`fleet probe failed for ${s.handle}`, err);
            return false;
          });
          return { ...s, healthy };
        }),
      );
      const machines = probed
        .filter((r): r is PromiseFulfilledResult<FleetMachineView> => r.status === "fulfilled")
        .map(r => r.value);

      refreshVpsMetrics(machines);
      refreshVpsRuntimeMetrics(machines);
      deps.recordRuntimeMetrics?.(machines);

      const FLEET_LIMIT = 500;
      return c.json({ fleet: buildFleetSummary(machines), machines, truncated: machines.length >= FLEET_LIMIT });
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/fleet');
    }
  });

  return app;
}
