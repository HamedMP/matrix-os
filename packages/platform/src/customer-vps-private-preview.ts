import { randomBytes } from 'node:crypto';
import {
  getHostBundleRelease,
  getPlatformHandleConflict,
  getUserMachine,
  insertUserMachine,
  lockUserMachineProvisioning,
  runInPlatformTransaction,
  type UserMachineRecord,
} from './db.js';
import {
  confirmPrivatePreviewBundle,
  getActivePrivatePreviewForOwnerPr,
  listActivePrivatePreviewsForOwner,
} from './database/private-previews.js';
import { CustomerVpsError, logCustomerVpsError } from './customer-vps-errors.js';
import { resolveHostBundleRef } from './customer-vps-host-bundle.js';
import { getProvisioningJobByMachineId, sealProvisioningPayload } from './customer-vps-provisioning-jobs.js';
import { activeProvisionResponse, triggerMachineSystemUpdate } from './customer-vps-support.js';
import { defaultDeveloperToolsForServerType } from './developer-tools.js';
import { isPostgresUniqueViolation } from './platform-route-utils.js';
import type { CustomerVpsContext } from './customer-vps-context.js';
import type { CustomerVpsProvisioningDispatcher } from './customer-vps-provisioning-dispatch.js';
import type {
  PrivatePreviewStartInput,
  PrivatePreviewStartResponse,
  PrivatePreviewUpdateInput,
  PrivatePreviewUpdateResponse,
  ProvisionOptions,
} from './customer-vps-types.js';

const HANDLE_ATTEMPTS = 3;
const RACE_LOOKUP_ATTEMPTS = 3;
const RACE_LOOKUP_DELAY_MS = 10;

function bundleUnavailable(): CustomerVpsError {
  return new CustomerVpsError(409, 'invalid_state', 'Bundle not available');
}

function notFound(): CustomerVpsError {
  return new CustomerVpsError(404, 'not_found', 'Not found');
}

/**
 * Spec 537 Private Previews: owner-only machines that run one same-repository
 * PR's bundle. Provisioning is separate from the customer path because none of
 * its billing, prebilling, snapshot, or legacy-slot branches apply here.
 */
