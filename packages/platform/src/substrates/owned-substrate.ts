import { OWNED_MACHINE_HEARTBEAT_FRESH_MS } from '@matrix-os/contracts';
import type { EnsureRunningResult, RoutableMachine, RuntimeSubstrate } from './types.js';

export type OwnedMachineSnapshot = RoutableMachine & { deletedAt: string | null };

export interface OwnedSubstrateDeps {
  hostSuffix: string;
  accessClientId: string;
  accessClientSecret: string;
  loadMachine(machineId: string): Promise<OwnedMachineSnapshot | undefined>;
  now?: () => number;
}

const HOST_LABEL = /^[0-9a-f]{16}$/;

/**
 * Spec 2707: an owned machine is reached only through its Cloudflare tunnel
 * hostname, which comes from platform records and must sit under the
 * configured suffix. A machine without a fresh heartbeat is offline: it is
 * never woken and never proxied to.
 */
export function createOwnedSubstrate(deps: OwnedSubstrateDeps): RuntimeSubstrate {
  const suffix = `.${deps.hostSuffix}`;
  const now = () => deps.now?.() ?? Date.now();

  function online(machine: RoutableMachine): boolean {
    if (machine.status !== 'running' || !machine.lastSeenAt) return false;
    const seen = Date.parse(machine.lastSeenAt);
    return Number.isFinite(seen) && now() - seen <= OWNED_MACHINE_HEARTBEAT_FRESH_MS;
  }

  function hostname(machine: RoutableMachine): string | null {
    const host = machine.privateAddress;
    if (!host || !host.endsWith(suffix)) return null;
    return HOST_LABEL.test(host.slice(0, -suffix.length)) ? host : null;
  }

  return {
    kind: 'owned',
    startsOnDemand: false,
    resolveUpstream(machine, target) {
      const host = hostname(machine);
      if (!host || !online(machine) || !target.path.startsWith('/')) return null;
      const url = new URL(`https://${host}`);
      url.pathname = target.path;
      url.search = target.queryString ?? '';
      if (url.host !== host) return null;
      return {
        url: url.toString(),
        hostHeader: host,
        tlsServerName: host,
        headers: { 'cf-access-client-id': deps.accessClientId, 'cf-access-client-secret': deps.accessClientSecret },
      };
    },
    async ensureRunning(ref, signal): Promise<EnsureRunningResult> {
      signal.throwIfAborted();
      const machine = await deps.loadMachine(ref.machineId);
      signal.throwIfAborted();
      if (!machine || machine.deletedAt) return { state: 'failed', code: 'needs_recovery' };
      if (machine.status === 'enrolling') return { state: 'starting' };
      return hostname(machine) && online(machine) ? { state: 'running' } : { state: 'failed', code: 'offline' };
    },
  };
}

export function isOwnedMachineOffline(machine: RoutableMachine, substrate: RuntimeSubstrate | undefined): boolean {
  return machine.substrate === 'owned' && (!substrate || substrate.resolveUpstream(machine, { path: '/' }) === null);
}
