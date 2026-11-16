import { z } from 'zod/v4';
import { getUserMachine, type PlatformDB } from '../db.js';
import { buildContainerBootPayload } from './container-boot-payload.js';
import { createPgOwnerClusterAdmin } from './container-owner-cluster-admin.js';
import { createOwnerDatabaseSizeSweeper } from './container-database-size-sweep.js';
import { createOwnerDatabaseCompactor } from './container-owner-compaction.js';
import { loadContainerStorageLimits } from '../free-tier/config.js';
import { createStorageQuota, type StorageQuotaDeps } from '../free-tier/storage-quota.js';
import { createStorageQuotaSweeper } from '../free-tier/storage-quota-sweep.js';
import {
  createContainerOwnerDatabases,
  type ContainerOwnerDatabases,
  type OwnerClusterAdmin,
} from './container-owner-database.js';
import {
  CONTAINER_QUIESCE_TIMEOUT_MS,
  createContainerLifecycleService,
  type ContainerLifecycleService,
} from './container-lifecycle-service.js';
import {
  CONTAINER_SUSPENDED_DURATION_BOUNDS,
  CONTAINER_UNIT_MAX_IDLE_SECONDS,
  createLambdaMicrovmsProvider,
  type LambdaMicrovmsApi,
  type LambdaMicrovmsProviderConfig,
} from './container-provider.js';
import { createContainerRuntimeClient } from './container-runtime-client.js';
import { createContainerSubstrate } from './container-substrate.js';
import { createActivityTracker, createIdleReaper } from './idle-reaper.js';
import { createOrphanReconciler } from './orphan-reconciler.js';
import { createLambdaMicrovmsApi, createLambdaMicrovmsClient, type LambdaMicrovmsSender } from './lambda-microvms-client.js';
import type { OnDemandRuntimeSubstrate } from './types.js';

const list = z.string().transform(value => value.split(',').map(item => item.trim()).filter(Boolean))
  .pipe(z.array(z.string().min(1).max(512)).min(1).max(5));
const port = (fallback: number) => z.coerce.number().int().min(1).max(65_535).default(fallback);

const FIELDS = {
  MATRIX_CONTAINER_REGION: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  MATRIX_CONTAINER_IMAGE: z.string().min(1).max(512),
  MATRIX_CONTAINER_IMAGE_VERSION: z.string().min(1).max(64).optional(),
  MATRIX_CONTAINER_INGRESS_CONNECTORS: list,
  MATRIX_CONTAINER_EGRESS_CONNECTORS: list,
  MATRIX_CONTAINER_GATEWAY_PORT: port(4000),
  MATRIX_CONTAINER_ENDPOINT_TOKEN_MINUTES: z.coerce.number().int().min(10).max(60).default(30),
  MATRIX_CONTAINER_ENDPOINT_SUFFIX: z.string().regex(/^\.[a-z0-9.-]+$/).default('.on.aws'),
  MATRIX_CONTAINER_OWNER_DB_ADMIN_URL: z.string().regex(/^postgres(ql)?:\/\//),
  MATRIX_CONTAINER_OWNER_DB_RUNTIME_HOST: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
  MATRIX_CONTAINER_OWNER_DB_RUNTIME_PORT: port(5432),
  MATRIX_CONTAINER_OWNER_DB_PASSWORD_SECRET: z.string().min(32),
  MATRIX_CONTAINER_OWNER_DB_SIZE_LIMIT_BYTES: z.coerce.number().int().positive().default(500 * 1000 ** 2),
  MATRIX_CONTAINER_OWNER_DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(20).default(5),
  /** Connections the owner cluster can give container runtimes, below its own maximum with headroom. */
  MATRIX_CONTAINER_OWNER_DB_CONNECTION_BUDGET: z.coerce.number().int().min(1).max(100_000).default(400),
  /** Defaults to the connection budget divided by the per-owner connection limit. */
  MATRIX_CONTAINER_MAX_RUNNING: z.coerce.number().int().min(1).max(100_000).optional(),
  /** Platform origin the runtime calls for registration and lifecycle reports. */
  MATRIX_CONTAINER_PLATFORM_URL: z.string().regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/),
  PLATFORM_SECRET: z.string().min(32),
  MATRIX_CONTAINER_IDLE_STOP_MINUTES: z.coerce.number().int().min(1).max(240).default(10),
  /** A session plus its stop budget must end before the provider's idle maximum and unit lifetime. */
  MATRIX_CONTAINER_MAX_SESSION_MINUTES: z.coerce.number().int().min(10).default(240)
    .refine(minutes => minutes * 60_000 + CONTAINER_QUIESCE_TIMEOUT_MS < CONTAINER_UNIT_MAX_IDLE_SECONDS * 1000),
  MATRIX_CONTAINER_SUSPENDED_DURATION_SECONDS: z.coerce.number().int()
    .min(CONTAINER_SUSPENDED_DURATION_BOUNDS.min).max(CONTAINER_SUSPENDED_DURATION_BOUNDS.max)
    .default(CONTAINER_SUSPENDED_DURATION_BOUNDS.fallback),
} as const;

