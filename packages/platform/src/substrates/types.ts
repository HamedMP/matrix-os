import type { SubstrateKind } from '@matrix-os/contracts';

export type { SubstrateKind };

export interface RuntimeRef {
  machineId: string;
  handle: string;
  runtimeSlot: string;
  generation: number;
}

/** The platform-record fields a substrate may use to locate a runtime. */
export interface RoutableMachine {
  handle: string;
  status: string;
  substrate: SubstrateKind;
  publicIPv4: string | null;
  recoveryOldServerId?: number | null;
  recoveryOldPublicIPv4?: string | null;
  /** Metal substrate: the host that runs this machine's VM. */
  metalHostId?: string | null;
  /** Metal substrate: the hostd VM id. */
  metalVmId?: string | null;
  /** Metal substrate: the selected machine generation. */
  generation?: number;
}

export interface RuntimeUpstreamTarget {
  path: string;
  queryString?: string;
}

export interface RuntimeUpstream {
  /** Built from platform records only, never from request input other than the target path. */
  url: string;
  hostHeader: string;
  tlsServerName?: string;
  /** Extra request headers the upstream requires, such as host ingress auth. Never forwarded from the client. */
  headers?: Readonly<Record<string, string>>;
  /**
   * PEM of an extra CA to trust, in addition to the system roots, when
   * verifying the upstream certificate (self-signed staging hosts).
   * Verification itself is never turned off.
   */
  extraCaPem?: string;
}

export type EnsureRunningFailureCode = 'start_timeout' | 'provider_unavailable' | 'needs_recovery';

export type EnsureRunningResult =
  | { state: 'running' }
  | { state: 'starting' }
  | { state: 'busy' }
  | { state: 'failed'; code: EnsureRunningFailureCode };

export interface RuntimeSubstrate {
  readonly kind: SubstrateKind;
  /** True when a stopped runtime can be started on request. */
  readonly startsOnDemand: boolean;
  /**
   * How long a request waits for an on-demand start before it is answered
   * "waking"; the start itself keeps going. Defaults to the platform's wait.
   */
  readonly requestWaitMs?: number;
  /** Upstream for proxying, or null when the runtime is not routable right now. */
  resolveUpstream(machine: RoutableMachine, target: RuntimeUpstreamTarget): RuntimeUpstream | null;
  ensureRunning(ref: RuntimeRef, signal: AbortSignal): Promise<EnsureRunningResult>;
  /**
   * Called, fire-and-forget, after a wake moved the platform record to
   * running from another state (for example to push managed-feature config
   * to the woken runtime). Must not throw or block.
   */
  onResumed?(ref: RuntimeRef): void;
}

export type StopRuntimeResult =
  | { state: 'stopping' }
  | { state: 'failed'; code: EnsureRunningFailureCode };

/** A substrate whose runtimes sleep when idle and start again on request. */
export interface OnDemandRuntimeSubstrate extends RuntimeSubstrate {
  readonly startsOnDemand: true;
  /** Puts the runtime to sleep; the outcome is read back later from the substrate. */
  stop(ref: RuntimeRef, signal: AbortSignal): Promise<StopRuntimeResult>;
}
