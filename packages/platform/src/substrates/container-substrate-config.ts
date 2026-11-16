import { z } from 'zod/v4';
import { getUserMachine, type PlatformDB } from '../db.js';
import { buildPlatformContainerRuntimeToken } from '../platform-token.js';
import { createPgOwnerClusterAdmin } from './container-owner-cluster-admin.js';
import { createContainerOwnerDatabases, type ContainerOwnerDatabases, type OwnerClusterAdmin } from './container-owner-database.js';
import { createContainerLifecycleService, type ContainerLifecycleService } from './container-lifecycle-service.js';
import {
  createLambdaMicrovmsProvider,
  type LambdaMicrovmsApi,
  type LambdaMicrovmsProviderConfig,
} from './container-provider.js';
import { createContainerSubstrate } from './container-substrate.js';
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
  MATRIX_CONTAINER_OWNER_DB_SIZE_LIMIT_BYTES: z.coerce.number().int().positive().default(1024 ** 3),
  /** Platform origin the runtime calls for registration and lifecycle reports. */
  MATRIX_CONTAINER_PLATFORM_URL: z.string().regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/),
  PLATFORM_SECRET: z.string().min(32),
} as const;

const ConfigSchema = z.object(FIELDS);

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
  };
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
      },
      ownerDatabase: {
        adminUrl: c.MATRIX_CONTAINER_OWNER_DB_ADMIN_URL,
        runtimeHost: c.MATRIX_CONTAINER_OWNER_DB_RUNTIME_HOST,
        runtimePort: c.MATRIX_CONTAINER_OWNER_DB_RUNTIME_PORT,
        passwordSecret: c.MATRIX_CONTAINER_OWNER_DB_PASSWORD_SECRET,
        sizeLimitBytes: c.MATRIX_CONTAINER_OWNER_DB_SIZE_LIMIT_BYTES,
      },
    },
  };
}

export interface ConfiguredContainerSubstrate {
  substrate: OnDemandRuntimeSubstrate;
  platformSecret: string;
  lifecycle: ContainerLifecycleService;
  ownerDatabases: ContainerOwnerDatabases;
  shutdown(): Promise<void>;
}

export interface ConfiguredContainerSubstrateDeps {
  db: PlatformDB;
  env: NodeJS.ProcessEnv;
  /** Injected provider client for tests; otherwise the SDK client is built from configuration. */
  microvmsApi?: LambdaMicrovmsApi;
  createClient?: (options: { region: string }) => LambdaMicrovmsSender & { destroy(): void };
  ownerClusterAdmin?: OwnerClusterAdmin;
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
  });
  const provider = createLambdaMicrovmsProvider({ api: microvmsApi, config: config.provider });
  const lifecycle = createContainerLifecycleService({
    db: deps.db,
    provider,
    async buildBootPayload(context, signal) {
      const database = await ownerDatabases.ensure(context.clerkUserId, context.generation, signal);
      return JSON.stringify({
        version: 1,
        machineId: context.machineId,
        handle: context.handle,
        runtimeSlot: context.runtimeSlot,
        generation: context.generation,
        runtimeTokenEpoch: context.runtimeTokenEpoch,
        platform: {
          url: config.platform.url,
          runtimeToken: buildPlatformContainerRuntimeToken(
            { handle: context.handle, machineId: context.machineId, runtimeSlot: context.runtimeSlot },
            config.platform.secret, context.runtimeTokenEpoch),
        },
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
  const substrate = createContainerSubstrate({
    lifecycle,
    provider,
    endpointHostSuffix: config.provider.endpointHostSuffix,
    loadMachine: machineId => getUserMachine(deps.db, machineId),
  });
  return {
    substrate,
    platformSecret: config.platform.secret,
    lifecycle,
    ownerDatabases,
    async shutdown() {
      await lifecycle.shutdown();
      sdkClient?.destroy();
      await pgAdmin?.close();
    },
  };
}
