import { randomBytes } from 'node:crypto';
import type { PlatformDB } from '../db.js';
import { OwnedCloudflareError, type OwnedCloudflareClient } from './cloudflare.js';
import {
  claimOwnedTunnelWork,
  deferOwnedTunnelWork,
  getOwnedMachineLink,
  markOwnedTunnelDeleted,
  markOwnedTunnelReady,
  purgeExpiredOwnedEnrollments,
  queueStaleOwnedTunnelReclaim,
  recordOwnedTunnelCreated,
  type OwnedTunnelWorkItem,
} from './repository.js';

export const OWNED_TUNNEL_RECLAIM_AFTER_MS = 14 * 86_400_000;
const LEASE_MS = 120_000;
const BATCH = 10;
const MAX_CREATE_ATTEMPTS = 10;
const ORPHAN_MIN_AGE_MS = 3_600_000;
const ORPHAN_SCAN_PAGES = 20;
const ORPHAN_PAGE_SIZE = 50;
export const OWNED_TUNNEL_NAME_PREFIX = 'matrix-owned-';

/**
 * Tunnel names carry the host prefix, so environments sharing one Cloudflare
 * account (preview and production) never adopt or reconcile each other's tunnels.
 */
export function ownedTunnelNamePrefix(hostPrefix = ''): string {
  return `${hostPrefix}${OWNED_TUNNEL_NAME_PREFIX}`;
}

export function ownedTunnelName(machineId: string, hostPrefix = ''): string {
  return `${ownedTunnelNamePrefix(hostPrefix)}${machineId}`;
}

function backoffMs(attempts: number): number {
  return Math.min(600_000, 5_000 * 2 ** Math.min(attempts, 7)) + Math.floor(Math.random() * 1_000);
}

export interface OwnedTunnelWorkerDeps {
  db: PlatformDB;
  cloudflare: OwnedCloudflareClient;
  hostSuffix: string;
  hostPrefix?: string;
  ingressService: string;
  now?: () => Date;
  log?: (message: string, err?: unknown) => void;
}

function describe(err: unknown): string {
  if (err instanceof OwnedCloudflareError) return `${err.operation}:${err.status}`;
  return err instanceof Error ? err.name : 'UnknownError';
}

async function createTunnel(deps: OwnedTunnelWorkerDeps, item: OwnedTunnelWorkItem): Promise<void> {
  const name = ownedTunnelName(item.machineId, deps.hostPrefix);
  let tunnelId = item.tunnelId;
  let hostname = item.tunnelHostname;
  if (!tunnelId || !hostname) {
    const existing = await deps.cloudflare.findTunnelByName(name);
    const tunnel = existing ?? await deps.cloudflare.createTunnel(name);
    tunnelId = tunnel.id;
    hostname = `${deps.hostPrefix ?? ''}${randomBytes(8).toString('hex')}.${deps.hostSuffix}`;
    if (!(await recordOwnedTunnelCreated(deps.db, { machineId: item.machineId, tunnelId, tunnelHostname: hostname }))) {
      // Revoked while creating: the reconciler deletes the unreferenced tunnel.
      return;
    }
  }
  await deps.cloudflare.configureTunnel(tunnelId, hostname, deps.ingressService);
  await deps.cloudflare.ensureDnsRecord(hostname, tunnelId);
  await markOwnedTunnelReady(deps.db, item.machineId);
}

async function deleteTunnel(deps: OwnedTunnelWorkerDeps, item: OwnedTunnelWorkItem): Promise<void> {
  if (item.tunnelHostname) await deps.cloudflare.deleteDnsRecord(item.tunnelHostname);
  if (item.tunnelId) await deps.cloudflare.deleteTunnel(item.tunnelId);
  await markOwnedTunnelDeleted(deps.db, item.machineId);
}

