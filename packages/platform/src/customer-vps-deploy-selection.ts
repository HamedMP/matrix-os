import type { UserMachineRecord } from './db.js';

interface DeploySelectionTarget {
  handle?: string;
}

export function selectCustomerVpsDeployMachines<
  T extends Pick<UserMachineRecord, 'handle' | 'provisioningClass'>,
>(
  runningMachines: readonly T[],
  target?: DeploySelectionTarget,
): T[] {
  if (target?.handle) {
    return runningMachines.filter((machine) => machine.handle === target.handle);
  }
  return runningMachines.filter((machine) => machine.provisioningClass !== 'preview');
}
