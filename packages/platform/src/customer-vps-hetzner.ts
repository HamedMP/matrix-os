import type { CustomerVpsConfig } from './customer-vps-config.js';
import { CustomerVpsError } from './customer-vps-errors.js';

const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1';
const HETZNER_TIMEOUT_MS = 10_000;

export interface CreateHetznerServerInput {
  name: string;
  userData: string;
  labels: Record<string, string>;
}

export interface HetznerServer {
  id: number;
  status: string;
  publicIPv4?: string;
  publicIPv6?: string;
}

export interface HetznerClient {
  createServer(input: CreateHetznerServerInput): Promise<HetznerServer>;
  getServer(serverId: number): Promise<HetznerServer | null>;
  deleteServer(serverId: number): Promise<void>;
}

function requireToken(config: CustomerVpsConfig): string {
  if (!config.hetznerApiToken) {
    throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
  }
  return config.hetznerApiToken;
}

function parseServer(body: unknown): HetznerServer {
  const server = (body as { server?: { id?: unknown; status?: unknown; public_net?: { ipv4?: { ip?: unknown }; ipv6?: { ip?: unknown } } } }).server;
  if (!server || typeof server.id !== 'number' || typeof server.status !== 'string') {
    throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
  }
  return {
    id: server.id,
    status: server.status,
    publicIPv4: typeof server.public_net?.ipv4?.ip === 'string' ? server.public_net.ipv4.ip : undefined,
    publicIPv6: typeof server.public_net?.ipv6?.ip === 'string' ? server.public_net.ipv6.ip : undefined,
  };
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
  }
}

export function createHetznerClient(
  config: CustomerVpsConfig,
  fetchImpl: typeof fetch = fetch,
): HetznerClient {
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = requireToken(config);
    return fetchImpl(`${HETZNER_API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(HETZNER_TIMEOUT_MS),
    });
  }

  return {
    async createServer(input) {
      const res = await request('/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          server_type: config.serverType,
          image: config.image,
          location: config.location,
          ssh_keys: config.sshKeyName ? [config.sshKeyName] : undefined,
          user_data: input.userData,
          labels: input.labels,
        }),
      });
      if (res.status === 429) {
        throw new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable');
      }
      if (!res.ok) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
      return parseServer(await parseJson(res));
    },

    async getServer(serverId) {
      const res = await request(`/servers/${serverId}`);
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
      return parseServer(await parseJson(res));
    },

    async deleteServer(serverId) {
      const res = await request(`/servers/${serverId}`, { method: 'DELETE' });
      if (res.status === 404) return;
      if (!res.ok) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
    },
  };
}
