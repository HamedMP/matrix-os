import {
  buildCustomerVpsProxyUrl,
  isCustomerVpsProxyMachineRoutable,
} from '../profile-routing.js';
import type { EnsureRunningResult, RoutableMachine, RuntimeSubstrate } from './types.js';

export type VpsMachineSnapshot = RoutableMachine & { deletedAt: string | null };

export interface VpsSubstrateDeps {
  loadMachine(machineId: string): Promise<VpsMachineSnapshot | undefined>;
}

/** VPS states that become routable without operator action. */
const SETTLING_STATUSES = new Set(['provisioning', 'recovering', 'resizing']);

export function createVpsSubstrate(deps: VpsSubstrateDeps): RuntimeSubstrate {
  return {
    kind: 'vps',
    startsOnDemand: false,
    resolveUpstream(machine, target) {
      const url = buildCustomerVpsProxyUrl(machine, target.path, target.queryString);
      return url ? { url, hostHeader: `${machine.handle}.matrix-os.com` } : null;
    },
    async ensureRunning(ref, signal): Promise<EnsureRunningResult> {
      signal.throwIfAborted();
      const machine = await deps.loadMachine(ref.machineId);
      signal.throwIfAborted();
      if (!machine || machine.deletedAt) return { state: 'failed', code: 'needs_recovery' };
      if (isCustomerVpsProxyMachineRoutable(machine)) return { state: 'running' };
      if (SETTLING_STATUSES.has(machine.status)) return { state: 'starting' };
      return { state: 'failed', code: 'needs_recovery' };
    },
  };
}
