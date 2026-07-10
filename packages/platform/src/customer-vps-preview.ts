import type { UserMachineRecord } from './db.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { PREVIEW_RUNTIME_SLOT_PATTERN } from './customer-vps-schema.js';

function isPreviewMachine(machine: Pick<UserMachineRecord, 'handle'>): boolean {
  return PREVIEW_RUNTIME_SLOT_PATTERN.test(machine.handle);
}

export function assertPreviewProvisioningCapacity(
  activeMachines: ReadonlyArray<Pick<UserMachineRecord, 'handle'>>,
  limit: number,
): void {
  const activePreviews = activeMachines.filter(isPreviewMachine).length;
  if (activePreviews >= limit) {
    throw new CustomerVpsError(429, 'quota_exceeded', 'Preview capacity unavailable');
  }
}
