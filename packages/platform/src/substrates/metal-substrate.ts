import type { Dispatcher } from 'undici';
import {
  createHostdClient,
  createHostdDispatcher,
  HostdError,
  HOSTD_RESUME_GRACE_MS,
  type HostdClient,
  type HostdClientOptions,
} from './hostd-client.js';
import {
  MetalHostsRepositoryError,
  type MetalHost,
  type MetalHostsRepository,
} from './metal-hosts-repository.js';
import type {
  EnsureRunningFailureCode,
  EnsureRunningResult,
  OnDemandRuntimeSubstrate,
  RoutableMachine,
  RuntimeRef,
  StopRuntimeResult,
} from './types.js';

/**
 * Metal substrate (spec 2691, ENG-520): free-tier VMs on Matrix-operated
 * bare-metal hosts, reached through each host's authenticated ingress and
 * woken through hostd. Routing never targets the VM address; the ingress
 * routes by the handle Host header and never wakes a VM by itself.
 */

export const METAL_RESUME_BUDGET_MS = 8_000;
export const HOST_AUTH_HEADER = 'x-matrix-host-auth';
const DEFAULT_INGRESS_PORT = 443;
const HOST_CACHE_TTL_MS = 60_000;
const HOST_CACHE_MAX_ENTRIES = 256;

export type MetalMachineSnapshot = RoutableMachine & {
  machineId: string;
  generation: number;
  deletedAt: string | null;
};

type Log = (event: string, fields: Record<string, unknown>) => void;
const defaultLog: Log = (event, fields) => console.error(`[metal-substrate] ${event}`, JSON.stringify(fields));

// ---------------------------------------------------------------------------
// Host directory: resolveUpstream is synchronous, so host rows are cached.

export interface MetalHostDirectory {
  /** The cached host, or null. A miss or stale entry refreshes in the background. */
  peek(id: string): MetalHost | null;
  /** The host, read from the registry when not cached fresh. Registry failures throw. */
  load(id: string): Promise<MetalHost | null>;
  /** Warms the cache with every active host. */
  prime(): Promise<void>;
}

export interface MetalHostDirectoryOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  log?: Log;
}

export function createMetalHostDirectory(
  repo: Pick<MetalHostsRepository, 'get' | 'listActive'>,
  options: MetalHostDirectoryOptions = {},
): MetalHostDirectory {
  const ttlMs = options.ttlMs ?? HOST_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? HOST_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog;
  // Insertion-ordered LRU, capped at maxEntries.
  const entries = new Map<string, { host: MetalHost; loadedAt: number }>();
  const inFlight = new Map<string, Promise<MetalHost | null>>();

  function remember(host: MetalHost): void {
    entries.delete(host.id);
    entries.set(host.id, { host, loadedAt: now() });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  function fetchHost(id: string): Promise<MetalHost | null> {
    const pending = inFlight.get(id);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const host = await repo.get(id);
        if (host) remember(host);
        else entries.delete(id);
        return host;
      } catch (error: unknown) {
        if (error instanceof MetalHostsRepositoryError && error.code === 'invalid_host') {
          entries.delete(id);
          return null;
        }
        throw error;
      } finally {
        inFlight.delete(id);
      }
    })();
    if (inFlight.size < maxEntries) inFlight.set(id, promise);
    return promise;
  }

  function refreshInBackground(id: string): void {
    if (inFlight.has(id) || inFlight.size >= maxEntries) return;
    fetchHost(id).catch((error: unknown) => {
      log('host_refresh_failed', { hostId: id, code: error instanceof MetalHostsRepositoryError ? error.code : 'unknown' });
    });
  }

  return {
    peek(id) {
      const entry = entries.get(id);
      if (!entry || now() - entry.loadedAt >= ttlMs) refreshInBackground(id);
      return entry?.host ?? null;
    },
    async load(id) {
      const entry = entries.get(id);
      if (entry && now() - entry.loadedAt < ttlMs) return entry.host;
      try {
        return await fetchHost(id);
      } catch (error: unknown) {
        // A stale row still names the right host while the registry is down.
        if (entry) {
          log('host_registry_unavailable_using_cache', { hostId: id });
          return entry.host;
        }
        throw error;
      }
    },
    async prime() {
      for (const host of await repo.listActive()) remember(host);
    },
  };
}

// ---------------------------------------------------------------------------
// Substrate

export interface MetalSubstrateDeps {
  loadMachine(machineId: string): Promise<MetalMachineSnapshot | undefined>;
  hosts: MetalHostDirectory;
  apiToken: string;
  ingressToken: string;
  /** Extra CA trusted for hostd and ingress certificates (self-signed staging hosts). */
  caPem?: string;
  /** Shared TLS dispatcher for hostd calls; built from caPem when omitted. */
  dispatcher?: Dispatcher;
  clientOptions?: Pick<HostdClientOptions, 'timeoutMs' | 'resumeGraceMs' | 'suspendTimeoutMs'>;
  /** How long a request waits for a resume before being answered "waking"; defaults to the resume budget plus grace. */
  requestWaitMs?: number;
  /** Fire-and-forget hook after a wake records the runtime running again (targeted managed-feature activation). */
  onResumed?: (ref: RuntimeRef) => void;
  log?: Log;
}