/** One pass over due tunnel work. Each item fails independently. */
export async function runOwnedTunnelWorkPass(deps: OwnedTunnelWorkerDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const items = await claimOwnedTunnelWork(deps.db, { now, limit: BATCH, leaseMs: LEASE_MS });
  for (const item of items) {
    try {
      if (item.tunnelState === 'pending') await createTunnel(deps, item);
      else await deleteTunnel(deps, item);
    } catch (err: unknown) {
      deps.log?.(`[owned-machines] tunnel ${item.tunnelState} failed (${describe(err)})`, err);
      const retryable = !(err instanceof OwnedCloudflareError) || err.retryable;
      const giveUp = item.tunnelState === 'pending' && (!retryable || item.attempts >= MAX_CREATE_ATTEMPTS);
      await deferOwnedTunnelWork(deps.db, {
        machineId: item.machineId,
        nextAttemptAt: new Date(now.getTime() + backoffMs(item.attempts)),
        failed: giveUp,
      });
    }
  }
  return items.length;
}

/**
 * Hourly: reclaim tunnels of machines offline past the window, purge old
 * enrollment codes, and delete provider tunnels no live link references.
 */
export async function runOwnedTunnelReconcilePass(deps: OwnedTunnelWorkerDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await queueStaleOwnedTunnelReclaim(deps.db, {
    offlineBefore: new Date(now.getTime() - OWNED_TUNNEL_RECLAIM_AFTER_MS), now, limit: 100,
  });
  await purgeExpiredOwnedEnrollments(deps.db, new Date(now.getTime() - 2 * 86_400_000), 500);
  const namePrefix = ownedTunnelNamePrefix(deps.hostPrefix);
  for (let page = 1; page <= ORPHAN_SCAN_PAGES; page += 1) {
    const tunnels = await deps.cloudflare.listTunnelsPage(page, ORPHAN_PAGE_SIZE);
    for (const tunnel of tunnels) {
      if (!tunnel.name.startsWith(namePrefix)) continue;
      if (!tunnel.createdAt || now.getTime() - tunnel.createdAt.getTime() < ORPHAN_MIN_AGE_MS) continue;
      const machineId = tunnel.name.slice(namePrefix.length);
      // A production reconciler must not treat a prefixed preview tunnel as its own orphan.
      if (!/^[0-9a-f-]{36}$/.test(machineId)) continue;
      const link = await getOwnedMachineLink(deps.db, machineId);
      const referenced = link && !link.revokedAt && link.tunnelId === tunnel.id;
      if (referenced || (link && link.tunnelState === 'pending' && !link.tunnelId)) continue;
      try {
        await deps.cloudflare.deleteTunnel(tunnel.id);
      } catch (err: unknown) {
        deps.log?.(`[owned-machines] orphan tunnel delete failed (${describe(err)})`, err);
      }
    }
    if (tunnels.length < ORPHAN_PAGE_SIZE) break;
  }
}

export interface OwnedTunnelWorker {
  stop(): void;
  drain(): Promise<void>;
}

export function startOwnedTunnelWorker(deps: OwnedTunnelWorkerDeps & {
  workIntervalMs?: number;
  reconcileIntervalMs?: number;
}): OwnedTunnelWorker {
  let stopped = false;
  let running: Promise<unknown> | undefined;
  const run = (pass: () => Promise<unknown>, label: string) => {
    if (stopped || running) return;
    const current = pass()
      .catch((err: unknown) => deps.log?.(`[owned-machines] ${label} pass failed (${describe(err)})`, err))
      .finally(() => { if (running === current) running = undefined; });
    running = current;
  };
  const work = setInterval(() => run(() => runOwnedTunnelWorkPass(deps), 'tunnel'), deps.workIntervalMs ?? 5_000);
  const reconcile = setInterval(() => run(() => runOwnedTunnelReconcilePass(deps), 'reconcile'), deps.reconcileIntervalMs ?? 3_600_000);
  work.unref?.();
  reconcile.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(work);
      clearInterval(reconcile);
    },
    drain() {
      return (running ?? Promise.resolve()).then(() => undefined);
    },
  };
}
