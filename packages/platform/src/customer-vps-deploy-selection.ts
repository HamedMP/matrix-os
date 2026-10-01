import type { UserMachineRecord } from './db.js';
import type { DeployTarget } from './customer-vps.js';

export function selectCustomerVpsDeployMachines<
  T extends Pick<UserMachineRecord, 'handle' | 'provisioningClass'>,
>(
  runningMachines: readonly T[],
  target?: DeployTarget,
): T[] {
  // A Private Preview changes code only through its owner's explicit update (spec 537).
  if (target?.handle) {
    return runningMachines.filter((machine) => machine.handle === target.handle
      && machine.provisioningClass !== 'private-preview');
  }
  // Previews run pinned PR bundles; only an explicit handle target updates them.
  return runningMachines.filter((machine) => machine.provisioningClass === 'customer');
}
