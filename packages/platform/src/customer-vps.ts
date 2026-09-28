import type { UserMachineRecord } from './db.js';
import {
  claimUserMachineDelete,
  claimRunningUserMachineBillingSuspend,
  claimSuspendedUserMachineBillingResume,
  completeUserMachineBillingResume,
  completeUserMachineBillingSuspend,
  getActiveUserMachineByClerkId,
  getUserMachine,
  listPendingProviderDeletions,
  listAllUserMachines,
  listRunningUserMachines,
  listStaleResizingUserMachines,
  listStaleUserMachines,
  markProviderDeletionCompleted,
  markProviderDeletionFailed,
  runInPlatformTransaction,
  claimRunningUserMachineResize,
  completeUserMachineResize,
  updateUserMachine,
} from './db.js';
import type { HetznerClient } from './customer-vps-hetzner.js';
import { CustomerVpsError, genericProviderError, logCustomerVpsError } from './customer-vps-errors.js';
import { buildVpsMeta } from './customer-vps-r2.js';
import { PreviewProvisionRequestSchema } from './customer-vps-schema.js';
import { selectCustomerVpsDeployMachines } from './customer-vps-deploy-selection.js';
import type {
  StatusResponse,
  DeployResult,
  DeployTarget,
  CustomerVpsService,
  CustomerVpsServiceDeps,
} from './customer-vps-types.js';
import {
  PROVIDER_DELETION_RETRY_BASE_MS,
  PROVIDER_DELETION_RETRY_MAX_MS,
  RESIZE_STATUS_POLL_INTERVAL_MS,
  RESIZE_STATUS_POLL_TIMEOUT_MS,
  BILLING_RUNTIME_HEALTH_POLL_INTERVAL_MS,
  BILLING_RUNTIME_HEALTH_POLL_TIMEOUT_MS,
  statusResponse,
  toFailureCode,
  assertMachineProviderMutationAllowed,
  sleep,
  triggerMachineSystemUpdate,
} from './customer-vps-support.js';
import { createCustomerVpsContext } from './customer-vps-context.js';
import { createCustomerVpsProvisioningDispatcher } from './customer-vps-provisioning-dispatch.js';
import { createCustomerVpsProvisioner } from './customer-vps-provision.js';
import { createCustomerVpsRecovery } from './customer-vps-recovery.js';
import { createCustomerVpsRegistration } from './customer-vps-registration.js';
import { createCustomerVpsPrivatePreviews } from './customer-vps-private-preview.js';

export type {
  ProvisionResponse,
  ProvisionOptions,
  RegisterResponse,
  DeleteResponse,
  RecoverResponse,
  ResizeResponse,
  StatusResponse,
  DeployResult,
  DeployTarget,
  CustomerVpsService,
  CustomerVpsServiceDeps,
} from './customer-vps-types.js';