const ConfigSchema = z.object(FIELDS).superRefine((c, ctx) => {
  const running = c.MATRIX_CONTAINER_MAX_RUNNING;
  if (running !== undefined && running * c.MATRIX_CONTAINER_OWNER_DB_CONNECTION_LIMIT > c.MATRIX_CONTAINER_OWNER_DB_CONNECTION_BUDGET) {
    ctx.addIssue({ code: 'custom', path: ['MATRIX_CONTAINER_MAX_RUNNING'], message: 'exceeds connection budget' });
  }
  if (c.MATRIX_CONTAINER_OWNER_DB_CONNECTION_BUDGET < c.MATRIX_CONTAINER_OWNER_DB_CONNECTION_LIMIT) {
    ctx.addIssue({ code: 'custom', path: ['MATRIX_CONTAINER_OWNER_DB_CONNECTION_BUDGET'], message: 'below one runtime' });
  }
});

export interface ContainerSubstrateConfig {
  region: string;
  platform: { url: string; secret: string };
  provider: LambdaMicrovmsProviderConfig;
  ownerDatabase: {
    adminUrl: string;
    runtimeHost: string;
    runtimePort: number;
    passwordSecret: string;
    sizeLimitBytes: number;
    connectionLimit: number;
  };
  idle: { idleMs: number; maxSessionMs: number };
  /** Global ceiling on container runtimes holding compute. */
  maxRunning: number;
}

export type ContainerSubstrateConfigResult =
  | { ok: true; config: ContainerSubstrateConfig }
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'incomplete'; invalid: string[] };

/** Reports problems by setting name only, so no secret value reaches a log. */
export function loadContainerSubstrateConfig(env: NodeJS.ProcessEnv): ContainerSubstrateConfigResult {
  if (env.MATRIX_CONTAINER_SUBSTRATE_ENABLED !== 'true') return { ok: false, reason: 'disabled' };
  const raw = Object.fromEntries(Object.keys(FIELDS).map(key => [key, env[key] === '' ? undefined : env[key]]));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const invalid = [...new Set(parsed.error.issues.map(issue => String(issue.path[0])))].sort();
    return { ok: false, reason: 'incomplete', invalid };
  }
  const c = parsed.data;
  return {
    ok: true,
    config: {
      region: c.MATRIX_CONTAINER_REGION,
      platform: { url: c.MATRIX_CONTAINER_PLATFORM_URL, secret: c.PLATFORM_SECRET },
      provider: {
        imageIdentifier: c.MATRIX_CONTAINER_IMAGE,
        ...(c.MATRIX_CONTAINER_IMAGE_VERSION ? { imageVersion: c.MATRIX_CONTAINER_IMAGE_VERSION } : {}),
        ingressNetworkConnectors: c.MATRIX_CONTAINER_INGRESS_CONNECTORS,
        egressNetworkConnectors: c.MATRIX_CONTAINER_EGRESS_CONNECTORS,
        gatewayPort: c.MATRIX_CONTAINER_GATEWAY_PORT,
        endpointTokenMinutes: c.MATRIX_CONTAINER_ENDPOINT_TOKEN_MINUTES,
        endpointHostSuffix: c.MATRIX_CONTAINER_ENDPOINT_SUFFIX,
        suspendedDurationSeconds: c.MATRIX_CONTAINER_SUSPENDED_DURATION_SECONDS,
      },
      ownerDatabase: {
        adminUrl: c.MATRIX_CONTAINER_OWNER_DB_ADMIN_URL,
        runtimeHost: c.MATRIX_CONTAINER_OWNER_DB_RUNTIME_HOST,
        runtimePort: c.MATRIX_CONTAINER_OWNER_DB_RUNTIME_PORT,
        passwordSecret: c.MATRIX_CONTAINER_OWNER_DB_PASSWORD_SECRET,
        sizeLimitBytes: c.MATRIX_CONTAINER_OWNER_DB_SIZE_LIMIT_BYTES,
        connectionLimit: c.MATRIX_CONTAINER_OWNER_DB_CONNECTION_LIMIT,
      },
      idle: { idleMs: c.MATRIX_CONTAINER_IDLE_STOP_MINUTES * 60_000, maxSessionMs: c.MATRIX_CONTAINER_MAX_SESSION_MINUTES * 60_000 },
      maxRunning: c.MATRIX_CONTAINER_MAX_RUNNING
        ?? Math.floor(c.MATRIX_CONTAINER_OWNER_DB_CONNECTION_BUDGET / c.MATRIX_CONTAINER_OWNER_DB_CONNECTION_LIMIT),
    },
  };
}

export interface ConfiguredContainerSubstrate {
  substrate: OnDemandRuntimeSubstrate;
  platformSecret: string;
  lifecycle: ContainerLifecycleService;
  ownerDatabases: ContainerOwnerDatabases;
  /** Persists owner activity this replica observes; call on every replica that serves owner traffic. */
  startServing(): void;
  /** Starts the idle and orphan sweeps; call once the platform database is ready. */
  startBackgroundWork(): void;
  shutdown(): Promise<void>;
}

