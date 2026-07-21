import type { CustomerVpsConfig } from './customer-vps-config.js';
import { CustomerVpsError, logCustomerVpsError } from './customer-vps-errors.js';
import { z } from 'zod/v4';

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
  image?: number | string;
  sshKeys?: string[];
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
  createActionId?: number;
}

export interface HetznerImage {
  id: number;
  status: 'creating' | 'available';
  type: 'snapshot';
  architecture: 'x86' | 'arm';
  diskGb: number;
  labels: Record<string, string>;
  deleteProtected: boolean;
}

export interface HetznerAction {
  id: number;
  status: 'running' | 'success' | 'error';
  command: string;
  errorCode?: string;
}

export interface CreateHetznerSnapshotInput {
  description: string;
  labels: Record<string, string>;
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
  createSnapshot(serverId: number, input: CreateHetznerSnapshotInput): Promise<{ image: HetznerImage; action: HetznerAction }>;
  getImage(imageId: number): Promise<HetznerImage | null>;
  listImagesByLabel(labelSelector: string): Promise<HetznerImage[]>;
  deleteImage(imageId: number): Promise<void>;
  getAction(actionId: number): Promise<HetznerAction | null>;
}

const ProviderIdSchema = z.number().int().positive();
const ProviderSshKeysSchema = z.array(z.string().min(1).max(255)).max(20).optional();
const ProviderLabelsSchema = z.record(
  z.string().min(1).max(63),
  z.string().max(63),
).refine((labels) => Object.keys(labels).length <= 64, 'Too many provider labels');
const ProviderActionSchema = z.object({
  id: ProviderIdSchema,
  status: z.enum(['running', 'success', 'error']),
  command: z.string().min(1).max(128),
  error: z.object({ code: z.string().min(1).max(128) }).nullable().optional(),
}).passthrough();
const ProviderImageSchema = z.object({
  id: ProviderIdSchema,
  status: z.enum(['creating', 'available']),
  type: z.literal('snapshot'),
  architecture: z.enum(['x86', 'arm']),
  disk_size: z.number().int().min(1).max(2_048),
  labels: ProviderLabelsSchema.default({}),
  protection: z.object({ delete: z.boolean() }),
}).passthrough();

function providerUnavailable(): CustomerVpsError {
  return new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
}

function parseProviderAction(input: unknown): HetznerAction {
  const parsed = ProviderActionSchema.safeParse(input);
  if (!parsed.success) throw providerUnavailable();
  return {
    id: parsed.data.id,
    status: parsed.data.status,
    command: parsed.data.command,
    ...(parsed.data.error?.code ? { errorCode: parsed.data.error.code } : {}),
  };
}

function parseProviderImage(input: unknown): HetznerImage {
  const parsed = ProviderImageSchema.safeParse(input);
  if (!parsed.success) throw providerUnavailable();
  return {
    id: parsed.data.id,
    status: parsed.data.status,
    type: parsed.data.type,
    architecture: parsed.data.architecture,
    diskGb: parsed.data.disk_size,
    labels: parsed.data.labels,
    deleteProtected: parsed.data.protection.delete,
  };
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
  const response = body as { server?: Parameters<typeof mapServer>[0]; action?: unknown };
  const server = response.server;
  if (!server) {
    throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
  }
  const mapped = mapServer(server);
  return response.action === undefined
    ? mapped
    : { ...mapped, createActionId: parseProviderAction(response.action).id };
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
      const sshKeys = ProviderSshKeysSchema.safeParse(
        input.sshKeys !== undefined
          ? input.sshKeys
          : (config.sshKeyName ? [config.sshKeyName] : undefined),
      );
      if (!sshKeys.success) throw providerUnavailable();
      const res = await request('/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          server_type: input.serverType ?? config.serverType,
          image: input.image ?? config.image,
          location: input.location ?? config.location,
          ssh_keys: sshKeys.data,
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

    async createSnapshot(serverId, input) {
      ProviderIdSchema.parse(serverId);
      const parsedInput = z.object({
        description: z.string().min(1).max(255),
        labels: ProviderLabelsSchema,
      }).strict().parse(input);
      const res = await request(`/servers/${serverId}/actions/create_image`, {
        method: 'POST',
        body: JSON.stringify({ type: 'snapshot', description: parsedInput.description, labels: parsedInput.labels }),
      });
      if (res.status === 429) throw new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable');
      if (!res.ok) {
        await logProviderRejection('createSnapshot', res);
        throw providerUnavailable();
      }
      const body = await parseJson(res) as { image?: unknown; action?: unknown };
      return { image: parseProviderImage(body.image), action: parseProviderAction(body.action) };
    },

    async getImage(imageId) {
      ProviderIdSchema.parse(imageId);
      const res = await request(`/images/${imageId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw providerUnavailable();
      return parseProviderImage((await parseJson(res) as { image?: unknown }).image);
    },

    async listImagesByLabel(labelSelector) {
      const selector = z.string().min(1).max(512).regex(/^[a-zA-Z0-9._=,!-]+$/).parse(labelSelector);
      const res = await request(`/images?type=snapshot&label_selector=${encodeURIComponent(selector)}`);
      if (!res.ok) throw providerUnavailable();
      const images = (await parseJson(res) as { images?: unknown }).images;
      if (!Array.isArray(images) || images.length > 100) throw providerUnavailable();
      return images.map(parseProviderImage);
    },

    async deleteImage(imageId) {
      ProviderIdSchema.parse(imageId);
      const res = await request(`/images/${imageId}`, { method: 'DELETE' });
      if (res.status === 404) return;
      if (!res.ok) {
        await logProviderRejection('deleteImage', res);
        throw providerUnavailable();
      }
    },

    async getAction(actionId) {
      ProviderIdSchema.parse(actionId);
      const res = await request(`/actions/${actionId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw providerUnavailable();
      return parseProviderAction((await parseJson(res) as { action?: unknown }).action);
    },
  };
}
