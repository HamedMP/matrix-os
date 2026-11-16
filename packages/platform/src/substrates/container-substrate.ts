import type { ContainerLifecycleService } from './container-lifecycle-service.js';
import {
  ContainerProviderError,
  type ContainerProvider,
  type ContainerUnitState,
  type EndpointCredential,
} from './container-provider.js';
import type {
  EnsureRunningResult,
  OnDemandRuntimeSubstrate,
  RoutableMachine,
  SubstrateComputeRecord,
} from './types.js';

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DEFAULT_CREDENTIAL_CACHE_MAX = 1024;
const CREDENTIAL_REFRESH_MS = 5 * 60_000;
const CREDENTIAL_MIN_REMAINING_MS = 30_000;

export type ContainerSubstrateErrorCode = 'stale_generation' | 'needs_recovery';

export class ContainerSubstrateError extends Error {
  constructor(readonly code: ContainerSubstrateErrorCode) {
    super(`container substrate: ${code}`);
    this.name = 'ContainerSubstrateError';
  }
}

export interface ContainerSubstrateDeps {
  lifecycle: ContainerLifecycleService;
  provider: ContainerProvider;
  loadMachine(machineId: string): Promise<RoutableMachine | undefined>;
  endpointHostSuffix: string;
  credentialCacheMax?: number;
  now?: () => Date;
  activity?: { observe(machineId: string): void };
}

const COMPUTE_STATES: Record<ContainerUnitState, SubstrateComputeRecord['state']> = {
  pending: 'starting',
  running: 'running',
  suspending: 'stopping',
  suspended: 'suspended',
  terminating: 'stopping',
  terminated: 'terminated',
  unknown: 'unknown',
};

