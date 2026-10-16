import type { UserMachineRecord } from './db.js';
import type { PrivatePreviewEligibility } from './private-preview-eligibility.js';

/** Inventory is discoverability, never authority to bypass a fresh selection check. */
export async function canSelectPrivatePreviewComputer(
  machine: UserMachineRecord,
  clerkUserId: string,
  eligibility?: PrivatePreviewEligibility,
): Promise<boolean> {
  return machine.clerkUserId === clerkUserId
    && machine.activationState === 'authorized'
    && Boolean(eligibility && await eligibility(machine));
}
