/** Shared customer VPS service context, split from customer-vps.ts. */
import { randomUUID, randomBytes } from 'node:crypto';
import type { PlatformDB } from './db.js';
import { insertProviderDeletion } from './db.js';
import { createRegistrationToken } from './customer-vps-auth.js';
import { CustomerVpsError, logCustomerVpsError } from './customer-vps-errors.js';
import { insertProvisioningJob } from './customer-vps-provisioning-jobs.js';
import type { CustomerVpsServiceDeps } from './customer-vps-types.js';
import { MAX_LOCAL_PROVISION_LOCKS, MAX_LOCAL_PROVISION_QUEUE_DEPTH } from './customer-vps-support.js';

/**
 * Per-service state shared by the customer VPS provisioning, dispatch, and
 * recovery factories. Each createCustomerVpsService call builds one context,
 * so the local provisioning lock map is never shared across instances.
 */
export function createCustomerVpsContext(deps: CustomerVpsServiceDeps) {
  const machineIdFactory = deps.machineIdFactory ?? randomUUID;
  const provisioningJobIdFactory = deps.provisioningJobIdFactory ?? randomUUID;
  const localProvisionLocks = new Map<string, { tail: Promise<void>; depth: number }>();

  async function withLocalProvisionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let lock = localProvisionLocks.get(key);
    if (!lock) {
      if (localProvisionLocks.size >= MAX_LOCAL_PROVISION_LOCKS) {
        throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
      }
      lock = { tail: Promise.resolve(), depth: 0 };
      localProvisionLocks.set(key, lock);
    }
    if (lock.depth >= MAX_LOCAL_PROVISION_QUEUE_DEPTH) {
      throw new CustomerVpsError(429, 'provider_unavailable', 'Try again later');
    }

    const predecessor = lock.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    lock.tail = predecessor.then(() => gate);
    lock.depth += 1;
    await predecessor;
    try {
      return await fn();
    } finally {
      release();
      lock.depth -= 1;
      if (lock.depth === 0 && localProvisionLocks.get(key) === lock) {
        localProvisionLocks.delete(key);
      }
    }
  }
  const enqueueProvisioningJob = deps.enqueueProvisioningJob ?? insertProvisioningJob;
  const scheduleProvisioningDispatch = deps.scheduleProvisioningDispatch
    ?? ((dispatch: () => Promise<void>) => queueMicrotask(() => { void dispatch(); }));
  const tokenFactory = deps.tokenFactory ?? createRegistrationToken;
  const postgresPasswordFactory = deps.postgresPasswordFactory ?? (() => randomBytes(24).toString('base64url'));
  const now = deps.now ?? (() => new Date());

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

  // Enqueues a provider-server deletion on the given transaction-or-db handle.
  // Unlike queueProviderDeletion, this propagates insert failures so a caller
  // can keep the status change and the deletion enqueue in one atomic unit —
  // if the enqueue fails the whole transaction rolls back and the machine is
  // retried on the next reconciler pass instead of orphaning its server.
  async function enqueueProviderDeletionTx(
    handle: PlatformDB,
    input: {
      providerServerId: number;
      reason: string;
      machineId?: string | null;
      handle?: string | null;
      detail: string;
    },
  ): Promise<string> {
    const currentTime = now().toISOString();
    const deletionId = randomUUID();
    await insertProviderDeletion(handle, {
      id: deletionId,
      providerServerId: input.providerServerId,
      reason: input.reason,
      machineId: input.machineId ?? null,
      handle: input.handle ?? null,
      nextAttemptAt: currentTime,
      createdAt: currentTime,
      lastError: input.detail,
    });
    return deletionId;
  }

  return {
    deps,
    machineIdFactory,
    provisioningJobIdFactory,
    withLocalProvisionLock,
    enqueueProvisioningJob,
    scheduleProvisioningDispatch,
    tokenFactory,
    postgresPasswordFactory,
    now,
    queueProviderDeletion,
    enqueueProviderDeletionTx,
  };
}

export type CustomerVpsContext = ReturnType<typeof createCustomerVpsContext>;
