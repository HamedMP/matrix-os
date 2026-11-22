import { insertUserMachine, upsertBillingEntitlement, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';

/**
 * Fixtures for free Matrix AI on metal (spec 2691, ENG-520 Task P7). A free
 * runtime is a metal VM in the primary slot whose owner holds the stored free
 * entitlement; it keeps the `customer` provisioning class like every metal VM.
 */

export const FREE_TEST_HOST_ID = 'host-free-funding';

export async function ensureFreeTestMetalHost(db: PlatformDB): Promise<void> {
  await createMetalHostsRepository(db.kysely).upsert({
    id: FREE_TEST_HOST_ID,
    name: FREE_TEST_HOST_ID,
    apiUrl: 'https://host-free-funding.metal.example.test:8443',
    ingressHost: 'host-free-funding.metal.example.test',
    status: 'active',
    memoryCapacityMib: 131072,
    admissionCeilingMib: 114688,
  });
}

/** Inserts a free metal runtime and stores its owner's free entitlement. */
export async function insertFreeMetalRuntime(db: PlatformDB, input: {
  machineId: string;
  clerkUserId: string;
  handle: string;
  at: Date;
  status?: string;
  freeEntitlement?: boolean;
}): Promise<void> {
  await ensureFreeTestMetalHost(db);
  await insertUserMachine(db, {
    machineId: input.machineId,
    clerkUserId: input.clerkUserId,
    handle: input.handle,
    runtimeSlot: 'primary',
    substrate: 'metal',
    metalHostId: FREE_TEST_HOST_ID,
    status: input.status ?? 'running',
    imageVersion: 'b1',
    provisionedAt: input.at.toISOString(),
    activationState: 'authorized',
  });
  if (input.freeEntitlement !== false) {
    await upsertBillingEntitlement(db, buildFreeEntitlement(input.clerkUserId, input.at));
  }
}
