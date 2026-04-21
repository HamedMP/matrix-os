import { createHmac } from 'node:crypto';
import type Dockerode from 'dockerode';
import pg from 'pg';
import {
  type PlatformDB,
  type ContainerRecord,
  allocatePort,
  releasePort,
  insertContainer,
  getContainer,
  updateContainerStatus,
  listContainers,
  deleteContainer,
  runInPlatformTransaction,
} from './db.js';
import { provisionDuration } from './metrics.js';

const POSTGRES_CONNECT_TIMEOUT_MS = 10_000;

export interface OrchestratorConfig {
  db: PlatformDB;
  docker: Dockerode;
  image?: string;
  network?: string;
  baseGatewayPort?: number;
  baseShellPort?: number;
  proxyUrl?: string;
  memoryLimit?: number;
  cpuQuota?: number;
  dataDir?: string;
  platformSecret?: string;
  extraEnv?: string[];
  postgresUrl?: string;
}

export interface RollingRestartResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: string[];
  results: { handle: string; status: 'upgraded' | 'failed'; error?: string }[];
  durationMs: number;
}

export interface Orchestrator {
  provision(handle: string, clerkUserId: string, displayName?: string): Promise<ContainerRecord>;
  start(handle: string): Promise<void>;
  stop(handle: string): Promise<void>;
  destroy(handle: string): Promise<void>;
  upgrade(handle: string): Promise<ContainerRecord>;
  rollingRestart(): Promise<RollingRestartResult>;
  getInfo(handle: string): ContainerRecord | undefined;
  getImage(): string;
  listAll(status?: string): ContainerRecord[];
  syncStates(): Promise<void>;
}

