import type Dockerode from 'dockerode';
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
}

export interface Orchestrator {
  provision(handle: string, clerkUserId: string): Promise<ContainerRecord>;
  start(handle: string): Promise<void>;
  stop(handle: string): Promise<void>;
  destroy(handle: string): Promise<void>;
  upgrade(handle: string): Promise<ContainerRecord>;
  getInfo(handle: string): ContainerRecord | undefined;
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
    memoryLimit = 256 * 1024 * 1024,
    cpuQuota = 50000,
    dataDir = '/data/users',
  } = config;

  async function ensureNetwork(): Promise<void> {
    const networks = await docker.listNetworks({ filters: { name: [network] } });
    if (networks.length === 0) {
      await docker.createNetwork({ Name: network, Driver: 'bridge' });
    }
  }

  return {
    async provision(handle, clerkUserId) {
      const existing = getContainer(db, handle);
      if (existing) throw new Error(`Container already exists for handle: ${handle}`);

      await ensureNetwork();

      const gatewayPort = allocatePort(db, baseGatewayPort, `${handle}-gw`);
      const shellPort = allocatePort(db, baseShellPort, `${handle}-sh`);

      const containerName = `matrixos-${handle}`;

      const container = await docker.createContainer({
        Image: image,
        name: containerName,
        Env: [
          `MATRIX_HANDLE=${handle}`,
          `PROXY_URL=${proxyUrl}`,
          `ANTHROPIC_BASE_URL=${proxyUrl}`,
          `ANTHROPIC_API_KEY=sk-proxy-managed`,
          `GATEWAY_EXTERNAL_URL=http://${containerName}:4000`,
          `PORT=4000`,
          `SHELL_PORT=3000`,
        ],
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

      const containerName = `matrixos-${handle}`;
      const container = await docker.createContainer({
        Image: image,
        name: containerName,
        Env: [
          `MATRIX_HANDLE=${handle}`,
          `PROXY_URL=${proxyUrl}`,
          `ANTHROPIC_BASE_URL=${proxyUrl}`,
          `ANTHROPIC_API_KEY=sk-proxy-managed`,
          `GATEWAY_EXTERNAL_URL=http://${containerName}:4000`,
          `PORT=4000`,
          `SHELL_PORT=3000`,
        ],
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

    getInfo(handle) {
      return getContainer(db, handle);
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