export function createContainerSubstrate(deps: ContainerSubstrateDeps): OnDemandRuntimeSubstrate {
  const { lifecycle, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const cacheMax = deps.credentialCacheMax ?? DEFAULT_CREDENTIAL_CACHE_MAX;
  /** Endpoint credentials keyed by unit; Map order is recency order. */
  const credentials = new Map<string, EndpointCredential>();
  /** In-flight mint-only refreshes keyed by unit, so concurrent callers share one provider call. */
  const routableMints = new Map<string, Promise<boolean>>();

  function remainingMs(credential: EndpointCredential): number {
    return credential.expiresAt.getTime() - now().getTime();
  }

  function cached(unitId: string): EndpointCredential | null {
    const credential = credentials.get(unitId);
    if (!credential) return null;
    if (remainingMs(credential) <= CREDENTIAL_MIN_REMAINING_MS) {
      credentials.delete(unitId);
      return null;
    }
    return credential;
  }

  function remember(unitId: string, credential: EndpointCredential): void {
    credentials.delete(unitId);
    for (const [key, value] of credentials) {
      if (remainingMs(value) <= CREDENTIAL_MIN_REMAINING_MS) credentials.delete(key);
    }
    while (credentials.size >= cacheMax) {
      const oldest = credentials.keys().next().value;
      if (oldest === undefined) break;
      credentials.delete(oldest);
    }
    credentials.set(unitId, credential);
  }

  function validHost(value: string | null | undefined): string | null {
    if (!value || !HOSTNAME.test(value) || !value.endsWith(deps.endpointHostSuffix)) return null;
    return value;
  }

  /** Checked only after a failed mint, so healthy requests make no extra provider call. */
  async function unitEnded(unitId: string, error: unknown, signal: AbortSignal): Promise<boolean> {
    if (!(error instanceof ContainerProviderError)) return false;
    if (error.code === 'not_found') return true;
    if (error.code !== 'conflict') return false;
    try {
      const unit = await provider.describe(unitId, signal);
      return !unit || unit.state === 'terminated' || unit.state === 'terminating'
        || (unit.expiresAt !== null && unit.expiresAt.getTime() <= now().getTime());
    } catch (describeError: unknown) {
      console.error('[container-substrate] unit describe failed', describeError instanceof Error ? describeError.name : 'Unknown');
      return false;
    }
  }

  async function forget(machineId: string): Promise<void> {
    const machine = await deps.loadMachine(machineId);
    if (machine?.substrateRef) credentials.delete(machine.substrateRef);
  }

  return {
    kind: 'container',
    startsOnDemand: true,

    resolveUpstream(machine, target) {
      if (machine.status !== 'running' || !machine.substrateRef) return null;
      const host = validHost(machine.privateAddress);
      const credential = cached(machine.substrateRef);
      if (!host || !credential) return null;
      const path = target.path.startsWith('/') ? target.path : `/${target.path}`;
      return {
        url: `https://${host}${path}${target.queryString ?? ''}`,
        hostHeader: host,
        tlsServerName: host,
        headers: credential.headers,
      };
    },

    async ensureRunning(ref, signal): Promise<EnsureRunningResult> {
      signal.throwIfAborted();
      const result = await lifecycle.ensureStarted(ref.machineId);
      if (result.state !== 'running') return result;
      const machine = await deps.loadMachine(ref.machineId);
      const unitId = machine?.substrateRef;
      if (!unitId || !validHost(machine.privateAddress)) return { state: 'failed', code: 'needs_recovery' };
      const current = cached(unitId);
      if (current && remainingMs(current) > CREDENTIAL_REFRESH_MS) return result;
      try {
        remember(unitId, await provider.mintEndpointCredential(unitId, signal));
      } catch (error: unknown) {
        console.error('[container-substrate] endpoint credential unavailable', error instanceof Error ? error.name : 'Unknown');
        if (machine.generation !== undefined && await unitEnded(unitId, error, signal)) {
          credentials.delete(unitId);
          await lifecycle.markComputeLost(ref.machineId, machine.generation, unitId);
          return lifecycle.ensureStarted(ref.machineId);
        }
        return { state: 'failed', code: 'provider_unavailable' };
      }
      return result;
    },

    async ensureRoutable(ref, signal): Promise<boolean> {
      const machine = await deps.loadMachine(ref.machineId);
      const unitId = machine?.substrateRef;
      if (!machine || machine.status !== 'running' || !unitId || machine.generation !== ref.generation
        || !validHost(machine.privateAddress)) return false;
      const current = cached(unitId);
      if (current && remainingMs(current) > CREDENTIAL_REFRESH_MS) return true;
      const pending = routableMints.get(unitId);
      if (pending) return pending;
      if (routableMints.size >= cacheMax) return false;
      const mint = (async () => {
        try {
          const credential = await provider.mintEndpointCredential(unitId, signal);
          const after = await deps.loadMachine(ref.machineId);
          // A unit replaced or stopped while minting must not become routable through this credential.
          if (after?.status !== 'running' || after.substrateRef !== unitId || after.generation !== ref.generation) return false;
          remember(unitId, credential);
          return true;
        } catch (error: unknown) {
          console.error('[container-substrate] routable credential unavailable', error instanceof Error ? error.name : 'Unknown');
          return false;
        } finally {
          routableMints.delete(unitId);
        }
      })();
      routableMints.set(unitId, mint);
      return mint;
    },

    async stop(ref, signal) {
      const outcome = await lifecycle.stop(ref.machineId, ref.generation, signal);
      if (outcome === 'stale_generation') throw new ContainerSubstrateError('stale_generation');
      await forget(ref.machineId);
      if (outcome === 'needs_recovery') throw new ContainerSubstrateError('needs_recovery');
    },

    async destroyCompute(ref, signal) {
      const machine = await deps.loadMachine(ref.machineId);
      const outcome = await lifecycle.destroyCompute(ref.machineId, ref.generation, signal);
      if (outcome === 'stale_generation') throw new ContainerSubstrateError('stale_generation');
      if (machine?.substrateRef) credentials.delete(machine.substrateRef);
    },

    recordOwnerActivity(machineId) {
      deps.activity?.observe(machineId);
    },

    async listCompute(signal) {
      const units = await provider.list(signal);
      return units.map(unit => ({
        computeRef: unit.unitId,
        state: COMPUTE_STATES[unit.state],
        createdAt: unit.createdAt ? unit.createdAt.toISOString() : null,
      }));
    },
  };
}
