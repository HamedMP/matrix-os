import { isPrivatePreviewMachine } from './customer-vps-preview.js';
import type { UserMachineRecord } from './db.js';
import { PRIVATE_PREVIEW_TTL_MS, type PrivatePreviewMembershipCheck } from './private-preview-access.js';

/** Whether a machine-bearer request may act for a Private Preview owner's personal accounts. */
export type PrivatePreviewEligibility = (machine: UserMachineRecord) => Promise<boolean>;

/**
 * Spec 537 P5: personal Integrations and Custom MCP are available on a Private
 * Preview only while exactly one person can reach it and that person is still
 * an internal member. Every condition is re-checked per request; any doubt,
 * including a membership that cannot be read, denies.
 */
export function createPrivatePreviewEligibility(opts: {
  internalOrganizationId: string | null;
  isMember?: PrivatePreviewMembershipCheck;
  now?: () => Date;
  logError?: (context: string, err: unknown) => void;
}): PrivatePreviewEligibility {
  const now = opts.now ?? (() => new Date());
  return async (machine) => {
    if (!isPrivatePreviewMachine(machine) || machine.status !== 'running' || machine.deletedAt !== null) return false;
    // An unparseable provisioning time cannot prove the machine is within its lifetime.
    const provisionedAt = Date.parse(machine.provisionedAt);
    if (!Number.isFinite(provisionedAt) || provisionedAt + PRIVATE_PREVIEW_TTL_MS <= now().getTime()) return false;
    if (!opts.internalOrganizationId || !opts.isMember) return false;
    try {
      return await opts.isMember(opts.internalOrganizationId, machine.clerkUserId);
    } catch (err: unknown) {
      // Unreadable membership is not membership: fail closed and keep the cause.
      opts.logError?.(`private preview membership check failed machineId=${machine.machineId}`, err);
      return false;
    }
  };
}
