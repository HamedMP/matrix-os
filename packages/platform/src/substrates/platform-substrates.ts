import { getUserMachine, type PlatformDB } from '../db.js';
import { createSubstrateRegistry, type SubstrateRegistry } from './registry.js';
import { createVpsSubstrate } from './vps-substrate.js';

export function createPlatformSubstrateRegistry(db: PlatformDB): SubstrateRegistry {
  return createSubstrateRegistry([
    createVpsSubstrate({ loadMachine: (machineId) => getUserMachine(db, machineId) }),
  ]);
}
