import { getActiveUserMachineByHandle, type PlatformDB, type UserMachineRecord } from './db.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { PREVIEW_RUNTIME_SLOT_PATTERN } from './customer-vps-schema.js';

export function isPreviewMachine(
  machine: Pick<UserMachineRecord, 'handle' | 'runtimeSlot' | 'provisioningClass'>,
): boolean {
  return machine.provisioningClass === 'preview'
    && PREVIEW_RUNTIME_SLOT_PATTERN.test(machine.handle)
    && (machine.runtimeSlot === machine.handle || machine.runtimeSlot === 'preview');
}

/** Find a preview even when a customer primary machine shares its handle. */
export async function getActivePreviewMachineByHandle(
  db: PlatformDB,
  handle: string,
): Promise<UserMachineRecord | undefined> {
  if (!PREVIEW_RUNTIME_SLOT_PATTERN.test(handle)) return undefined;
  for (const runtimeSlot of [handle, 'preview']) {
    const machine = await getActiveUserMachineByHandle(db, handle, runtimeSlot);
    if (machine && isPreviewMachine(machine)) return machine;
  }
  return undefined;
}

export function canClerkUserAccessMachine(
  machine: Pick<UserMachineRecord, 'clerkUserId' | 'handle' | 'runtimeSlot' | 'provisioningClass' | 'accessClerkUserIds'>,
  clerkUserId: string,
): boolean {
  if (machine.clerkUserId === clerkUserId) return true;
  return isPreviewMachine(machine) && machine.accessClerkUserIds.includes(clerkUserId);
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
