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
  /** Upstream for proxying, or null when the runtime is not routable right now. */
  resolveUpstream(machine: RoutableMachine, target: RuntimeUpstreamTarget): RuntimeUpstream | null;
  ensureRunning(ref: RuntimeRef, signal: AbortSignal): Promise<EnsureRunningResult>;
}
