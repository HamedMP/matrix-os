import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';
import { CustomerVpsError, logCustomerVpsError, type CustomerVpsFailureCode } from './customer-vps-errors.js';
import { bearerTokenMatches } from './customer-vps-auth.js';
import {
  MachineIdParamSchema,
  PreviewProvisionRequestSchema,
  ProvisionRequestSchema,
  RegisterRequestSchema,
  RecoverRequestSchema,
  ResizeMachineRequestSchema,
  DeployRequestSchema,
} from './customer-vps-schema.js';
import type { CustomerVpsService } from './customer-vps.js';
import { buildFleetSummary, type FleetMachineView } from './customer-vps-fleet.js';
import { refreshVpsMetrics, refreshVpsRuntimeMetrics, vpsProvisionFailuresTotal } from './metrics.js';
import type { VpsRuntimeMetricInput } from './metrics.js';

const VPS_BODY_LIMIT = 4096;
const RUNTIME_ACTIVATED_EVENT =
  MATRIX_TELEMETRY_EVENTS.RUNTIME_ACTIVATED ?? 'matrix_runtime_activated';

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
  /**
   * Optional product telemetry sink. Fire-and-forget: implementations must
   * never throw into the request path, and callers only pass low-cardinality,
   * PII-free properties (failure codes, handles, machine ids).
   */
  captureEvent?: (
    event: string,
    options?: { distinctId?: string; properties?: Record<string, string | number | boolean | undefined> },
  ) => void;
}

function customerVpsFailureCode(err: unknown): CustomerVpsFailureCode {
  return err instanceof CustomerVpsError ? err.code : 'unknown';
}

function customerVpsFailureStatus(err: unknown): number {
  return err instanceof CustomerVpsError ? err.status : 500;
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

  function emitTelemetry(
    event: string,
    options?: { distinctId?: string; properties?: Record<string, string | number | boolean | undefined> },
  ): void {
    if (!deps.captureEvent) return;
    try {
      deps.captureEvent(event, options);
    } catch (err: unknown) {
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[customer-vps] telemetry capture failed for ${event}: ${kind}`);
    }
  }

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
    // Body-parse and validation failures are request errors, not provisioning
    // failures: they must not increment the provision-failure counter or emit
    // VPS_PROVISION_FAILED, or malformed traffic would fire the alert.
    let parsed: ReturnType<typeof ProvisionRequestSchema.safeParse>;
    try {
      parsed = ProvisionRequestSchema.safeParse(await readJson(c));
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/provision');
    }
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const clerkUserId = parsed.data.clerkUserId;
    const handle = parsed.data.handle;
    emitTelemetry(MATRIX_TELEMETRY_EVENTS.VPS_PROVISION_REQUESTED, {
      distinctId: clerkUserId ?? handle,
      properties: {
        handle,
        runtime_slot: parsed.data.runtimeSlot,
        requested_server_type: parsed.data.serverType,
        developer_tools_count: parsed.data.developerTools?.length,
      },
    });
    try {
      return c.json(await deps.service.provision(parsed.data), 202);
    } catch (err: unknown) {
      const failureCode = customerVpsFailureCode(err);
      vpsProvisionFailuresTotal.inc({ failure_code: failureCode });
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.VPS_PROVISION_FAILED, {
        distinctId: clerkUserId ?? handle,
        properties: {
          failure_code: failureCode,
          http_status: customerVpsFailureStatus(err),
          handle,
        },
      });
      return jsonError(c, err, '/vps/provision');
    }
  });

  app.post('/preview/provision', bodyLimit({ maxSize: VPS_BODY_LIMIT }), async (c) => {
    const authError = requirePlatformAuth(c);
    if (authError) return authError;
    let parsed: ReturnType<typeof PreviewProvisionRequestSchema.safeParse>;
    try {
      parsed = PreviewProvisionRequestSchema.safeParse(await readJson(c));
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/preview/provision');
    }
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const { clerkUserId, handle, runtimeSlot, developerTools } = parsed.data;
    emitTelemetry(MATRIX_TELEMETRY_EVENTS.VPS_PROVISION_REQUESTED, {
      distinctId: clerkUserId,
      properties: {
        handle,
        runtime_slot: runtimeSlot,
        developer_tools_count: developerTools?.length,
      },
    });
    try {
      return c.json(await deps.service.provisionPreview(parsed.data), 202);
    } catch (err: unknown) {
      const failureCode = customerVpsFailureCode(err);
      vpsProvisionFailuresTotal.inc({ failure_code: failureCode });
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.VPS_PROVISION_FAILED, {
        distinctId: clerkUserId,
        properties: {
          failure_code: failureCode,
          http_status: customerVpsFailureStatus(err),
          handle,
        },
      });
      return jsonError(c, err, '/vps/preview/provision');
    }
  });

  app.post('/register', bodyLimit({ maxSize: VPS_BODY_LIMIT }), async (c) => {
    let parsed: ReturnType<typeof RegisterRequestSchema.safeParse>;
    try {
      parsed = RegisterRequestSchema.safeParse(await readJson(c));
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/register');
    }
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const machineId = parsed.data.machineId;
    try {
      const auth = c.req.header('authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const result = await deps.service.register(token, parsed.data);
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.VPS_REGISTERED, {
        properties: { machine_id: machineId },
      });
      if (result.status === 'running') {
        emitTelemetry(RUNTIME_ACTIVATED_EVENT, {
          properties: { machine_id: machineId, image_version: parsed.data.imageVersion },
        });
      }
      return c.json(result, 200);
    } catch (err: unknown) {
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.VPS_REGISTRATION_FAILED, {
        properties: {
          failure_code: customerVpsFailureCode(err),
          http_status: customerVpsFailureStatus(err),
          machine_id: machineId,
        },
      });
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

  app.post('/:machineId/resize', bodyLimit({ maxSize: VPS_BODY_LIMIT }), async (c) => {
    const authError = requirePlatformAuth(c);
    if (authError) return authError;
    const params = MachineIdParamSchema.safeParse({ machineId: c.req.param('machineId') });
    if (!params.success) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    try {
      const parsed = ResizeMachineRequestSchema.safeParse(await readJson(c));
      if (!parsed.success) {
        return c.json({ error: 'Invalid request' }, 400);
      }
      return c.json(await deps.service.resize({
        machineId: params.data.machineId,
        ...parsed.data,
      }), 200);
    } catch (err: unknown) {
      return jsonError(c, err, '/vps/:machineId/resize');
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
