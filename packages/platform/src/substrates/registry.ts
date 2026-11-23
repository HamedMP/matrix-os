import { SubstrateKindSchema } from '@matrix-os/contracts';
import type {
  RoutableMachine,
  RuntimeSubstrate,
  RuntimeUpstream,
  RuntimeUpstreamTarget,
  SubstrateKind,
} from './types.js';

export type SubstrateLookup =
  | { ok: true; substrate: RuntimeSubstrate }
  | { ok: false; reason: 'substrate_unavailable' };

export type UpstreamResolution =
  | { kind: 'upstream'; upstream: RuntimeUpstream }
  | { kind: 'not_routable' }
  | { kind: 'substrate_unavailable' };

export interface SubstrateRegistry {
  get(kind: string): SubstrateLookup;
  resolveUpstream(machine: RoutableMachine, target: RuntimeUpstreamTarget): UpstreamResolution;
}

const UNAVAILABLE: SubstrateLookup = { ok: false, reason: 'substrate_unavailable' };

/** Substrates with incomplete configuration are left out at startup, so their runtimes resolve as unavailable. */
export function createSubstrateRegistry(substrates: readonly RuntimeSubstrate[]): SubstrateRegistry {
  const byKind: Partial<Record<SubstrateKind, RuntimeSubstrate>> = {};
  for (const substrate of substrates) {
    if (byKind[substrate.kind]) {
      throw new Error(`Duplicate runtime substrate: ${substrate.kind}`);
    }
    byKind[substrate.kind] = substrate;
  }
  Object.freeze(byKind);

  function get(kind: string): SubstrateLookup {
    const parsed = SubstrateKindSchema.safeParse(kind);
    const substrate = parsed.success ? byKind[parsed.data] : undefined;
    return substrate ? { ok: true, substrate } : UNAVAILABLE;
  }

  return {
    get,
    resolveUpstream(machine, target) {
      const lookup = get(machine.substrate);
      if (!lookup.ok) return { kind: 'substrate_unavailable' };
      const upstream = lookup.substrate.resolveUpstream(machine, target);
      return upstream ? { kind: 'upstream', upstream } : { kind: 'not_routable' };
    },
  };
}
