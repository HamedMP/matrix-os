import type Dockerode from 'dockerode';
import {
  type PlatformDB,
  updateContainerStatus,
} from './db.js';

const DOCKER_INSPECT_TIMEOUT_MS = 10_000;

export interface ResolvedContainerEndpoint {
  containerId: string | null;
  host: string;
  source: 'record' | 'docker-id' | 'docker-name';
}

function isDockerNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('No such container') || message.includes('404');
}

async function inspectLiveContainer(
  docker: Dockerode,
  handle: string,
  containerId?: string | null,
): Promise<{ info: Dockerode.ContainerInspectInfo; source: 'docker-id' | 'docker-name' } | null> {
  const candidates: Array<{ target: string; source: 'docker-id' | 'docker-name' }> = [];
  if (containerId) {
    candidates.push({ target: containerId, source: 'docker-id' });
  }
  candidates.push({ target: `matrixos-${handle}`, source: 'docker-name' });

  for (const candidate of candidates) {
    try {
      const info = await Promise.race([
        docker.getContainer(candidate.target).inspect(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Docker inspect timeout after ${DOCKER_INSPECT_TIMEOUT_MS}ms`)), DOCKER_INSPECT_TIMEOUT_MS);
        }),
      ]);
      return { info, source: candidate.source };
    } catch (err: unknown) {
      if (!isDockerNotFoundError(err)) {
        throw err;
      }
    }
  }

  return null;
}

function getContainerHostFromInspect(
  info: Dockerode.ContainerInspectInfo,
  handle: string,
): string {
  const networks = info.NetworkSettings?.Networks
    ? Object.values(info.NetworkSettings.Networks)
    : [];
  const ip = networks.find(
    (network) => typeof network?.IPAddress === 'string' && network.IPAddress.length > 0,
  )?.IPAddress;
  return ip || `matrixos-${handle}`;
}

export async function resolveContainerEndpoint(
  docker: Dockerode | undefined,
  db: PlatformDB,
  handle: string,
  containerId?: string | null,
): Promise<ResolvedContainerEndpoint | null> {
  if (!docker) {
    return {
      containerId: containerId ?? null,
      host: `matrixos-${handle}`,
      source: 'record',
    };
  }

  const inspected = await inspectLiveContainer(docker, handle, containerId);
  if (!inspected) {
    return null;
  }

  const { info, source } = inspected;
  if (info.Id && info.Id !== containerId) {
    await updateContainerStatus(db, handle, info.State?.Running ? 'running' : 'stopped', info.Id);
  }

  return {
    containerId: info.Id ?? containerId ?? null,
    host: getContainerHostFromInspect(info, handle),
    source,
  };
}