export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  const {
    db,
    docker,
    image = 'ghcr.io/hamedmp/matrix-os:latest',
    network = 'matrixos-net',
    baseGatewayPort = 4001,
    baseShellPort = 3001,
    proxyUrl = 'http://proxy:8080',
    memoryLimit = 1024 * 1024 * 1024,
    cpuQuota = 50000,
    dataDir = '/data/users',
    platformSecret = '',
    extraEnv = [],
    postgresUrl,
  } = config;

  function dbNameForHandle(handle: string): string {
    return `matrixos_${handle.replace(/[^a-z0-9_]/g, '_')}`;
  }

  function assertSafeDbIdentifier(dbName: string): void {
    if (!/^[a-z0-9_]+$/.test(dbName)) {
      throw new Error(`Unsafe database identifier: ${dbName}`);
    }
  }

  function databaseUrlForHandle(handle: string): string | undefined {
    if (!postgresUrl) return undefined;
    return `${postgresUrl}/${dbNameForHandle(handle)}`;
  }

  async function createUserDatabase(handle: string): Promise<void> {
    if (!postgresUrl) return;
    const dbName = dbNameForHandle(handle);
    assertSafeDbIdentifier(dbName);
    const client = new pg.Client({
      connectionString: `${postgresUrl}/matrixos`,
      connectionTimeoutMillis: POSTGRES_CONNECT_TIMEOUT_MS,
    });
    try {
      await client.connect();
      const exists = await client.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName],
      );
      if (exists.rows.length === 0) {
        await client.query(`CREATE DATABASE "${dbName}"`);
        console.log(`[pg] Created database ${dbName}`);
      }
    } finally {
      await client.end();
    }
  }

  async function dropUserDatabase(handle: string): Promise<void> {
    if (!postgresUrl) return;
    const dbName = dbNameForHandle(handle);
    assertSafeDbIdentifier(dbName);
    const client = new pg.Client({
      connectionString: `${postgresUrl}/matrixos`,
      connectionTimeoutMillis: POSTGRES_CONNECT_TIMEOUT_MS,
    });
    try {
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      console.log(`[pg] Dropped database ${dbName}`);
    } finally {
      await client.end();
    }
  }

  async function ensureNetwork(): Promise<void> {
    const networks = await docker.listNetworks({ filters: { name: [network] } });
    if (networks.length === 0) {
      await docker.createNetwork({ Name: network, Driver: 'bridge' });
    }
  }

  // docker.pull() used to be called unconditionally before every upgrade.
  // That's fine when `image` is a registry ref like `ghcr.io/owner/repo:tag`
  // and the registry holds the current version -- but in practice we often
  // need to run a locally-built image (tagged via `docker build -t ...`)
  // while the registry still holds an older version. In that case, the
  // unconditional pull *reverts* our local tag to the stale registry image
  // and every upgrade silently deploys old code.
  //
  // The fix: only pull when `image` looks like a remote ref (has a registry
  // hostname) AND swallow "manifest unknown" / network errors so that a
  // local-only tag (e.g. `matrixos-user:local`) keeps working. Set
  // `PLATFORM_IMAGE=matrixos-user:local` in the platform container's env
  // and `docker tag <new-image> matrixos-user:local` before rolling restart.
  async function pullImageIfRemote(ref: string): Promise<void> {
    const looksRemote = /^[^/]+\.[^/]+\//.test(ref); // has a `host.tld/` prefix
    if (!looksRemote) return;
    try {
      await docker.pull(ref);
    } catch (err) {
      console.warn(
        `[orchestrator] docker.pull(${ref}) failed, using local tag:`,
        (err as Error).message,
      );
    }
  }

  async function safeStopAndRemoveContainer(
    container: { stop: () => Promise<unknown>; remove: (opts: { force: true }) => Promise<unknown> },
    handle: string,
  ): Promise<void> {
    try {
      await container.stop();
    } catch (err) {
      console.warn(
        `[orchestrator] Failed to stop container for ${handle}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      await container.remove({ force: true });
    } catch (err) {
      console.warn(
        `[orchestrator] Failed to remove container for ${handle}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function buildEnv(handle: string, displayName?: string, clerkUserId?: string): string[] {
    const containerName = `matrixos-${handle}`;
    const env = [
      `MATRIX_HANDLE=${handle}`,
      `MATRIX_DISPLAY_NAME=${displayName || handle}`,
      `MATRIX_IMAGE=${image}`,
      `PROXY_URL=${proxyUrl}`,
      `ANTHROPIC_BASE_URL=${proxyUrl}`,
      `ANTHROPIC_API_KEY=sk-proxy-${handle}`,
      `GATEWAY_EXTERNAL_URL=http://${containerName}:4000`,
      `PORT=4000`,
      `SHELL_PORT=3000`,
      ...extraEnv,
    ];
    // MATRIX_USER_ID is the immutable Clerk userId; gateway + home-mirror
    // key R2 prefixes off it so renaming the handle never orphans files.
    // Only emit when we have it; buildEnv is also called from upgrade /
    // rollingRestart paths where the DB record supplies it.
    if (clerkUserId) {
      env.push(`MATRIX_USER_ID=${clerkUserId}`);
    }
    const dbUrl = databaseUrlForHandle(handle);
    if (dbUrl) {
      env.push(`DATABASE_URL=${dbUrl}`);
    }
    if (platformSecret) {
      const token = createHmac('sha256', platformSecret).update(handle).digest('hex');
      env.push(`UPGRADE_TOKEN=${token}`);
      // The platform terminates sync JWTs on the single-domain app entrypoint
      // and re-proxies to the container with this HMAC bearer. Containers do
      // not need PLATFORM_JWT_SECRET unless we intentionally enable direct
      // JWT validation in the gateway.
      env.push(`MATRIX_AUTH_TOKEN=${token}`);
      env.push(`PLATFORM_INTERNAL_URL=http://distro-platform-1:9000`);
    }
    return env;
  }

  return {
    async provision(handle, clerkUserId, displayName) {
      const existing = getContainer(db, handle);
      if (existing) throw new Error(`Container already exists for handle: ${handle}`);

      const end = provisionDuration.startTimer();

      await ensureNetwork();
      await createUserDatabase(handle);

      const { gatewayPort, shellPort } = runInPlatformTransaction(db, () => {
        const nextGatewayPort = allocatePort(db, baseGatewayPort, `${handle}-gw`);
        const nextShellPort = allocatePort(db, baseShellPort, `${handle}-sh`);
        insertContainer(db, {
          handle,
          clerkUserId,
          containerId: null,
          port: nextGatewayPort,
          shellPort: nextShellPort,
          status: 'provisioning',
        });
        return {
          gatewayPort: nextGatewayPort,
          shellPort: nextShellPort,
        };
      });

      const containerName = `matrixos-${handle}`;
      let container: Dockerode.Container | null = null;
      try {
        container = await docker.createContainer({
          Image: image,
          name: containerName,
          Env: buildEnv(handle, displayName, clerkUserId),
          HostConfig: {
            Memory: memoryLimit,
            CpuQuota: cpuQuota,
            PortBindings: {
              '4000/tcp': [{ HostPort: String(gatewayPort) }],
              '3000/tcp': [{ HostPort: String(shellPort) }],
            },
            Binds: [`${dataDir}/${handle}/matrixos:/home/matrixos/home`],
            NetworkMode: network,
            RestartPolicy: { Name: 'unless-stopped' },
            Init: true,
          },
          ExposedPorts: {
            '4000/tcp': {},
            '3000/tcp': {},
          },
        });

        await container.start();

        updateContainerStatus(db, handle, 'running', container.id);
      } catch (err) {
        runInPlatformTransaction(db, () => {
          releasePort(db, `${handle}-gw`);
          releasePort(db, `${handle}-sh`);
          deleteContainer(db, handle);
        });
        if (container) {
          await safeStopAndRemoveContainer(container, handle);
        }
        throw err;
      }

      end();

      return getContainer(db, handle)!;
    },

    async start(handle) {
      const record = getContainer(db, handle);
      if (!record) throw new Error(`No container for handle: ${handle}`);
      if (record.status === 'running') return;

      if (record.containerId) {
        const container = docker.getContainer(record.containerId);
        await container.start();
      }
      updateContainerStatus(db, handle, 'running');
    },

    async stop(handle) {
      const record = getContainer(db, handle);
      if (!record) throw new Error(`No container for handle: ${handle}`);
      if (record.status === 'stopped') return;

      if (record.containerId) {
        const container = docker.getContainer(record.containerId);
        await container.stop();
      }
      updateContainerStatus(db, handle, 'stopped');
    },

    async destroy(handle) {
      const record = getContainer(db, handle);
      if (!record) throw new Error(`No container for handle: ${handle}`);

      if (record.containerId) {
        const container = docker.getContainer(record.containerId);
        await safeStopAndRemoveContainer(container, handle);
      }

      runInPlatformTransaction(db, () => {
        releasePort(db, `${handle}-gw`);
        releasePort(db, `${handle}-sh`);
        deleteContainer(db, handle);
      });
      await dropUserDatabase(handle);
    },

    async upgrade(handle) {
      const record = getContainer(db, handle);
      if (!record) throw new Error(`No container for handle: ${handle}`);
      // Silent-failure #12: buildEnv silently drops MATRIX_USER_ID when
      // clerkUserId is falsy, so the re-provisioned container would boot
      // with a handle-prefixed R2 key and split the bucket. Refuse early
      // with a clear operator message before touching Docker.
      if (typeof record.clerkUserId !== 'string' || record.clerkUserId.length === 0) {
        throw new Error(
          `No clerkUserId in container record for handle '${handle}'. Cannot safely provision — run \`orch destroy\` and re-provision with a Clerk userId.`,
        );
      }

      if (record.containerId) {
        const old = docker.getContainer(record.containerId);
        await safeStopAndRemoveContainer(old, handle);
      }

      await pullImageIfRemote(image);
      await ensureNetwork();
      await createUserDatabase(handle);

      const containerName = `matrixos-${handle}`;
      const container = await docker.createContainer({
        Image: image,
        name: containerName,
        Env: buildEnv(handle, undefined, record.clerkUserId),
        HostConfig: {
          Memory: memoryLimit,
          CpuQuota: cpuQuota,
          PortBindings: {
            '4000/tcp': [{ HostPort: String(record.port) }],
            '3000/tcp': [{ HostPort: String(record.shellPort) }],
          },
          Binds: [`${dataDir}/${handle}/matrixos:/home/matrixos/home`],
          NetworkMode: network,
          RestartPolicy: { Name: 'unless-stopped' },
          Init: true,
        },
        ExposedPorts: {
          '4000/tcp': {},
          '3000/tcp': {},
        },
      });

      await container.start();
      updateContainerStatus(db, handle, 'running', container.id);

      return getContainer(db, handle)!;
    },

    async rollingRestart() {
      const start = Date.now();
      const all = listContainers(db);
      const running = all.filter((r) => r.status === 'running');
      const stopped = all.filter((r) => r.status !== 'running');

      if (running.length === 0) {
        return {
          total: 0,
          succeeded: 0,
          failed: 0,
          skipped: stopped.map((r) => r.handle),
          results: [],
          durationMs: Date.now() - start,
        };
      }

      await pullImageIfRemote(image);

      const results: RollingRestartResult['results'] = [];
      for (const record of running) {
        try {
          // Silent-failure #12: same reason as upgrade() above -- refuse to
          // recreate a container whose DB row has no clerkUserId, since the
          // new container would boot with a handle-prefixed R2 key.
          if (typeof record.clerkUserId !== 'string' || record.clerkUserId.length === 0) {
            throw new Error(
              `No clerkUserId in container record for handle '${record.handle}'. Cannot safely provision — run \`orch destroy\` and re-provision with a Clerk userId.`,
            );
          }
          await createUserDatabase(record.handle);

          if (record.containerId) {
            const old = docker.getContainer(record.containerId);
            await safeStopAndRemoveContainer(old, record.handle);
          }

          const containerName = `matrixos-${record.handle}`;
          const container = await docker.createContainer({
            Image: image,
            name: containerName,
            Env: buildEnv(record.handle, undefined, record.clerkUserId),
            HostConfig: {
              Memory: memoryLimit,
              CpuQuota: cpuQuota,
              PortBindings: {
                '4000/tcp': [{ HostPort: String(record.port) }],
                '3000/tcp': [{ HostPort: String(record.shellPort) }],
              },
              Binds: [`${dataDir}/${record.handle}/matrixos:/home/matrixos/home`],
              NetworkMode: network,
              RestartPolicy: { Name: 'unless-stopped' },
              Init: true,
            },
            ExposedPorts: {
              '4000/tcp': {},
              '3000/tcp': {},
            },
          });

          await container.start();
          updateContainerStatus(db, record.handle, 'running', container.id);
          results.push({ handle: record.handle, status: 'upgraded' });
        } catch (e) {
          results.push({
            handle: record.handle,
            status: 'failed',
            error: (e as Error).message,
          });
        }
      }

      return {
        total: running.length,
        succeeded: results.filter((r) => r.status === 'upgraded').length,
        failed: results.filter((r) => r.status === 'failed').length,
        skipped: stopped.map((r) => r.handle),
        results,
        durationMs: Date.now() - start,
      };
    },

    getInfo(handle) {
      return getContainer(db, handle);
    },

    getImage() {
      return image;
    },

    listAll(status?) {
      return listContainers(db, status);
    },

    async syncStates() {
      const records = listContainers(db);
      for (const record of records) {
        if (!record.containerId) continue;
        try {
          const info = await docker.getContainer(record.containerId).inspect();
          const actual = info.State?.Running ? 'running' : 'stopped';
          if (actual !== record.status) {
            updateContainerStatus(db, record.handle, actual);
          }
        } catch (err) {
          console.warn(
            `[orchestrator] Failed to inspect container ${record.handle}:`,
            err instanceof Error ? err.message : String(err),
          );
          if (record.status !== 'stopped') {
            updateContainerStatus(db, record.handle, 'stopped');
          }
        }
      }
    },
  };
}
