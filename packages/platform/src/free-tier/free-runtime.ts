import { sql, type RawBuilder } from 'kysely';
import type { PlatformDB } from '../db.js';
import { FREE_RUNTIME_SLOT } from './free-entitlement.js';

/**
 * Which runtimes free Matrix AI funding applies to (spec 2691, ENG-520 Task
 * P7). A free runtime is a metal VM in the free slot whose owner holds the
 * stored free entitlement: the same test the metal sleeper uses. Metal VMs
 * keep the `customer` provisioning class, so this, not the class, marks them.
 * A metal VM whose owner is on a paid plan is funded as a paid runtime.
 */

/** SQL that is true when the machine named by `machineIdColumn` is a free metal runtime. */
export function freeMetalMachine(machineIdColumn: string): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM user_machines free_machine
    JOIN billing_entitlements free_entitlement ON free_entitlement.clerk_user_id = free_machine.clerk_user_id
    WHERE free_machine.machine_id = ${sql.ref(machineIdColumn)}
      AND free_machine.substrate = 'metal'
      AND free_machine.runtime_slot = ${FREE_RUNTIME_SLOT}
      AND free_entitlement.source = 'free')`;
}

export async function isFreeMetalRuntime(executor: PlatformDB['executor'], machineId: string): Promise<boolean> {
  const row = await executor.selectFrom('user_machines').select('machine_id')
    .where('machine_id', '=', machineId).where(freeMetalMachine('user_machines.machine_id'))
    .executeTakeFirst();
  return row !== undefined;
}
