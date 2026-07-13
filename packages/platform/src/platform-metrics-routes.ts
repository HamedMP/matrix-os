import { Hono } from 'hono';

import {
  getHostBundleReleaseByChannel,
  listAllUserMachines,
  listContainers,
  type PlatformDB,
  type UserMachineRecord,
} from './db.js';
import type { VpsRuntimeMetricInput } from './metrics.js';

const VPS_RUNTIME_METRICS_TTL_MS = 45_000;

type RuntimeMetricMachine = {
  machineId: string;
  handle: string;
  status: string;
  publicIPv4: string | null;
  imageVersion: string | null;
};

type CachedVpsRuntimeMetrics = {
  machineKey: string;
  expiresAt: number;
  values: VpsRuntimeMetricInput[];
};

export function createPlatformMetricsRoutes(opts: {
  db: PlatformDB;
  customerVpsEnabled: boolean;
  probeRuntime: (machine: UserMachineRecord) => Promise<Omit<VpsRuntimeMetricInput, 'handle'>>;
  logRouteError: (route: string, err: unknown) => void;
}) {
  const routes = new Hono();
  let cachedVpsRuntimeMetrics: CachedVpsRuntimeMetrics | null = null;
  let pendingVpsRuntimeMetrics: {
    machineKey: string;
    promise: Promise<CachedVpsRuntimeMetrics>;
  } | null = null;

  function getVpsRuntimeMetricsCacheKey(machines: RuntimeMetricMachine[]): string {
    return machines
      .map((machine) => [
        machine.machineId,
        machine.handle,
        machine.status,
        machine.publicIPv4 ?? '',
        machine.imageVersion ?? '',
      ].join(':'))
      .sort()
      .join('|');
  }

  function recordRuntimeMetrics(
    machines: Array<VpsRuntimeMetricInput & RuntimeMetricMachine>,
  ): void {
    cachedVpsRuntimeMetrics = {
      machineKey: getVpsRuntimeMetricsCacheKey(machines),
      expiresAt: Date.now() + VPS_RUNTIME_METRICS_TTL_MS,
      values: machines,
    };
  }

  async function getCachedVpsRuntimeMetrics(
    machines: UserMachineRecord[],
  ): Promise<VpsRuntimeMetricInput[]> {
    const now = Date.now();
    const machineKey = getVpsRuntimeMetricsCacheKey(machines);
    if (
      cachedVpsRuntimeMetrics
      && cachedVpsRuntimeMetrics.machineKey === machineKey
      && cachedVpsRuntimeMetrics.expiresAt > now
    ) {
      return cachedVpsRuntimeMetrics.values;
    }
    if (pendingVpsRuntimeMetrics?.machineKey === machineKey) {
      return (await pendingVpsRuntimeMetrics.promise).values;
    }
    const probeStartedAt = Date.now();
    const promise = Promise.allSettled(
      machines.map(async (machine): Promise<VpsRuntimeMetricInput> => ({
        handle: machine.handle,
        ...(machine.status === 'running'
          ? await opts.probeRuntime(machine)
          : { healthy: false }),
      })),
    ).then((probed) => {
      const values = probed
        .filter((result): result is PromiseFulfilledResult<VpsRuntimeMetricInput> => result.status === 'fulfilled')
        .map((result) => result.value);
      const updated = {
        machineKey,
        expiresAt: probeStartedAt + VPS_RUNTIME_METRICS_TTL_MS,
        values,
      };
      if (
        !cachedVpsRuntimeMetrics
        || (
          cachedVpsRuntimeMetrics.machineKey === machineKey
          && cachedVpsRuntimeMetrics.expiresAt < updated.expiresAt
        )
      ) {
        cachedVpsRuntimeMetrics = updated;
      }
      return cachedVpsRuntimeMetrics.machineKey === machineKey ? cachedVpsRuntimeMetrics : updated;
    }).catch((err: unknown): CachedVpsRuntimeMetrics => {
      opts.logRouteError('/metrics vps runtime cache', err);
      if (cachedVpsRuntimeMetrics?.machineKey === machineKey) {
        return cachedVpsRuntimeMetrics;
      }
      return { machineKey, expiresAt: 0, values: [] };
    }).finally(() => {
      if (pendingVpsRuntimeMetrics?.machineKey === machineKey) {
        pendingVpsRuntimeMetrics = null;
      }
    });
    pendingVpsRuntimeMetrics = { machineKey, promise };
    return (await promise).values;
  }

  routes.get('/metrics', async (c) => {
    const {
      metricsRegistry,
      refreshPlatformUserMetrics,
      refreshReleaseChannelMetrics,
      refreshVpsMetrics,
      refreshVpsRuntimeMetrics,
    } = await import('./metrics.js');
    try {
      const machines = await listAllUserMachines(opts.db, 500);
      const containers = await listContainers(opts.db);
      refreshVpsMetrics(machines);
      refreshPlatformUserMetrics({ machines, containers });
      const releaseChannels = await Promise.all(
        ['dev', 'beta', 'canary', 'stable'].map(async (channel) => {
          const release = await getHostBundleReleaseByChannel(opts.db, channel);
          return release ? { ...release, channel } : null;
        }),
      );
      refreshReleaseChannelMetrics(
        releaseChannels.filter((release): release is NonNullable<typeof release> => release !== null),
      );
      if (opts.customerVpsEnabled) {
        refreshVpsRuntimeMetrics(await getCachedVpsRuntimeMetrics(machines));
      }
    } catch (err: unknown) {
      opts.logRouteError('/metrics vps refresh', err);
    }
    const metrics = await metricsRegistry.metrics();
    return c.text(metrics, 200, {
      'Content-Type': metricsRegistry.contentType,
    });
  });

  return { routes, recordRuntimeMetrics };
}
