/**
 * VPS provider polling + deletion-queue operations.
*
 * Extracted from ./customer-vps.ts (Phase 1-A4). Pure move: no logic changes.
 * Shared by provisioning, recovery, resize, and billing-suspend flows via one
 * sub-factory so provider wait/retry behavior keeps a single owner.
 */
import { randomUUID } from 'node:crypto';
import type { PlatformDB } from './db.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import type { UserMachineRecord } from './db.js';
import { insertProviderDeletion } from './db.js';
import { CustomerVpsError, logCustomerVpsError } from './customer-vps-errors.js';

const RESIZE_STATUS_POLL_INTERVAL_MS = 1_000;
const RESIZE_STATUS_POLL_TIMEOUT_MS = 90_000;
const BILLING_RUNTIME_HEALTH_POLL_INTERVAL_MS = 1_000;
const BILLING_RUNTIME_HEALTH_POLL_TIMEOUT_MS = 90_000;
const PROVISIONING_CREATE_ACTION_POLL_ATTEMPTS = 31;
const PROVISIONING_CREATE_ACTION_POLL_INTERVAL_MS = 1_000;
const RECOVERY_CREATE_ACTION_POLL_ATTEMPTS = 6;
const RECOVERY_CREATE_ACTION_POLL_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface VpsPollingOperationsDeps {
  db: PlatformDB;
  hetzner: HetznerClient;
  fetchDispatcher?: import('undici').Dispatcher;
  now: () => Date;
}

export function createVpsPollingOperations(pollingDeps: VpsPollingOperationsDeps) {
  const deps = pollingDeps;
  const now = pollingDeps.now;
  async function waitForServerStatus(
    serverId: number,
    expectedStatus: string,
    context: string,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<boolean> {
    const deadline = Date.now() + RESIZE_STATUS_POLL_TIMEOUT_MS;
    for (;;) {
      if (shouldContinue && !(await shouldContinue())) return false;
      let server: Awaited<ReturnType<typeof deps.hetzner.getServer>>;
      try {
        server = await deps.hetzner.getServer(serverId);
      } catch (err: unknown) {
        if (Date.now() >= deadline) {
          throw new CustomerVpsError(500, 'provider_timeout', 'Provisioning provider unavailable');
        }
        logCustomerVpsError(`resize ${context} server read failed serverId=${serverId}`, err);
        await sleep(RESIZE_STATUS_POLL_INTERVAL_MS);
        continue;
      }
      if (!server) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
      if (server.status === expectedStatus) {
        return true;
      }
      if (Date.now() >= deadline) {
        throw new CustomerVpsError(500, 'provider_timeout', 'Provisioning provider unavailable');
      }
      logCustomerVpsError(
        `resize ${context} waiting for serverId=${serverId}`,
        new Error(`expected ${expectedStatus}, got ${server.status}`),
      );
      await sleep(RESIZE_STATUS_POLL_INTERVAL_MS);
    }
  }

  async function waitForRuntimeHealth(
    row: UserMachineRecord,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!row.publicIPv4) {
      throw new CustomerVpsError(500, 'invalid_state', 'Computer is unavailable');
    }
    const deadline = Date.now() + BILLING_RUNTIME_HEALTH_POLL_TIMEOUT_MS;
    for (;;) {
      if (shouldContinue && !(await shouldContinue())) return false;
      try {
        const response = await fetch(`https://${row.publicIPv4}:443/health`, {
          signal: AbortSignal.timeout(3_000),
          redirect: 'error',
          ...(deps.fetchDispatcher ? { dispatcher: deps.fetchDispatcher } : {}),
        } as RequestInit & { dispatcher?: import('undici').Dispatcher });
        if (response.ok) return true;
      } catch (err: unknown) {
        if (Date.now() >= deadline) {
          throw new CustomerVpsError(500, 'provider_timeout', 'Computer is unavailable');
        }
        logCustomerVpsError(`billing resume health check failed machineId=${row.machineId}`, err);
      }
      if (Date.now() >= deadline) {
        throw new CustomerVpsError(500, 'provider_timeout', 'Computer is unavailable');
      }
      await sleep(BILLING_RUNTIME_HEALTH_POLL_INTERVAL_MS);
    }
  }

  async function queueProviderDeletion(input: {
    providerServerId: number;
    reason: string;
    machineId?: string | null;
    handle?: string | null;
    err: unknown;
  }): Promise<void> {
    const currentTime = now().toISOString();
    try {
      await insertProviderDeletion(deps.db, {
        id: randomUUID(),
        providerServerId: input.providerServerId,
        reason: input.reason,
        machineId: input.machineId,
        handle: input.handle,
        nextAttemptAt: currentTime,
        createdAt: currentTime,
        lastError: input.err instanceof Error ? input.err.message : String(input.err),
      });
    } catch (queueErr: unknown) {
      logCustomerVpsError(
        `provider deletion enqueue failed orphanedHetznerServerId=${input.providerServerId} reason=${input.reason}`,
        queueErr,
      );
    }
  }

  async function waitForRecoveryCreateAction(actionId: number): Promise<'success' | 'error' | 'pending'> {
    for (let attempt = 0; attempt < RECOVERY_CREATE_ACTION_POLL_ATTEMPTS; attempt += 1) {
      try {
        const action = await deps.hetzner.getAction(actionId);
        if (action?.status === 'success') return 'success';
        if (action?.status === 'error') return 'error';
      } catch (err: unknown) {
        logCustomerVpsError(`recovery create action refresh failed actionId=${actionId}`, err);
      }
      if (attempt + 1 < RECOVERY_CREATE_ACTION_POLL_ATTEMPTS) {
        await sleep(RECOVERY_CREATE_ACTION_POLL_INTERVAL_MS);
      }
    }
    return 'pending';
  }

  async function waitForProvisioningCreateAction(actionId: number): Promise<'success' | 'error' | 'pending'> {
    for (let attempt = 0; attempt < PROVISIONING_CREATE_ACTION_POLL_ATTEMPTS; attempt += 1) {
      let action;
      try {
        action = await deps.hetzner.getAction(actionId);
      } catch (err: unknown) {
        logCustomerVpsError(`provision create action refresh failed actionId=${actionId}`, err);
        return 'pending';
      }
      if (action?.status === 'success') return 'success';
      if (action?.status === 'error') return 'error';
      if (attempt + 1 < PROVISIONING_CREATE_ACTION_POLL_ATTEMPTS) {
        await sleep(PROVISIONING_CREATE_ACTION_POLL_INTERVAL_MS);
      }
    }
    return 'pending';
  }

  async function removeRejectedRecoveryServer(input: {
    serverId: number;
    machineId: string;
    handle: string;
  }): Promise<boolean> {
    try {
      await deps.hetzner.deleteServer(input.serverId);
      if (await deps.hetzner.getServer(input.serverId)) {
        const err = new Error('Recovery server deletion has not completed');
        await queueProviderDeletion({
          providerServerId: input.serverId,
          reason: 'rejected_snapshot_recovery_clone',
          machineId: input.machineId,
          handle: input.handle,
          err,
        });
        return false;
      }
      return true;
    } catch (err: unknown) {
      logCustomerVpsError('rejected snapshot recovery clone cleanup failed', err);
      await queueProviderDeletion({
        providerServerId: input.serverId,
        reason: 'rejected_snapshot_recovery_clone',
        machineId: input.machineId,
        handle: input.handle,
        err,
      });
      return false;
    }
  }
  return { waitForServerStatus, waitForRuntimeHealth, queueProviderDeletion,
    waitForRecoveryCreateAction, waitForProvisioningCreateAction, removeRejectedRecoveryServer };
}
