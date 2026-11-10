import { getUserMachine, type PlatformDB } from '../db.js';
import { createSubstrateRegistry, type SubstrateRegistry } from './registry.js';
import type { RuntimeSubstrate } from './types.js';
import { createVpsSubstrate } from './vps-substrate.js';

/** `optional` holds substrates built at startup only when their configuration is complete. */
export function createPlatformSubstrateRegistry(
  db: PlatformDB,
  optional: readonly RuntimeSubstrate[] = [],
): SubstrateRegistry {
  return createSubstrateRegistry([
    createVpsSubstrate({ loadMachine: (machineId) => getUserMachine(db, machineId) }),
    ...optional,
  ]);
}
