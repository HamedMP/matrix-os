import type { UserMachineRecord } from './db.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { PREVIEW_RUNTIME_SLOT_PATTERN } from './customer-vps-schema.js';

export function isPreviewMachine(
  machine: Pick<UserMachineRecord, 'handle' | 'runtimeSlot' | 'provisioningClass'>,
): boolean {
  return machine.provisioningClass === 'preview'
    && PREVIEW_RUNTIME_SLOT_PATTERN.test(machine.handle)
    && (machine.runtimeSlot === machine.handle || machine.runtimeSlot === 'preview');
}

export function assertPreviewProvisioningCapacity(
  activeMachines: ReadonlyArray<Pick<UserMachineRecord, 'handle' | 'runtimeSlot' | 'provisioningClass'>>,
  limit: number,
): void {
  const activePreviews = activeMachines.filter(isPreviewMachine).length;
  if (activePreviews >= limit) {
    throw new CustomerVpsError(429, 'quota_exceeded', 'Preview capacity unavailable');
  }
}
