import type { Agent } from 'undici';
import { buildPlatformVerificationToken } from './platform-token.js';
import {
  buildCustomerVpsProxyUrl,
  type CustomerVpsProxyMachine,
} from "./profile-routing.js";

export function buildCustomMcpProjectionUrl(
  machine: CustomerVpsProxyMachine,
  serverId?: string,
): string {
  const path = `/api/internal/mcp-projection${
    serverId ? `/${encodeURIComponent(serverId)}` : ""
  }`;
  const target = buildCustomerVpsProxyUrl(machine, path);
  if (!target) throw new Error("Custom MCP owner runtime is unavailable");
  return target;
}

export interface CustomMcpProjectionUser {
  handle: string;
  // The gateway Postgres repository returns database column names.
  clerk_id: string;
}

export function createCustomMcpProjectionRequest(options: {
  getUser(userId: string): Promise<CustomMcpProjectionUser | null>;
  getMachine(handle: string): Promise<(CustomerVpsProxyMachine & { clerkUserId: string }) | null | undefined>;
  platformSecret: string;
  dispatcher?: Agent;
  fetchFn?: typeof fetch;
}) {
  return async (userId: string, method: 'GET' | 'POST' | 'DELETE', serverId?: string, body?: unknown): Promise<unknown> => {
    const user = await options.getUser(userId);
    if (!user) throw new Error('Custom MCP owner is unavailable');
    const machine = await options.getMachine(user.handle);
    if (!machine || machine.clerkUserId !== user.clerk_id) {
      throw new Error('Custom MCP owner runtime is unavailable');
    }
    const response = await (options.fetchFn ?? fetch)(buildCustomMcpProjectionUrl(machine, serverId), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${buildPlatformVerificationToken(user.handle, options.platformSecret)}`,
        'x-matrix-clerk-user-id': user.clerk_id,
        host: 'app.matrix-os.com',
        'x-forwarded-host': 'app.matrix-os.com',
        'x-forwarded-proto': 'https',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher: options.dispatcher,
    } as RequestInit & { dispatcher?: Agent });
    if (!response.ok) throw new Error(`Custom MCP projection failed (${response.status})`);
    return response.status === 204 ? undefined : response.json();
  };
}
