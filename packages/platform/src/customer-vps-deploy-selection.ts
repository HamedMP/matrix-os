import type { UserMachineRecord } from './db.js';
import type { DeployTarget } from './customer-vps.js';

export function selectCustomerVpsDeployMachines<
  T extends Pick<UserMachineRecord, 'handle' | 'provisioningClass'>,
>(
  runningMachines: readonly T[],
  target?: DeployTarget,
): T[] {
  if (target?.handle) {
    return runningMachines.filter((machine) => machine.handle === target.handle);
  }
  return runningMachines.filter((machine) => machine.provisioningClass !== 'preview');
}
