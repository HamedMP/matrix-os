import type { PlatformDB } from './db.js';
import { getUserMachine } from './db.js';
import {
  claimPrivatePreviewRuntimeAccessActivation,
  completePrivatePreviewRuntimeAccessActivation,
  retryPrivatePreviewRuntimeAccessActivation,
} from './customer-vps-provisioning-jobs.js';
import type { PreviewRuntimeAccessActivator } from './preview-runtime-activation.js';

export type PrivatePreviewRuntimeAccessActivationResult =
  | { status: 'ready' }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown };

/**
 * Claims and activates one exact server-authoritative Private Preview runtime.
 * The provisioning job claim makes retries independent of the one-use host
 * registration credential and prevents overlapping reconciliation attempts.
 */
export async function activatePendingPrivatePreviewRuntimeAccess(options: {
  db: PlatformDB;
  machineId: string;
  activate: PreviewRuntimeAccessActivator;
  now: Date;
  staleBefore: string;
}): Promise<PrivatePreviewRuntimeAccessActivationResult> {
  const claimedAt = options.now.toISOString();
  const claimed = await claimPrivatePreviewRuntimeAccessActivation(
    options.db,
    options.machineId,
    claimedAt,
    options.staleBefore,
  );
  if (!claimed) return { status: 'skipped' };

  const machine = await getUserMachine(options.db, options.machineId);
  if (
    !machine
    || machine.provisioningClass !== 'private-preview'
    || machine.status !== 'running'
    || machine.activationState !== 'authorized'
    || machine.deletedAt !== null
  ) {
    await retryPrivatePreviewRuntimeAccessActivation(
      options.db,
      options.machineId,
      claimedAt,
      options.now.toISOString(),
    );
    return { status: 'skipped' };
  }

  try {
    await options.activate({
      ownerId: machine.clerkUserId,
      machineId: machine.machineId,
      runtimeSlot: machine.runtimeSlot,
      expectedRuntimeTokenEpoch: machine.runtimeTokenEpoch,
    });
    const completed = await completePrivatePreviewRuntimeAccessActivation(
      options.db,
      machine.machineId,
      claimedAt,
      options.now.toISOString(),
    );
    return completed ? { status: 'ready' } : { status: 'skipped' };
  } catch (error: unknown) {
    await retryPrivatePreviewRuntimeAccessActivation(
      options.db,
      options.machineId,
      claimedAt,
      options.now.toISOString(),
    );
    return { status: 'failed', error };
  }
}
