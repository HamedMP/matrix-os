import type { CustomerVpsConfig } from './customer-vps-config.js';
import { CustomerVpsError, logCustomerVpsError } from './customer-vps-errors.js';

const HETZNER_USER_DATA_LIMIT_BYTES = 32 * 1024;

// Server-side only: the provider's error detail never reaches clients, but
// losing it entirely makes a provider-side rejection impossible to diagnose.
async function logProviderRejection(context: string, res: Response): Promise<void> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 500);
  } catch (err: unknown) {
    detail = err instanceof Error ? `<unreadable body: ${err.name}>` : '<unreadable body>';
  }
  logCustomerVpsError(`hetzner ${context}`, new Error(`HTTP ${res.status}: ${detail}`));
}

const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1';
const HETZNER_TIMEOUT_MS = 10_000;

export interface CreateHetznerServerInput {
  name: string;
  userData: string;
  labels: Record<string, string>;
  serverType?: string;
  location?: string;
}

export interface ResizeHetznerServerInput {
  serverType: string;
  upgradeDisk: boolean;
}

export interface HetznerServer {
  id: number;
  status: string;
  serverType?: string;
  publicIPv4?: string;
  publicIPv6?: string;
  labels?: Record<string, string>;
}

export interface HetznerClient {
  createServer(input: CreateHetznerServerInput): Promise<HetznerServer>;
  getServer(serverId: number): Promise<HetznerServer | null>;
  shutdownServer(serverId: number): Promise<void>;
  powerOffServer(serverId: number): Promise<void>;
  powerOnServer(serverId: number): Promise<void>;
  resizeServer(serverId: number, input: ResizeHetznerServerInput): Promise<void>;
  deleteServer(serverId: number): Promise<void>;
  listServersByLabel?(labelSelector: string): Promise<HetznerServer[]>;
}

function requireToken(config: CustomerVpsConfig): string {
  if (!config.hetznerApiToken) {
    throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
  }
  return config.hetznerApiToken;
}

function mapServer(server: {
  id?: unknown;
  status?: unknown;
  server_type?: { name?: unknown };
  public_net?: { ipv4?: { ip?: unknown }; ipv6?: { ip?: unknown } };
  labels?: unknown;
}): HetznerServer {
  if (!server || typeof server.id !== 'number' || typeof server.status !== 'string') {
    throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
  }
  return {
    id: server.id,
    status: server.status,
    serverType: typeof server.server_type?.name === 'string' ? server.server_type.name : undefined,
    publicIPv4: typeof server.public_net?.ipv4?.ip === 'string' ? server.public_net.ipv4.ip : undefined,
    publicIPv6: typeof server.public_net?.ipv6?.ip === 'string' ? server.public_net.ipv6.ip : undefined,
    labels: server.labels && typeof server.labels === 'object'
      ? Object.fromEntries(
          Object.entries(server.labels as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : undefined,
  };
}

function parseServer(body: unknown): HetznerServer {
  const server = (body as { server?: Parameters<typeof mapServer>[0] }).server;
  if (!server) {
    throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
  }
  return mapServer(server);
}

function parseServers(body: unknown): HetznerServer[] {
  const servers = (body as { servers?: Parameters<typeof mapServer>[0][] }).servers;
  if (!Array.isArray(servers)) {
    throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
  }
  return servers.map(mapServer);
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
      // Hetzner rejects user_data over 32KiB with a generic 422
      // invalid_input; fail with a distinct code before calling out so the
      // failure is attributable rather than an opaque provider error.
      const userDataBytes = Buffer.byteLength(input.userData, 'utf8');
      if (userDataBytes > HETZNER_USER_DATA_LIMIT_BYTES) {
        logCustomerVpsError(
          'hetzner createServer preflight',
          new Error(`user_data is ${userDataBytes} bytes (limit ${HETZNER_USER_DATA_LIMIT_BYTES})`),
        );
        throw new CustomerVpsError(500, 'user_data_too_large', 'Provisioning provider unavailable');
      }
      const res = await request('/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          server_type: input.serverType ?? config.serverType,
          image: config.image,
          location: input.location ?? config.location,
          ssh_keys: config.sshKeyName ? [config.sshKeyName] : undefined,
          user_data: input.userData,
          labels: input.labels,
        }),
      });
      if (res.status === 429) {
        throw new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable');
      }
      if (!res.ok) {
        await logProviderRejection('createServer', res);
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

    async shutdownServer(serverId) {
      const res = await request(`/servers/${serverId}/actions/shutdown`, { method: 'POST' });
      if (res.status === 429) {
        throw new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable');
      }
      if (!res.ok) {
        await logProviderRejection('shutdownServer', res);
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
    },

    async powerOffServer(serverId) {
      const res = await request(`/servers/${serverId}/actions/poweroff`, { method: 'POST' });
      if (res.status === 429) {
        throw new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable');
      }
      if (!res.ok) {
        await logProviderRejection('powerOffServer', res);
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
    },

    async powerOnServer(serverId) {
      const res = await request(`/servers/${serverId}/actions/poweron`, { method: 'POST' });
      if (res.status === 429) {
        throw new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable');
      }
      if (!res.ok) {
        await logProviderRejection('powerOnServer', res);
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
    },

    async resizeServer(serverId, input) {
      const res = await request(`/servers/${serverId}/actions/change_type`, {
        method: 'POST',
        body: JSON.stringify({
          server_type: input.serverType,
          upgrade_disk: input.upgradeDisk,
        }),
      });
      if (res.status === 429) {
        throw new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable');
      }
      if (!res.ok) {
        await logProviderRejection('resizeServer', res);
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
    },

    async deleteServer(serverId) {
      const res = await request(`/servers/${serverId}`, { method: 'DELETE' });
      if (res.status === 404) return;
      if (!res.ok) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
    },

    async listServersByLabel(labelSelector) {
      const res = await request(`/servers?label_selector=${encodeURIComponent(labelSelector)}`);
      if (!res.ok) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
      return parseServers(await parseJson(res));
    },
  };
}
