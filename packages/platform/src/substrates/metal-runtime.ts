import type { CustomerVpsConfig } from '../customer-vps-config.js';
import type { PlatformDB } from '../db.js';
import { appOrigin } from '../origins.js';
import { createHostdClient, createHostdDispatcher } from './hostd-client.js';
import { loadMetalSubstrateConfig } from './metal-config.js';
import { createMetalHostsRepository } from './metal-hosts-repository.js';
import { createMetalProvisioner, type MetalProvisioner } from './metal-provisioner.js';
import { createMetalVmDeletionDrainer } from './metal-vm-deletions.js';
import { createLifecycleReader } from './metal-lifecycle-reader.js';
import { createMetalSleeper, startMetalSleeperWorker, type MetalSleeperWorker } from './metal-sleeper.js';
import { METAL_MAINTENANCE_LOCK_KEY, METAL_SCHEDULED_WAKE_LOCK_KEY, METAL_SLEEPER_LOCK_KEY, runAsSingleton } from './metal-singleton.js';
import { PLATFORM_FEATURE_FLAGS, type ServerFeatureFlags } from '../feature-flags/server-flags.js';
import { createFreeTierSleepSwitch } from '../free-tier/switches.js';
import type { SubstrateRegistry } from './registry.js';
import type { OnDemandRuntimeSubstrate } from './types.js';

/**
 * Startup composition for metal provisioning (spec 2691, ENG-520): the
 * provisioner the free plan uses, plus the maintenance pass that fails stale
 * provisioning rows (`reconcileStale`) and drains queued VM teardowns
 * (`drainOnce`). Without the pass, a failed create would queue a teardown that
 * never runs. Metal is composed only when it is enabled and fully configured.
 */

export const METAL_MAINTENANCE_INTERVAL_MS = 60_000;
const MIN_PLATFORM_SECRET_LENGTH = 32;

/**
 * The idle sleeper (spec 2691, Task P6) is installed only when
 * `MATRIX_FREE_TIER_SLEEP_ENABLED` is `1` or `true`. That is the capability
 * gate; the `free-tier-sleep` PostHog flag (ENG-608) then switches suspends on
 * and off at runtime, while scheduled wakes keep running.
 */
export function isFreeTierSleepEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.MATRIX_FREE_TIER_SLEEP_ENABLED?.trim().toLowerCase();
  return flag === '1' || flag === 'true';
}

type Log = (event: string, fields: Record<string, unknown>) => void;
const defaultLog: Log = (event, fields) => console.error(`[metal-runtime] ${event}`, JSON.stringify(fields));

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

export interface MetalMaintenanceWorker {
  stop(): void;
  /** Resolves when the pass in flight (if any) settles. */
  drain(): Promise<void>;
}

/**
 * Runs `reconcileStale` then `drainOnce` now and every `intervalMs`. A tick
 * while a pass is still running is skipped (single flight). Each step logs a
 * failure by error name and the next step and tick still run.
 */
export function startMetalMaintenanceWorker(input: {
  reconcileStale: () => Promise<unknown>;
  drainOnce: () => Promise<unknown>;
  intervalMs?: number;
  /**
   * Runs a pass only while holding a cluster-wide lock, so two worker
   * instances (a deploy overlap) never run the same pass; resolves without
   * running it when another instance holds the lock.
   */
  singleton?: (run: () => Promise<void>) => Promise<unknown>;
  log?: Log;
}): MetalMaintenanceWorker {
  const log = input.log ?? defaultLog;
  let running: Promise<void> | undefined;
  let stopped = false;

  async function step(name: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error: unknown) {
      log('maintenance_step_failed', { step: name, code: errorCode(error) });
    }
  }

  const tick = (): void => {
    if (stopped || running) return;
    const run = async () => {
      await step('reconcile_stale', input.reconcileStale);
      if (!stopped) await step('drain_deletions', input.drainOnce);
    };
    const pass = (async () => {
      if (!input.singleton) return run();
      try {
        await input.singleton(run);
      } catch (error: unknown) {
        log('maintenance_lock_failed', { code: errorCode(error) });
      }
    })().finally(() => {
      if (running === pass) running = undefined;
    });
    running = pass;
  };

  tick();
  const interval = setInterval(tick, input.intervalMs ?? METAL_MAINTENANCE_INTERVAL_MS);
  interval.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
    drain() {
      return running ?? Promise.resolve();
    },
  };
}

export interface MetalRuntime {
  provisioner: MetalProvisioner;
  /** Stops scheduling maintenance passes (synchronous; call first on shutdown). */
  stop(): void;
  /** Stops the maintenance pass, waits for the one in flight, and closes hostd connections. */
  shutdown(): Promise<void>;
}

