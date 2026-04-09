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
} from './db.js';
import { provisionDuration } from './metrics.js';

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

  function databaseUrlForHandle(handle: string): string | undefined {
    if (!postgresUrl) return undefined;
    return `${postgresUrl}/${dbNameForHandle(handle)}`;
  }

  async function createUserDatabase(handle: string): Promise<void> {
    if (!postgresUrl) return;
    const dbName = dbNameForHandle(handle);
    const client = new pg.Client({ connectionString: `${postgresUrl}/matrixos` });
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
    const client = new pg.Client({ connectionString: `${postgresUrl}/matrixos` });
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

  function buildEnv(handle: string, displayName?: string): string[] {
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
    const dbUrl = databaseUrlForHandle(handle);
    if (dbUrl) {
      env.push(`DATABASE_URL=${dbUrl}`);
    }
    if (postgresUrl) {
      env.push(`PLATFORM_DATABASE_URL=${postgresUrl}/matrixos_platform`);
    }
    if (platformSecret) {
      const token = createHmac('sha256', platformSecret).update(handle).digest('hex');
      env.push(`UPGRADE_TOKEN=${token}`);
      env.push(`PLATFORM_INTERNAL_URL=http://distro-platform-1:9000`);
      env.push(`PLATFORM_SECRET=${platformSecret}`);
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

      const gatewayPort = allocatePort(db, baseGatewayPort, `${handle}-gw`);
      const shellPort = allocatePort(db, baseShellPort, `${handle}-sh`);

      const containerName = `matrixos-${handle}`;

      const container = await docker.createContainer({
        Image: image,
        name: containerName,
        Env: buildEnv(handle, displayName),
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

      insertContainer(db, {
        handle,
        clerkUserId,
        containerId: container.id,
        port: gatewayPort,
        shellPort,
        status: 'running',
      });

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
        try { await container.stop(); } catch {}
        try { await container.remove({ force: true }); } catch {}
      }

      releasePort(db, `${handle}-gw`);
      releasePort(db, `${handle}-sh`);
      deleteContainer(db, handle);
      await dropUserDatabase(handle);
    },

    async upgrade(handle) {
      const record = getContainer(db, handle);
      if (!record) throw new Error(`No container for handle: ${handle}`);

      if (record.containerId) {
        const old = docker.getContainer(record.containerId);
        try { await old.stop(); } catch {}
        try { await old.remove({ force: true }); } catch {}
      }

      await docker.pull(image);
      await ensureNetwork();
      await createUserDatabase(handle);

      const containerName = `matrixos-${handle}`;
      const container = await docker.createContainer({
        Image: image,
        name: containerName,
        Env: buildEnv(handle),
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

      await docker.pull(image);

      const results: RollingRestartResult['results'] = [];
      for (const record of running) {
        try {
          await createUserDatabase(record.handle);

          if (record.containerId) {
            const old = docker.getContainer(record.containerId);
            try { await old.stop(); } catch {}
            try { await old.remove({ force: true }); } catch {}
          }

          const containerName = `matrixos-${record.handle}`;
          const container = await docker.createContainer({
            Image: image,
            name: containerName,
            Env: buildEnv(record.handle),
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
        } catch {
          if (record.status !== 'stopped') {
            updateContainerStatus(db, record.handle, 'stopped');
          }
        }
      }
    },
  };
}
