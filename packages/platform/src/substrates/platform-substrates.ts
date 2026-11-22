import { getUserMachine, type PlatformDB } from '../db.js';
import { loadMetalSubstrateConfig } from './metal-config.js';
import { createMetalHostsRepository } from './metal-hosts-repository.js';
import { createMetalHostDirectory, createMetalSubstrate } from './metal-substrate.js';
import { createOwnedSubstrate } from './owned-substrate.js';
import { createSubstrateRegistry, type SubstrateRegistry } from './registry.js';
import type { RuntimeRef, RuntimeSubstrate } from './types.js';
import { createVpsSubstrate } from './vps-substrate.js';

export interface PlatformSubstrateOptions {
  onMetalResumed?: (ref: RuntimeRef) => void;
  /** Spec 2707: present only when owned machines are fully configured. */
  owned?: { hostSuffix: string; hostPrefix?: string; access?: { clientId: string; clientSecret: string } | null };
}

/** Substrates whose config is incomplete are left out, so their runtimes resolve as unavailable. */
export function createPlatformSubstrateRegistry(
  db: PlatformDB,
  env: NodeJS.ProcessEnv,
  options: PlatformSubstrateOptions = {},
): SubstrateRegistry {
  const loadMachine = (machineId: string) => getUserMachine(db, machineId);
  const substrates: RuntimeSubstrate[] = [createVpsSubstrate({ loadMachine })];

  const metal = loadMetalSubstrateConfig(env);
  if (metal.enabled) {
    const hosts = createMetalHostDirectory(createMetalHostsRepository(db.kysely));
    hosts.prime().catch((error: unknown) => {
      console.error('[metal-substrate] host cache warm-up failed:', error instanceof Error ? error.name : 'unknown');
    });
    substrates.push(createMetalSubstrate({
      loadMachine,
      hosts,
      apiToken: metal.apiToken,
      ingressToken: metal.ingressToken,
      ...(metal.caPem ? { caPem: metal.caPem } : {}),
      ...(options.onMetalResumed ? { onResumed: options.onMetalResumed } : {}),
    }));
  }
  if (options.owned) substrates.push(createOwnedSubstrate({ ...options.owned, loadMachine }));

  return createSubstrateRegistry(substrates);
}