export interface ConfiguredContainerSubstrateDeps {
  db: PlatformDB;
  env: NodeJS.ProcessEnv;
  /** Injected provider client for tests; otherwise the SDK client is built from configuration. */
  microvmsApi?: LambdaMicrovmsApi;
  createClient?: (options: { region: string }) => LambdaMicrovmsSender & { destroy(): void };
  ownerClusterAdmin?: OwnerClusterAdmin;
  /** The sync object store; when present, expired pending storage writes are swept too. */
  objectStore?: Pick<StorageQuotaDeps, 'headObject'>;
  log?: (message: string) => void;
}

/** Builds the container substrate only when every setting is present. */
export function createConfiguredContainerSubstrate(deps: ConfiguredContainerSubstrateDeps): ConfiguredContainerSubstrate | null {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const loaded = loadContainerSubstrateConfig(deps.env);
  if (!loaded.ok) {
    if (loaded.reason === 'incomplete') {
      log(`[platform] container substrate not registered; invalid settings: ${loaded.invalid.join(', ')}`);
    }
    return null;
  }
  const { config } = loaded;
  const sdkClient = deps.microvmsApi ? null : (deps.createClient ?? createLambdaMicrovmsClient)({ region: config.region });
  const microvmsApi = deps.microvmsApi ?? createLambdaMicrovmsApi(sdkClient!);
  const pgAdmin = deps.ownerClusterAdmin ? null : createPgOwnerClusterAdmin({ connectionString: config.ownerDatabase.adminUrl });
  const ownerDatabases = createContainerOwnerDatabases({
    db: deps.db,
    admin: deps.ownerClusterAdmin ?? pgAdmin!,
    passwordSecret: config.ownerDatabase.passwordSecret,
    sizeLimitBytes: config.ownerDatabase.sizeLimitBytes,
    connectionLimit: config.ownerDatabase.connectionLimit,
  });
  // Compaction needs maintenance sessions, which only the real cluster admin provides.
  const compactor = pgAdmin ? createOwnerDatabaseCompactor({ admin: pgAdmin, ownerDatabases }) : undefined;
  const sizeSweeper = createOwnerDatabaseSizeSweeper({ db: deps.db, ownerDatabases, ...(compactor ? { compactor } : {}) });
  const objectStore = deps.objectStore;
  const quotaSweeper = objectStore ? createStorageQuotaSweeper({
    db: deps.db,
    quota: createStorageQuota({
      db: deps.db, limits: loadContainerStorageLimits(deps.env, log), headObject: (key, options) => objectStore.headObject(key, options),
    }),
  }) : null;
  const provider = createLambdaMicrovmsProvider({ api: microvmsApi, config: config.provider });
  const runtime = createContainerRuntimeClient({
    provider, platformSecret: config.platform.secret, endpointHostSuffix: config.provider.endpointHostSuffix,
  });
  const lifecycle = createContainerLifecycleService({
    db: deps.db,
    provider,
    // A resumed unit gets a whole new session, so it must outlive that session and its stop.
    minResumeLifetimeMs: config.idle.maxSessionMs + CONTAINER_QUIESCE_TIMEOUT_MS,
    maxRunning: config.maxRunning,
    reviveInPlace: (target, signal) => runtime.resume(target, signal),
    async buildBootPayload(context, signal) {
      const database = await ownerDatabases.ensure(context.clerkUserId, context.generation, signal);
      return buildContainerBootPayload({
        context,
        platform: config.platform,
        database: {
          host: config.ownerDatabase.runtimeHost,
          port: config.ownerDatabase.runtimePort,
          name: database.databaseName,
          user: database.roleName,
          password: database.password,
        },
      });
    },
  });
  const activity = createActivityTracker({ db: deps.db });
  const reaper = createIdleReaper({ db: deps.db, lifecycle, runtime, activity, config: config.idle });
  const reconciler = createOrphanReconciler({ db: deps.db, provider });
  const substrate = createContainerSubstrate({
    lifecycle,
    provider,
    activity,
    endpointHostSuffix: config.provider.endpointHostSuffix,
    loadMachine: machineId => getUserMachine(deps.db, machineId),
  });
  return {
    substrate,
    platformSecret: config.platform.secret,
    lifecycle,
    ownerDatabases,
    startServing() {
      activity.startPeriodicFlush();
    },
    startBackgroundWork() {
      reaper.start();
      reconciler.start();
      sizeSweeper.start();
      quotaSweeper?.start();
    },
    async shutdown() {
      activity.stopPeriodicFlush();
      await quotaSweeper?.shutdown();
      await sizeSweeper.shutdown();
      await reconciler.shutdown();
      await reaper.shutdown();
      await lifecycle.shutdown();
      sdkClient?.destroy();
      await pgAdmin?.close();
    },
  };
}
