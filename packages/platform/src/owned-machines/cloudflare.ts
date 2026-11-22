import { z } from 'zod/v4';
import type { OwnedMachinesConfig } from './config.js';

const API_TIMEOUT_MS = 10_000;
const TUNNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Provider failure. Never shown to clients; `retryable` drives backoff. */
export class OwnedCloudflareError extends Error {
  constructor(readonly operation: string, readonly status: number, readonly retryable: boolean) {
    super(`Cloudflare ${operation} failed with status ${status}`);
    this.name = 'OwnedCloudflareError';
  }
}

const EnvelopeSchema = z.object({ success: z.boolean(), result: z.unknown() });
const TunnelSchema = z.object({
  id: z.string().regex(TUNNEL_ID),
  name: z.string().max(256),
  created_at: z.string().optional(),
  token: z.string().max(4096).optional(),
}).loose();
const TunnelListSchema = z.array(TunnelSchema).max(1000);
const DnsRecordListSchema = z.array(z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), name: z.string() }).loose()).max(100);
const TokenSchema = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_=+/.-]+$/);

export interface OwnedTunnelSummary { id: string; name: string; createdAt: Date | null }

export interface OwnedCloudflareClient {
  findTunnelByName(name: string): Promise<OwnedTunnelSummary | null>;
  createTunnel(name: string): Promise<OwnedTunnelSummary>;
  getTunnelToken(tunnelId: string): Promise<string>;
  configureTunnel(tunnelId: string, hostname: string, service: string): Promise<void>;
  ensureDnsRecord(hostname: string, tunnelId: string): Promise<void>;
  deleteDnsRecord(hostname: string): Promise<void>;
  deleteTunnel(tunnelId: string): Promise<void>;
  listTunnelsPage(page: number, perPage: number): Promise<OwnedTunnelSummary[]>;
}

type FetchLike = typeof fetch;

function toSummary(tunnel: z.infer<typeof TunnelSchema>): OwnedTunnelSummary {
  const created = tunnel.created_at ? new Date(tunnel.created_at) : null;
  return { id: tunnel.id, name: tunnel.name, createdAt: created && !Number.isNaN(created.getTime()) ? created : null };
}

export function createOwnedCloudflareClient(
  config: OwnedMachinesConfig['cloudflare'],
  fetchImpl: FetchLike = fetch,
): OwnedCloudflareClient {
  const account = `${config.apiBase}/accounts/${config.accountId}`;
  const zone = `${config.apiBase}/zones/${config.zoneId}`;

  async function call(operation: string, url: string, init: RequestInit = {}, allow404 = false): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || err instanceof TypeError)) {
        throw new OwnedCloudflareError(operation, 0, true);
      }
      throw err;
    }
    if (allow404 && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OwnedCloudflareError(operation, response.status, response.status === 429 || response.status >= 500);
    }
    const text = await response.text();
    if (text.length > 1_000_000) throw new OwnedCloudflareError(operation, 502, true);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (err: unknown) {
      if (err instanceof SyntaxError) throw new OwnedCloudflareError(operation, 502, true);
      throw err;
    }
    const envelope = EnvelopeSchema.safeParse(parsedJson);
    if (!envelope.success || !envelope.data.success) throw new OwnedCloudflareError(operation, 502, true);
    return envelope.data.result;
  }

  function parse<T>(operation: string, schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new OwnedCloudflareError(operation, 502, false);
    return parsed.data;
  }

  return {
    async findTunnelByName(name) {
      const query = new URLSearchParams({ name, is_deleted: 'false' });
      const list = parse('tunnel_lookup', TunnelListSchema, await call('tunnel_lookup', `${account}/cfd_tunnel?${query}`));
      const match = list.find((tunnel) => tunnel.name === name);
      return match ? toSummary(match) : null;
    },
    async createTunnel(name) {
      const result = await call('tunnel_create', `${account}/cfd_tunnel`, {
        method: 'POST', body: JSON.stringify({ name, config_src: 'cloudflare' }),
      });
      return toSummary(parse('tunnel_create', TunnelSchema, result));
    },
    async getTunnelToken(tunnelId) {
      if (!TUNNEL_ID.test(tunnelId)) throw new OwnedCloudflareError('tunnel_token', 400, false);
      return parse('tunnel_token', TokenSchema, await call('tunnel_token', `${account}/cfd_tunnel/${tunnelId}/token`));
    },
    async configureTunnel(tunnelId, hostname, service) {
      if (!TUNNEL_ID.test(tunnelId)) throw new OwnedCloudflareError('tunnel_config', 400, false);
      await call('tunnel_config', `${account}/cfd_tunnel/${tunnelId}/configurations`, {
        method: 'PUT',
        body: JSON.stringify({
          config: { ingress: [{ hostname, service, originRequest: {} }, { service: 'http_status:404' }] },
        }),
      });
    },
    async ensureDnsRecord(hostname, tunnelId) {
      const query = new URLSearchParams({ type: 'CNAME', name: hostname });
      const existing = parse('dns_lookup', DnsRecordListSchema, await call('dns_lookup', `${zone}/dns_records?${query}`));
      if (existing.some((record) => record.name === hostname)) return;
      await call('dns_create', `${zone}/dns_records`, {
        method: 'POST',
        body: JSON.stringify({ type: 'CNAME', name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 }),
      });
    },
    async deleteDnsRecord(hostname) {
      const query = new URLSearchParams({ type: 'CNAME', name: hostname });
      const existing = parse('dns_lookup', DnsRecordListSchema, await call('dns_lookup', `${zone}/dns_records?${query}`));
      for (const record of existing.filter((item) => item.name === hostname)) {
        await call('dns_delete', `${zone}/dns_records/${record.id}`, { method: 'DELETE' }, true);
      }
    },
    async deleteTunnel(tunnelId) {
      if (!TUNNEL_ID.test(tunnelId)) throw new OwnedCloudflareError('tunnel_delete', 400, false);
      await call('tunnel_connections_delete', `${account}/cfd_tunnel/${tunnelId}/connections`, { method: 'DELETE' }, true);
      await call('tunnel_delete', `${account}/cfd_tunnel/${tunnelId}`, { method: 'DELETE' }, true);
    },
    async listTunnelsPage(page, perPage) {
      const query = new URLSearchParams({ is_deleted: 'false', page: String(page), per_page: String(perPage) });
      return parse('tunnel_list', TunnelListSchema, await call('tunnel_list', `${account}/cfd_tunnel?${query}`)).map(toSummary);
    },
  };
}
