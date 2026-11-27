import { getUserMachine, type PlatformDB } from '../db.js';
import { loadMetalSubstrateConfig } from './metal-config.js';
import { createMetalHostsRepository } from './metal-hosts-repository.js';
import { createMetalHostDirectory, createMetalSubstrate } from './metal-substrate.js';
import { createSubstrateRegistry, type SubstrateRegistry } from './registry.js';
import type { RuntimeRef, RuntimeSubstrate } from './types.js';
import { createVpsSubstrate } from './vps-substrate.js';

/** Substrates whose config is incomplete are left out, so their runtimes resolve as unavailable. */
export function createPlatformSubstrateRegistry(
  db: PlatformDB,
  env: NodeJS.ProcessEnv,
  hooks: { onMetalResumed?: (ref: RuntimeRef) => void } = {},
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
      ...(hooks.onMetalResumed ? { onResumed: hooks.onMetalResumed } : {}),
    }));
  }

  return createSubstrateRegistry(substrates);
}