export function createConfiguredMetalRuntime(input: {
  db: PlatformDB;
  env: NodeJS.ProcessEnv;
  customerVps: { config: CustomerVpsConfig; cloudInitTemplate?: string } | undefined;
  backgroundWorkersEnabled: boolean;
  /** The platform substrate registry; the idle sleeper suspends and wakes through its metal substrate. */
  substrates?: SubstrateRegistry;
  /** Signs the platform runtime credential the sleeper reads the gateway lifecycle with. */
  platformSecret?: string;
  /** Server-side PostHog flags (ENG-608) for the `free-tier-sleep` switch; absent keeps env behavior. */
  flags?: ServerFeatureFlags;
  log?: Log;
}): MetalRuntime | undefined {
  const log = input.log ?? defaultLog;
  const metal = loadMetalSubstrateConfig(input.env);
  if (!metal.enabled) return undefined;
  if (!input.customerVps) {
    // Metal guests render host config from the customer VPS settings (bundle channel, registration URL).
    log('metal_provisioning_unconfigured', { missing: 'customer_vps_config' });
    return undefined;
  }
  const cloudInitTemplate = input.customerVps.cloudInitTemplate;
  if (!cloudInitTemplate?.trim()) {
    // Only the real template restores the owner home and starts registration on a golden clone.
    log('metal_provisioning_unconfigured', { missing: 'cloud_init_template' });
    return undefined;
  }
  const dispatcher = createHostdDispatcher(metal.caPem);
  const hosts = createMetalHostsRepository(input.db.kysely);
  const clientFor = (host: Parameters<typeof createHostdClient>[0]) => createHostdClient(host, metal.apiToken, { dispatcher });
  const drainer = createMetalVmDeletionDrainer({ db: input.db, hosts, clientFor });
  const provisioner = createMetalProvisioner({
    db: input.db,
    hosts,
    clientFor,
    goldenVersion: metal.goldenVersion,
    ...(metal.poolMaxDataPercent !== undefined ? { poolMaxDataPercent: metal.poolMaxDataPercent } : {}),
    ...(metal.poolMaxMetadataPercent !== undefined ? { poolMaxMetadataPercent: metal.poolMaxMetadataPercent } : {}),
    config: input.customerVps.config,
    publicAppOrigin: appOrigin(input.env),
    drainMachineDeletions: (machineId, signal) => drainer.drainMachine(machineId, signal),
    cloudInitTemplate,
  });
  const worker = input.backgroundWorkersEnabled
    ? startMetalMaintenanceWorker({
      reconcileStale: () => provisioner.reconcileStale(),
      drainOnce: () => drainer.drainOnce(),
      singleton: (run) => runAsSingleton(input.db, METAL_MAINTENANCE_LOCK_KEY, run),
      log,
    })
    : undefined;
  const sleeper = input.backgroundWorkersEnabled && isFreeTierSleepEnabled(input.env)
    ? startConfiguredSleeper(input.db, input.substrates, input.platformSecret, log, input.flags)
    : undefined;
  let closing: Promise<void> | undefined;
  return {
    provisioner,
    stop() {
      worker?.stop();
      sleeper?.stop();
    },
    shutdown() {
      return closing ??= (async () => {
        worker?.stop();
        sleeper?.stop();
        await Promise.all([worker?.drain(), sleeper?.drain(), provisioner.drain()]);
        await dispatcher.close();
      })();
    },
  };
}

function startConfiguredSleeper(
  db: PlatformDB,
  substrates: SubstrateRegistry | undefined,
  platformSecret: string | undefined,
  log: Log,
  flags: ServerFeatureFlags | undefined,
): MetalSleeperWorker | undefined {
  const lookup = substrates?.get('metal');
  const metal = lookup?.ok ? lookup.substrate : undefined;
  if (!substrates || !metal || !metal.startsOnDemand || !('stop' in metal) || !('isSuspended' in metal)) {
    log('metal_sleeper_unconfigured', { missing: 'metal_substrate' });
    return undefined;
  }
  if (!platformSecret || platformSecret.length < MIN_PLATFORM_SECRET_LENGTH) {
    log('metal_sleeper_unconfigured', { missing: 'platform_secret' });
    return undefined;
  }
  const sleeper = createMetalSleeper({
    db,
    substrate: metal as OnDemandRuntimeSubstrate,
    readLifecycle: createLifecycleReader({ substrates, platformSecret }),
    sleepAllowed: createFreeTierSleepSwitch(flags),
  });
  const worker = startMetalSleeperWorker({
    sleeper: { tick: sleeper.sleepTick },
    singleton: (run) => runAsSingleton(db, METAL_SLEEPER_LOCK_KEY, run),
    scheduledWake: { tick: sleeper.wakeTick, singleton: (run) => runAsSingleton(db, METAL_SCHEDULED_WAKE_LOCK_KEY, run) },
  });
  return connectSleepFlag(flags, worker);
}

/**
 * Runs a sleep pass as soon as new definitions change `free-tier-sleep`, so a
 * flag turned on takes effect within one poll plus the pass in flight instead
 * of waiting for the next 60 s interval. Unchanged polls trigger nothing.
 */
export function connectSleepFlag(flags: ServerFeatureFlags | undefined, worker: MetalSleeperWorker): MetalSleeperWorker {
  const unsubscribe = flags?.onFlagChange(PLATFORM_FEATURE_FLAGS.freeTierSleep, () => worker.requestSleepPass());
  return {
    stop() {
      unsubscribe?.();
      worker.stop();
    },
    drain: () => worker.drain(),
    requestSleepPass: () => worker.requestSleepPass(),
  };
}
