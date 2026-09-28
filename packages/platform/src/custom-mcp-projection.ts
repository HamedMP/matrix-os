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

const PRIMARY_TIMEOUT_MS = 10_000;
const PRIVATE_PREVIEW_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PENDING_FAN_OUTS = 64;

export interface CustomMcpProjectionUser {
  handle: string;
  // The gateway Postgres repository returns database column names.
  clerk_id: string;
}

type ProjectionMachine = CustomerVpsProxyMachine & { clerkUserId: string; handle: string };
type ProjectionMethod = 'GET' | 'POST' | 'DELETE';

async function sendCustomMcpProjection(options: {
  machine: ProjectionMachine;
  user: CustomMcpProjectionUser;
  method: ProjectionMethod;
  serverId?: string;
  body?: unknown;
  platformSecret: string;
  dispatcher?: Agent;
  fetchFn?: typeof fetch;
  timeoutMs: number;
}): Promise<unknown> {
  const { machine, user, body } = options;
  const response = await (options.fetchFn ?? fetch)(buildCustomMcpProjectionUrl(machine, options.serverId), {
    method: options.method,
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: {
      authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, options.platformSecret)}`,
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
}

export function createCustomMcpProjectionRequest(options: {
  getUser(userId: string): Promise<CustomMcpProjectionUser | null>;
  getMachine(user: CustomMcpProjectionUser): Promise<ProjectionMachine | null | undefined>;
  platformSecret: string;
  dispatcher?: Agent;
  fetchFn?: typeof fetch;
}) {
  return async (userId: string, method: ProjectionMethod, serverId?: string, body?: unknown): Promise<unknown> => {
    const user = await options.getUser(userId);
    if (!user) throw new Error('Custom MCP owner is unavailable');
    const machine = await options.getMachine(user);
    if (!machine || machine.clerkUserId !== user.clerk_id) {
      throw new Error('Custom MCP owner runtime is unavailable');
    }
    return sendCustomMcpProjection({
      machine, user, method, serverId, body,
      platformSecret: options.platformSecret,
      dispatcher: options.dispatcher,
      fetchFn: options.fetchFn,
      timeoutMs: PRIMARY_TIMEOUT_MS,
    });
  };
}

/**
 * The broker's projection target. Writes go to the owner's primary computer
 * exactly as before; the primary's result alone decides what the broker
 * reports. Each write is then queued, best effort, for the owner's eligible
 * Private Previews (spec 537 P5), so their Chat tool gate sees the same
 * servers. The queue runs in the background and in order, so a slow preview
 * never delays the owner's answer. A preview that misses a push, or a push the
 * bounded queue drops, converges through the preview's periodic pull. Reads
 * stay on the primary, whose projection the broker compares against.
 */
export function createCustomMcpProjection<PreviewMachine extends ProjectionMachine & { machineId: string }>(options: {
  getUser(userId: string): Promise<CustomMcpProjectionUser | null>;
  getMachine(user: CustomMcpProjectionUser): Promise<ProjectionMachine | null | undefined>;
  listPrivatePreviews(clerkUserId: string): Promise<PreviewMachine[]>;
  isEligible(machine: PreviewMachine): Promise<boolean>;
  platformSecret: string;
  dispatcher?: Agent;
  fetchFn?: typeof fetch;
  logError(context: string, err: unknown): void;
  maxPendingFanOuts?: number;
}) {
  const primary = createCustomMcpProjectionRequest(options);
  const maxPendingFanOuts = options.maxPendingFanOuts ?? DEFAULT_MAX_PENDING_FAN_OUTS;
  let fanOutQueue: Promise<void> = Promise.resolve();
  let pendingFanOuts = 0;

  async function fanOut(userId: string, method: ProjectionMethod, serverId?: string, body?: unknown): Promise<void> {
    const user = await options.getUser(userId);
    if (!user) return;
    const machines = (await options.listPrivatePreviews(user.clerk_id))
      .filter((machine) => machine.clerkUserId === user.clerk_id);
    const results = await Promise.allSettled(machines.map(async (machine) => {
      if (!await options.isEligible(machine)) return;
      await sendCustomMcpProjection({
        machine, user, method, serverId, body,
        platformSecret: options.platformSecret,
        dispatcher: options.dispatcher,
        fetchFn: options.fetchFn,
        timeoutMs: PRIVATE_PREVIEW_TIMEOUT_MS,
      });
    }));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        options.logError(`custom MCP projection fan-out failed machineId=${machines[index]!.machineId}`, result.reason);
      }
    });
  }

  function queueFanOut(userId: string, method: ProjectionMethod, serverId?: string, body?: unknown): void {
    if (pendingFanOuts >= maxPendingFanOuts) {
      options.logError('custom MCP projection fan-out skipped; Private Previews reconcile on their next pull',
        new Error('Custom MCP projection fan-out backlog is full'));
      return;
    }
    pendingFanOuts += 1;
    fanOutQueue = fanOutQueue
      .then(() => fanOut(userId, method, serverId, body))
      .catch((err: unknown) => {
        options.logError('custom MCP projection fan-out failed', err);
      })
      .finally(() => {
        pendingFanOuts -= 1;
      });
  }

  async function write(userId: string, method: ProjectionMethod, serverId?: string, body?: unknown): Promise<void> {
    try {
      await primary(userId, method, serverId, body);
    } finally {
      // Private Previews follow the change whether or not the primary accepted it.
      queueFanOut(userId, method, serverId, body);
    }
  }

  return {
    upsert: (userId: string, server: unknown) => write(userId, 'POST', undefined, server),
    remove: (userId: string, serverId: string) => write(userId, 'DELETE', serverId),
    read: (userId: string, serverId: string) => primary(userId, 'GET', serverId),
    /** Settles queued Private Preview deliveries; call before closing the database. */
    drain: (): Promise<void> => fanOutQueue,
  };
}