type Located =
  | { ok: true; client: HostdClient; vmId: string }
  | { ok: false; code: EnsureRunningFailureCode };

function splitIngress(ingressHost: string): { hostname: string; port: number } {
  const colon = ingressHost.lastIndexOf(':');
  if (colon === -1) return { hostname: ingressHost, port: DEFAULT_INGRESS_PORT };
  return { hostname: ingressHost.slice(0, colon), port: Number(ingressHost.slice(colon + 1)) };
}

function failureForHostd(error: HostdError): EnsureRunningResult {
  switch (error.code) {
    case 'busy':
      return { state: 'busy' };
    case 'conflict':
    case 'not_found':
      return { state: 'failed', code: 'needs_recovery' };
    default:
      return { state: 'failed', code: 'provider_unavailable' };
  }
}

export function createMetalSubstrate(deps: MetalSubstrateDeps): OnDemandRuntimeSubstrate {
  const log = deps.log ?? defaultLog;
  let dispatcher = deps.dispatcher;
  const hostdDispatcher = () => (dispatcher ??= createHostdDispatcher(deps.caPem));
  const upstreamHeaders = Object.freeze({ [HOST_AUTH_HEADER]: deps.ingressToken });

  function logHostdError(event: string, ref: RuntimeRef, error: HostdError): void {
    log(event, { machineId: ref.machineId, code: error.code });
  }

  /** Loads the platform record and host, then checks that hostd runs this exact generation. */
  async function locate(ref: RuntimeRef, signal: AbortSignal): Promise<Located> {
    signal.throwIfAborted();
    const machine = await deps.loadMachine(ref.machineId);
    signal.throwIfAborted();
    if (!machine || machine.deletedAt || machine.substrate !== 'metal') return { ok: false, code: 'needs_recovery' };
    if (!machine.metalHostId || !machine.metalVmId) return { ok: false, code: 'needs_recovery' };
    if (machine.generation !== ref.generation) return { ok: false, code: 'needs_recovery' };

    let host: MetalHost | null;
    try {
      host = await deps.hosts.load(machine.metalHostId);
    } catch (error: unknown) {
      log('host_registry_unavailable', {
        machineId: ref.machineId,
        code: error instanceof MetalHostsRepositoryError ? error.code : 'unknown',
      });
      return { ok: false, code: 'provider_unavailable' };
    }
    signal.throwIfAborted();
    if (!host) return { ok: false, code: 'needs_recovery' };
    if (host.status === 'down') return { ok: false, code: 'provider_unavailable' };

    const client = createHostdClient(host, deps.apiToken, { ...deps.clientOptions, dispatcher: hostdDispatcher() });
    const vm = await client.getVm(machine.metalVmId, signal);
    if (vm.machineId !== ref.machineId || vm.generation !== ref.generation) {
      log('generation_mismatch', { machineId: ref.machineId, expected: ref.generation, actual: vm.generation });
      return { ok: false, code: 'needs_recovery' };
    }
    return { ok: true, client, vmId: vm.id };
  }

  return {
    kind: 'metal',
    startsOnDemand: true,
    requestWaitMs: deps.requestWaitMs ?? METAL_RESUME_BUDGET_MS + HOSTD_RESUME_GRACE_MS,
    ...(deps.onResumed ? { onResumed: deps.onResumed } : {}),

    resolveUpstream(machine, target) {
      if (machine.status !== 'running' || machine.substrate !== 'metal' || !machine.metalHostId) return null;
      const host = deps.hosts.peek(machine.metalHostId);
      if (!host || host.status === 'down') return null;
      const { hostname, port } = splitIngress(host.ingressHost);
      const path = target.path.startsWith('/') ? target.path : `/${target.path}`;
      return {
        url: `https://${hostname}:${port}${path}${target.queryString ?? ''}`,
        hostHeader: `${machine.handle}.matrix-os.com`,
        tlsServerName: hostname,
        headers: upstreamHeaders,
        ...(deps.caPem ? { extraCaPem: deps.caPem } : {}),
      };
    },

    async ensureRunning(ref, signal): Promise<EnsureRunningResult> {
      try {
        const located = await locate(ref, signal);
        if (!located.ok) return { state: 'failed', code: located.code };
        const { state } = await located.client.resume(located.vmId, METAL_RESUME_BUDGET_MS, signal, { expectedGeneration: ref.generation });
        return { state };
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof HostdError) {
          logHostdError('resume_failed', ref, error);
          return failureForHostd(error);
        }
        throw error;
      }
    },

    async stop(ref, signal): Promise<StopRuntimeResult> {
      try {
        const located = await locate(ref, signal);
        if (!located.ok) return { state: 'failed', code: located.code };
        await located.client.suspend(located.vmId, signal, { expectedGeneration: ref.generation });
        return { state: 'stopping' };
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof HostdError) {
          logHostdError('suspend_failed', ref, error);
          const result = failureForHostd(error);
          return result.state === 'failed' ? result : { state: 'failed', code: 'provider_unavailable' };
        }
        throw error;
      }
    },
  };
}