export function createCustomerVpsService(deps: CustomerVpsServiceDeps): CustomerVpsService {
  const context = createCustomerVpsContext(deps);
  const { withLocalProvisionLock, now, queueProviderDeletion, enqueueProviderDeletionTx } = context;
  let prebillingFallbackReconciler: (() => Promise<unknown>) | undefined;
  const dispatcher = createCustomerVpsProvisioningDispatcher(context);
  const { dispatchProvisioningJobs } = dispatcher;
  const { provision } = createCustomerVpsProvisioner(context, dispatcher);
  const { reconcilePendingRecoveryCreate, recover } = createCustomerVpsRecovery(context);
  const { register } = createCustomerVpsRegistration(context);
  const privatePreviews = createCustomerVpsPrivatePreviews(context, dispatcher);

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

  async function retryProviderDeletions(): Promise<void> {
    const pending = await listPendingProviderDeletions(
      deps.db,
      now().toISOString(),
      deps.config.reconciliationBatchSize,
    );
    for (const deletion of pending) {
      try {
        await deps.hetzner.deleteServer(deletion.providerServerId);
        if (deletion.reason === 'rejected_snapshot_recovery_clone'
          && await deps.hetzner.getServer(deletion.providerServerId)) {
          throw new Error('Provider server deletion has not completed');
        }
        await markProviderDeletionCompleted(deps.db, deletion.id, now().toISOString());
      } catch (err: unknown) {
        const attempts = deletion.attempts + 1;
        const delayMs = Math.min(
          PROVIDER_DELETION_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6),
          PROVIDER_DELETION_RETRY_MAX_MS,
        );
        await markProviderDeletionFailed(
          deps.db,
          deletion.id,
          attempts,
          new Date(now().getTime() + delayMs).toISOString(),
          err instanceof Error ? err.message : String(err),
        );
        logCustomerVpsError(
          `provider deletion retry failed orphanedHetznerServerId=${deletion.providerServerId} reason=${deletion.reason}`,
          err,
        );
      }
    }
  }

  async function cleanupUntrackedServersForMachine(row: UserMachineRecord): Promise<void> {
    if (!deps.hetzner.listServersByLabel) {
      logCustomerVpsError(
        `provider orphan scan unavailable machineId=${row.machineId}`,
        new Error('Hetzner label listing is not configured'),
      );
      return;
    }
    let servers: Awaited<ReturnType<NonNullable<HetznerClient['listServersByLabel']>>>;
    try {
      servers = await deps.hetzner.listServersByLabel(`machine_id=${row.machineId}`);
    } catch (err: unknown) {
      logCustomerVpsError(`provider orphan scan failed machineId=${row.machineId}`, err);
      return;
    }
    for (const server of servers) {
      try {
        await deps.hetzner.deleteServer(server.id);
      } catch (err: unknown) {
        logCustomerVpsError(`provider orphan cleanup failed orphanedHetznerServerId=${server.id}`, err);
        await queueProviderDeletion({
          providerServerId: server.id,
          reason: 'stale_untracked_machine',
          machineId: row.machineId,
          handle: row.handle,
          err,
        });
      }
    }
  }

  async function retryRunningMachineMetadata(): Promise<void> {
    const rows = await listRunningUserMachines(deps.db, deps.config.reconciliationBatchSize);
    for (const row of rows) {
      try {
        await deps.systemStore.writeVpsMeta(buildVpsMeta(row, row.lastSeenAt ?? now().toISOString()));
      } catch (err: unknown) {
        logCustomerVpsError(`write vps-meta retry failed machineId=${row.machineId}`, err);
      }
    }
  }


  return {
    async provision(input, options) {
      return withLocalProvisionLock(
        `${input.clerkUserId}:${input.runtimeSlot ?? 'primary'}`,
        () => provision(input, 'customer', options?.dispatch ?? 'wait'),
      );
    },

    async provisionForCheckout(input, intentId, options) {
      return withLocalProvisionLock(
        `${input.clerkUserId}:${input.runtimeSlot ?? 'primary'}`,
        () => provision(input, 'customer', options?.dispatch ?? 'wait', intentId),
      );
    },

    async provisionPreview(input) {
      const request = PreviewProvisionRequestSchema.parse(input);
      return withLocalProvisionLock(
        `${request.clerkUserId}:${request.runtimeSlot}`,
        () => provision(request, 'preview', 'wait'),
      );
    },

    register,

    recover,

    async startPrivatePreview(input, options) {
      // One owner's starts share a key so the quota check and insert serialize
      // locally; the owner advisory lock covers other platform instances.
      return withLocalProvisionLock(
        `${input.clerkUserId}:private-preview`,
        () => privatePreviews.startPrivatePreview(input, options),
      );
    },

    updatePrivatePreview: privatePreviews.updatePrivatePreview,

    async suspendForBilling(machineId, shouldContinue) {
      if (shouldContinue && !(await shouldContinue())) return;
      const current = await getUserMachine(deps.db, machineId);
      if (!current || current.deletedAt) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (current.status === 'suspended') return;
      if (current.hetznerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
      }
      if (shouldContinue && !(await shouldContinue())) return;
      let claimed = current;
      if (current.status === 'running' || current.status === 'resuming') {
        const transitioned = await claimRunningUserMachineBillingSuspend(
          deps.db,
          current.machineId,
          current.hetznerServerId,
        );
        if (!transitioned) {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
        }
        claimed = transitioned;
      } else if (current.status !== 'suspending') {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
      }
      const providerServerId = claimed.hetznerServerId;
      if (providerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
      }

      const server = await deps.hetzner.getServer(providerServerId);
      if (!server) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
      if (server.status !== 'off') {
        if (shouldContinue && !(await shouldContinue())) return;
        try {
          await deps.hetzner.shutdownServer(providerServerId);
          if (!(await waitForServerStatus(
            providerServerId,
            'off',
            'billing-shutdown',
            shouldContinue,
          ))) return;
        } catch (err: unknown) {
          logCustomerVpsError(`billing graceful shutdown failed machineId=${claimed.machineId}`, err);
          if (shouldContinue && !(await shouldContinue())) return;
          await deps.hetzner.powerOffServer(providerServerId);
          if (!(await waitForServerStatus(
            providerServerId,
            'off',
            'billing-poweroff',
            shouldContinue,
          ))) return;
        }
      }
      if (shouldContinue && !(await shouldContinue())) return;
      const completed = await completeUserMachineBillingSuspend(
        deps.db,
        claimed.machineId,
        providerServerId,
      );
      if (!completed) {
        const latest = await getUserMachine(deps.db, claimed.machineId);
        if (latest?.status !== 'suspended') {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot suspend');
        }
      }
    },

    async resumeForBilling(machineId, shouldContinue) {
      if (shouldContinue && !(await shouldContinue())) return;
      const current = await getUserMachine(deps.db, machineId);
      if (!current || current.deletedAt) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (current.status === 'running') return;
      if (current.hetznerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
      }
      if (shouldContinue && !(await shouldContinue())) return;
      let claimed = current;
      if (current.status === 'suspended' || current.status === 'suspending') {
        const transitioned = await claimSuspendedUserMachineBillingResume(
          deps.db,
          current.machineId,
          current.hetznerServerId,
        );
        if (!transitioned) {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
        }
        claimed = transitioned;
      } else if (current.status !== 'resuming') {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
      }
      const providerServerId = claimed.hetznerServerId;
      if (providerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
      }

      const server = await deps.hetzner.getServer(providerServerId);
      if (!server) {
        throw new CustomerVpsError(500, 'provider_unavailable', 'Provisioning provider unavailable');
      }
      if (server.status !== 'running') {
        if (shouldContinue && !(await shouldContinue())) return;
        await deps.hetzner.powerOnServer(providerServerId);
        if (!(await waitForServerStatus(
          providerServerId,
          'running',
          'billing-poweron',
          shouldContinue,
        ))) return;
      }
      if (!(await waitForRuntimeHealth(claimed, shouldContinue))) return;
      if (shouldContinue && !(await shouldContinue())) return;
      const completed = await completeUserMachineBillingResume(
        deps.db,
        claimed.machineId,
        providerServerId,
      );
      if (!completed) {
        const latest = await getUserMachine(deps.db, claimed.machineId);
        if (latest?.status !== 'running') {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resume');
        }
      }
    },

    async resize(input) {
      const row = await getUserMachine(deps.db, input.machineId);
      if (!row || row.deletedAt) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (row.status !== 'running' || row.hetznerServerId === null) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resize');
      }
      if (row.serverType === input.serverType) {
        return {
          machineId: row.machineId,
          serverType: input.serverType,
          status: 'running',
        };
      }

      await assertMachineProviderMutationAllowed(deps, row, input.serverType, now());
      const claimed = await claimRunningUserMachineResize(
        deps.db,
        row.machineId,
        row.hetznerServerId,
        now().toISOString(),
        input.serverType,
      );
      if (!claimed) {
        throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resize');
      }

      let serverConfirmedOff = false;
      let resizeAccepted = false;
      let powerOffAccepted = false;
      let powerOnAccepted = false;
      try {
        try {
          await deps.hetzner.shutdownServer(claimed.hetznerServerId!);
          await waitForServerStatus(claimed.hetznerServerId!, 'off', 'shutdown');
        } catch (shutdownErr: unknown) {
          logCustomerVpsError(`resize graceful shutdown failed machineId=${claimed.machineId}`, shutdownErr);
          await deps.hetzner.powerOffServer(claimed.hetznerServerId!);
          powerOffAccepted = true;
          await waitForServerStatus(claimed.hetznerServerId!, 'off', 'poweroff');
        }
        serverConfirmedOff = true;
        await deps.hetzner.resizeServer(claimed.hetznerServerId!, {
          serverType: input.serverType,
          upgradeDisk: false,
        });
        resizeAccepted = true;
        await waitForServerStatus(claimed.hetznerServerId!, 'off', 'resize');
        await deps.hetzner.powerOnServer(claimed.hetznerServerId!);
        serverConfirmedOff = false;
        powerOnAccepted = true;
        await waitForServerStatus(claimed.hetznerServerId!, 'running', 'poweron');
        const updated = await completeUserMachineResize(
          deps.db,
          claimed.machineId,
          claimed.hetznerServerId!,
          {
            status: 'running',
            serverType: input.serverType,
            failureCode: null,
            failureAt: null,
            resizeStartedAt: null,
            resizeTargetServerType: null,
          },
        );
        if (!updated) {
          logCustomerVpsError(
            `resize completion lost machineId=${claimed.machineId} hetznerServerId=${claimed.hetznerServerId}`,
            new Error('resizing row no longer matched guarded completion update'),
          );
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot resize');
        }
        return {
          machineId: updated.machineId,
          serverType: updated.serverType ?? input.serverType,
          status: 'running',
        };
      } catch (err: unknown) {
        const mapped = genericProviderError(err);
        if (powerOnAccepted) {
          logCustomerVpsError(
            `resize poweron pending machineId=${claimed.machineId}`,
            new Error('poweron accepted but running status was not confirmed'),
          );
          throw mapped;
        }
        if (powerOffAccepted && !serverConfirmedOff) {
          logCustomerVpsError(
            `resize poweroff pending machineId=${claimed.machineId}`,
            new Error('poweroff accepted but off status was not confirmed'),
          );
          throw mapped;
        }
        if (resizeAccepted && serverConfirmedOff) {
          logCustomerVpsError(
            `resize provider change pending machineId=${claimed.machineId}`,
            new Error('resize accepted but settled off status was not confirmed'),
          );
          throw mapped;
        }
        let restoredRunning = !serverConfirmedOff;
        if (serverConfirmedOff) {
          let rollbackPowerOnAccepted = false;
          try {
            await deps.hetzner.powerOnServer(claimed.hetznerServerId!);
            rollbackPowerOnAccepted = true;
            await waitForServerStatus(claimed.hetznerServerId!, 'running', 'rollback-poweron');
            restoredRunning = true;
          } catch (powerOnErr: unknown) {
            logCustomerVpsError(`resize rollback poweron failed machineId=${claimed.machineId}`, powerOnErr);
            if (rollbackPowerOnAccepted) {
              logCustomerVpsError(
                `resize rollback poweron pending machineId=${claimed.machineId}`,
                new Error('rollback poweron accepted but running status was not confirmed'),
              );
              throw mapped;
            }
          }
        }

        const restored = await completeUserMachineResize(
          deps.db,
          claimed.machineId,
          claimed.hetznerServerId!,
          restoredRunning
            ? {
                status: 'running',
                serverType: resizeAccepted ? input.serverType : row.serverType,
                failureCode: null,
                failureAt: null,
                resizeStartedAt: null,
                resizeTargetServerType: null,
              }
            : {
                status: 'failed',
                serverType: resizeAccepted ? input.serverType : row.serverType,
                failureCode: toFailureCode(err),
                failureAt: now().toISOString(),
                resizeStartedAt: null,
                resizeTargetServerType: null,
              },
        );
        if (!restored) {
          logCustomerVpsError(
            `resize rollback lost machineId=${claimed.machineId} hetznerServerId=${claimed.hetznerServerId}`,
            new Error('resizing row no longer matched guarded rollback update'),
          );
        }
        throw mapped;
      }
    },

    async status(machineId) {
      const row = await getUserMachine(deps.db, machineId);
      if (!row) {
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      return statusResponse(row);
    },

    async delete(machineId) {
      const row = await claimUserMachineDelete(deps.db, machineId, now().toISOString());
      if (!row) {
        const existing = await getUserMachine(deps.db, machineId);
        if (existing && !existing.deletedAt) {
          throw new CustomerVpsError(409, 'invalid_state', 'Machine cannot delete');
        }
        throw new CustomerVpsError(404, 'not_found', 'Machine not found');
      }
      if (row.hetznerServerId) {
        try {
          await deps.hetzner.deleteServer(row.hetznerServerId);
        } catch (err: unknown) {
          logCustomerVpsError('delete server cleanup failed', err);
          await queueProviderDeletion({
            providerServerId: row.hetznerServerId,
            reason: 'delete',
            machineId,
            handle: row.handle,
            err,
          });
        }
      }
      return { deleted: true, machineId, status: 'deleted' };
    },

    async listAllMachines(): Promise<StatusResponse[]> {
      const machines = await listAllUserMachines(deps.db, 500);
      return machines.map(statusResponse);
    },

    dispatchProvisioningJobs,
    setPrebillingFallbackReconciler(reconcile) { prebillingFallbackReconciler = reconcile; },

    async deploy(target?: DeployTarget): Promise<DeployResult> {
      const runningMachines = await listRunningUserMachines(
        deps.db,
        500,
        target?.handle
          ? { handle: target.handle }
          : { provisioningClass: 'customer' },
      );
      const machines = selectCustomerVpsDeployMachines(runningMachines, target);
      const results: DeployResult['results'] = [];
      let triggered = 0;
      let failed = 0;

      await Promise.allSettled(machines.map(async (machine) => {
        if (!machine.publicIPv4) {
          results.push({ machineId: machine.machineId, handle: machine.handle, status: 'failed', error: 'no IP' });
          failed++;
          return;
        }
        const body = target?.version
          ? JSON.stringify({ version: target.version })
          : target?.channel
            ? JSON.stringify({ channel: target.channel })
            : '{}';
        try {
          const res = await triggerMachineSystemUpdate(deps, machine, body);
          if (res.ok) {
            results.push({ machineId: machine.machineId, handle: machine.handle, status: 'triggered' });
            triggered++;
          } else {
            results.push({ machineId: machine.machineId, handle: machine.handle, status: 'failed', error: `HTTP ${res.status}` });
            failed++;
          }
        } catch (err) {
          results.push({ machineId: machine.machineId, handle: machine.handle, status: 'failed', error: (err as Error).message });
          failed++;
        }
      }));

      return { triggered, failed, results };
    },

    async reconcileProvisioning() {
      await dispatchProvisioningJobs();
      await prebillingFallbackReconciler?.();
      const staleBefore = new Date(now().getTime() - deps.config.reconciliationStaleAfterMs).toISOString();
      const rows = await listStaleUserMachines(
        deps.db,
        ['provisioning', 'recovering'],
        staleBefore,
        deps.config.reconciliationBatchSize,
      );
      const resizingRows = await listStaleResizingUserMachines(
        deps.db,
        staleBefore,
        deps.config.reconciliationBatchSize,
      );
      let failed = 0;
      let running = 0;
      for (let row of rows) {
        if (row.status === 'recovering') {
          const recoveryCreate = await reconcilePendingRecoveryCreate(row);
          if (recoveryCreate === 'pending') continue;
          if (recoveryCreate === 'failed') {
            failed += 1;
            continue;
          }
          const refreshed = await getUserMachine(deps.db, row.machineId)
            ?? await getActiveUserMachineByClerkId(deps.db, row.clerkUserId, row.runtimeSlot);
          if (!refreshed) continue;
          row = refreshed;
        }
        if (!row.hetznerServerId) {
          await cleanupUntrackedServersForMachine(row);
          await updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'provider_unavailable',
            failureAt: now().toISOString(),
          });
          failed += 1;
          continue;
        }
        const server = await deps.hetzner.getServer(row.hetznerServerId);
        if (!server) {
          await updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'not_found',
            failureAt: now().toISOString(),
          });
          failed += 1;
          continue;
        }
        // The server booted but the host never called register() before its
        // registration token expired. It can never become routable, so fail it
        // (freeing the slot for retry) and reap the abandoned server.
        if (
          row.registrationTokenExpiresAt &&
          new Date(row.registrationTokenExpiresAt).getTime() < now().getTime()
        ) {
          // Mark failed and enqueue the server for reaping atomically: once the
          // row is `failed` it leaves listStaleUserMachines, so if the enqueue
          // were a separate write that failed, the server would be orphaned
          // forever. Rolling back keeps the row reconcilable next pass.
          const serverId = row.hetznerServerId;
          await runInPlatformTransaction(deps.db, async (trx) => {
            await updateUserMachine(trx, row.machineId, {
              status: 'failed',
              failureCode: 'registration_timeout',
              failureAt: now().toISOString(),
            });
            await enqueueProviderDeletionTx(trx, {
              providerServerId: serverId,
              reason: 'registration_timeout',
              machineId: row.machineId,
              handle: row.handle,
              detail: 'registration token expired before register()',
            });
          });
          failed += 1;
          continue;
        }
        if (server.status === 'running' && server.publicIPv4) {
          // Hetzner "running" only proves the VM booted; the host must call
          // register() before this machine becomes routable.
          await updateUserMachine(deps.db, row.machineId, {
            publicIPv4: server.publicIPv4,
            publicIPv6: server.publicIPv6,
          });
          running += 1;
        }
      }
      for (const row of resizingRows) {
        if (!row.hetznerServerId) {
          await updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'provider_unavailable',
            failureAt: now().toISOString(),
            resizeStartedAt: null,
            resizeTargetServerType: null,
          });
          failed += 1;
          continue;
        }
        const server = await deps.hetzner.getServer(row.hetznerServerId);
        if (!server) {
          await updateUserMachine(deps.db, row.machineId, {
            status: 'failed',
            failureCode: 'not_found',
            failureAt: now().toISOString(),
            resizeStartedAt: null,
            resizeTargetServerType: null,
          });
          failed += 1;
          continue;
        }
        if (server.status === 'off') {
          try {
            await deps.hetzner.powerOnServer(row.hetznerServerId);
            await waitForServerStatus(row.hetznerServerId, 'running', 'reconcile-resize-poweron');
          } catch (err: unknown) {
            logCustomerVpsError(`resize reconcile poweron failed machineId=${row.machineId}`, err);
            continue;
          }
        } else if (server.status !== 'running') {
          logCustomerVpsError(
            `resize reconcile waiting machineId=${row.machineId}`,
            new Error(`server status ${server.status}`),
          );
          continue;
        }
        let latestServer = server.status === 'running' ? server : null;
        if (!latestServer) {
          try {
            latestServer = await deps.hetzner.getServer(row.hetznerServerId);
          } catch (err: unknown) {
            logCustomerVpsError(`resize reconcile server refresh failed machineId=${row.machineId}`, err);
            continue;
          }
        }
        if (!latestServer || latestServer.status !== 'running') {
          continue;
        }
        const targetServerType = row.resizeTargetServerType;
        if (targetServerType && !latestServer.serverType) {
          logCustomerVpsError(
            `resize reconcile missing server type machineId=${row.machineId}`,
            new Error(`target ${targetServerType}`),
          );
          continue;
        }
        if (targetServerType && latestServer.serverType !== targetServerType) {
          const completed = await completeUserMachineResize(
            deps.db,
            row.machineId,
            row.hetznerServerId,
            {
              status: 'running',
              serverType: latestServer.serverType,
              publicIPv4: latestServer.publicIPv4 ?? row.publicIPv4,
              publicIPv6: latestServer.publicIPv6 ?? row.publicIPv6,
              failureCode: 'resize_interrupted',
              failureAt: now().toISOString(),
              resizeStartedAt: null,
              resizeTargetServerType: null,
            },
          );
          if (completed) {
            failed += 1;
          }
          continue;
        }
        const completed = await completeUserMachineResize(
          deps.db,
          row.machineId,
          row.hetznerServerId,
          {
            status: 'running',
            serverType: latestServer.serverType ?? row.resizeTargetServerType ?? row.serverType,
            publicIPv4: latestServer.publicIPv4 ?? row.publicIPv4,
            publicIPv6: latestServer.publicIPv6 ?? row.publicIPv6,
            failureCode: null,
            failureAt: null,
            resizeStartedAt: null,
            resizeTargetServerType: null,
          },
        );
        if (completed) {
          running += 1;
        }
      }
      await retryProviderDeletions();
      await retryRunningMachineMetadata();
      return { checked: rows.length + resizingRows.length, failed, running };
    },
  };
}