export function createCustomerVpsPrivatePreviews(
  context: CustomerVpsContext,
  dispatcher: CustomerVpsProvisioningDispatcher,
) {
  const { deps, machineIdFactory, provisioningJobIdFactory, enqueueProvisioningJob, tokenFactory, postgresPasswordFactory, now } = context;
  const { dispatchProvisioningJobForRequest } = dispatcher;

  async function requirePrBundle(sourcePr: number, bundleVersion: string): Promise<void> {
    const release = await getHostBundleRelease(deps.db, bundleVersion);
    if (!release || release.sourcePr !== sourcePr) throw bundleUnavailable();
  }

  async function unusedHandle(sourcePr: number, clerkUserId: string): Promise<string> {
    for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt += 1) {
      const handle = `pv-${sourcePr}-${randomBytes(4).toString('hex')}`;
      if (!await getPlatformHandleConflict(deps.db, handle, clerkUserId)) return handle;
    }
    throw new CustomerVpsError(503, 'provider_unavailable', 'Private Preview unavailable');
  }

  async function existingResponse(
    machine: UserMachineRecord,
    dispatch: NonNullable<ProvisionOptions['dispatch']>,
  ): Promise<PrivatePreviewStartResponse> {
    if (machine.status === 'failed') {
      // The failed machine keeps its quota slot until its owner destroys it.
      throw new CustomerVpsError(409, 'invalid_state', 'Destroy the failed Private Preview before starting again');
    }
    const response = activeProvisionResponse(machine, deps.config.provisionEtaSeconds);
    const job = await getProvisioningJobByMachineId(deps.db, machine.machineId);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      await dispatchProvisioningJobForRequest(job.jobId, dispatch);
    }
    return { ...response, handle: machine.handle };
  }

  async function startPrivatePreview(
    input: PrivatePreviewStartInput,
    options?: ProvisionOptions,
  ): Promise<PrivatePreviewStartResponse> {
    const dispatch = options?.dispatch ?? 'wait';
    await requirePrBundle(input.sourcePr, input.bundleVersion);
    const existingBefore = await getActivePrivatePreviewForOwnerPr(deps.db, input.clerkUserId, input.sourcePr);
    if (existingBefore) return existingResponse(existingBefore, dispatch);

    const bundleRef = await resolveHostBundleRef(deps.db, deps.config, undefined, input.bundleVersion);
    const handle = await unusedHandle(input.sourcePr, input.clerkUserId);
    const currentTime = now();
    const machineId = machineIdFactory();
    const jobId = provisioningJobIdFactory();
    const registration = tokenFactory(currentTime, deps.config.registrationTokenTtlMs);
    const encryptedPayload = sealProvisioningPayload({
      registrationToken: registration.token,
      postgresPassword: postgresPasswordFactory(),
    }, deps.config.platformSecret);
    const serverType = deps.config.serverType;

    let existing: UserMachineRecord | undefined;
    try {
      existing = await runInPlatformTransaction(deps.db, async (trx) => {
        // The owner lock serializes the quota count, the one-per-PR lookup, and
        // the insert across platform instances.
        await lockUserMachineProvisioning(trx, input.clerkUserId);
        const current = await getActivePrivatePreviewForOwnerPr(trx, input.clerkUserId, input.sourcePr);
        if (current) return current;
        const active = await listActivePrivatePreviewsForOwner(trx, input.clerkUserId);
        if (active.length >= deps.config.privatePreviewLimit) {
          throw new CustomerVpsError(429, 'quota_exceeded', 'Private Preview capacity unavailable');
        }
        await insertUserMachine(trx, {
          machineId,
          clerkUserId: input.clerkUserId,
          handle,
          runtimeSlot: handle,
          provisioningClass: 'private-preview',
          accessClerkUserIds: [],
          sourcePr: input.sourcePr,
          confirmedBundleVersion: input.bundleVersion,
          status: 'provisioning',
          imageVersion: bundleRef.imageVersion,
          serverType,
          location: deps.config.location,
          developerTools: defaultDeveloperToolsForServerType(serverType),
          registrationTokenHash: registration.hash,
          registrationTokenExpiresAt: registration.expiresAt,
          provisionedAt: currentTime.toISOString(),
          attempt: 1,
          activationState: 'authorized',
        });
        await enqueueProvisioningJob(trx, {
          jobId,
          machineId,
          encryptedPayload,
          availableAt: currentTime.toISOString(),
          createdAt: currentTime.toISOString(),
          authorizationBasis: 'billing_entitlement',
          prebillingIntentId: null,
        });
        return undefined;
      });
    } catch (err: unknown) {
      // Another start for the same owner and PR won the race; converge on its
      // machine. Mirrors the customer provisioner's convergence signals.
      const raced = isPostgresUniqueViolation(err)
        || (err instanceof Error && err.message.includes('current transaction is aborted'));
      if (!raced) throw err;
      for (let attempt = 0; attempt < RACE_LOOKUP_ATTEMPTS && !existing; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RACE_LOOKUP_DELAY_MS));
        existing = await getActivePrivatePreviewForOwnerPr(deps.db, input.clerkUserId, input.sourcePr);
      }
      if (!existing) throw err;
    }
    if (existing) return existingResponse(existing, dispatch);

    await dispatchProvisioningJobForRequest(jobId, dispatch);
    return { machineId, handle, status: 'provisioning', etaSeconds: deps.config.provisionEtaSeconds };
  }

  async function updatePrivatePreview(input: PrivatePreviewUpdateInput): Promise<PrivatePreviewUpdateResponse> {
    const machine = await getUserMachine(deps.db, input.machineId);
    if (!machine || machine.deletedAt || machine.provisioningClass !== 'private-preview'
      || machine.clerkUserId !== input.clerkUserId || machine.sourcePr === null) {
      throw notFound();
    }
    await requirePrBundle(machine.sourcePr, input.bundleVersion);
    // Confirm first: the update base then serves only the new version, so an
    // older in-flight trigger can no longer install anything else.
    const confirmed = await confirmPrivatePreviewBundle(deps.db, {
      machineId: machine.machineId,
      clerkUserId: input.clerkUserId,
      bundleVersion: input.bundleVersion,
    });
    if (!confirmed?.publicIPv4) {
      throw new CustomerVpsError(409, 'invalid_state', 'Private Preview is not running');
    }
    let response: Response;
    try {
      response = await triggerMachineSystemUpdate(deps, confirmed, JSON.stringify({ version: input.bundleVersion }));
    } catch (err: unknown) {
      logCustomerVpsError(`private preview update trigger failed machineId=${confirmed.machineId}`, err);
      throw new CustomerVpsError(502, 'provider_unavailable', 'Private Preview update unavailable');
    }
    if (!response.ok) {
      logCustomerVpsError(
        `private preview update trigger rejected machineId=${confirmed.machineId}`,
        new Error(`HTTP ${response.status}`),
      );
      throw new CustomerVpsError(502, 'provider_unavailable', 'Private Preview update unavailable');
    }
    return { machineId: confirmed.machineId, status: 'updating' };
  }

  return { startPrivatePreview, updatePrivatePreview };
}
