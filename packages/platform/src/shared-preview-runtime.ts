import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { getRunningUserMachineByHandle, lockUserMachineProvisioning, type PlatformDB, type UserMachineRecord } from './db.js';
import { mapUserMachine, toUserMachineRow } from './database/user-machine-records.js';

export interface SharedPreviewRuntimeBindingTable {
  machine_id: string;
  owner_id: string;
  source_pr: number;
  worker_origin: string;
  created_at: string;
}
const Owner = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const Registration = z.object({
  ownerId: Owner,
  sourcePr: z.number().int().min(1).max(999_999_999),
  workerOrigin: z.string().min(10).max(2048).refine(raw => {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && url.pathname === '/' && !url.search && !url.hash && raw === url.origin;
    } catch (error: unknown) { if (error instanceof TypeError) return false; throw error; }
  }),
}).strict();
const unavailable = () => new Error('Shared runtime registration unavailable');

async function registeredRuntime(trx: PlatformDB, value: z.infer<typeof Registration>, handle: string): Promise<UserMachineRecord | undefined> {
  const prior = await trx.executor.selectFrom('shared_preview_runtime_bindings').selectAll()
    .where('owner_id', '=', value.ownerId).where('source_pr', '=', value.sourcePr).executeTakeFirst();
  if (prior) {
    const machine = await trx.executor.selectFrom('user_machines').selectAll()
      .where('machine_id', '=', prior.machine_id).forUpdate().executeTakeFirst();
    if (!machine || prior.worker_origin !== value.workerOrigin || machine.deleted_at !== null
      || machine.provisioning_class !== 'shared-preview' || machine.clerk_user_id !== value.ownerId
      || machine.source_pr !== value.sourcePr || machine.handle !== handle || machine.runtime_slot !== handle
      || machine.status !== 'running' || machine.activation_state !== 'authorized') throw unavailable();
    return mapUserMachine(machine);
  }
  return undefined;
}

/** Trusted operator only. No policy/credit grant and no customer/VPS mutation. */
export async function registerSharedPreviewRuntime(db: PlatformDB, input: z.input<typeof Registration>): Promise<UserMachineRecord> {
  const value = Registration.parse(input);
  const suffix = createHash('sha256').update(value.ownerId).digest('hex').slice(0, 8);
  const handle = `swp-${value.sourcePr}-${suffix}`;
  await db.ready;
  return db.transaction(async trx => {
    await lockUserMachineProvisioning(trx, value.ownerId);
    const prior = await registeredRuntime(trx, value, handle);
    if (prior) return prior;
    const now = new Date().toISOString();
    const machine = await trx.executor.insertInto('user_machines').values(toUserMachineRow({
      machineId: randomUUID(), clerkUserId: value.ownerId, handle, runtimeSlot: handle,
      provisioningClass: 'shared-preview', sourcePr: value.sourcePr, status: 'running',
      activationState: 'authorized', provisionedAt: now,
    })).onConflict(oc => oc.columns(['clerk_user_id', 'source_pr'])
      .where('provisioning_class', '=', 'shared-preview').where('deleted_at', 'is', null).doNothing())
      .returningAll().executeTakeFirst();
    if (!machine) {
      // A concurrent identical registration may have committed after our first
      // read. Only its complete, matching binding is reusable, never a bare row.
      const concurrent = await registeredRuntime(trx, value, handle);
      if (concurrent) return concurrent;
      throw unavailable();
    }
    await trx.executor.insertInto('shared_preview_runtime_bindings').values({
      machine_id: machine.machine_id, owner_id: value.ownerId, source_pr: value.sourcePr,
      worker_origin: value.workerOrigin, created_at: now,
    }).execute();
    return mapUserMachine(machine);
  });
}

/** Existing funded auth can resolve logical Workers; personal/VPS readers cannot. */
export async function resolveFundedRuntimeMachine(db: PlatformDB, handle: string, runtimeSlot?: string): Promise<UserMachineRecord | undefined> {
  const legacy = await getRunningUserMachineByHandle(db, handle, runtimeSlot);
  if (legacy) return legacy;
  await db.ready;
  let query = db.executor.selectFrom('user_machines as machine')
    .innerJoin('shared_preview_runtime_bindings as binding', join => join
      .onRef('binding.machine_id', '=', 'machine.machine_id')
      .onRef('binding.owner_id', '=', 'machine.clerk_user_id')
      .onRef('binding.source_pr', '=', 'machine.source_pr'))
    .selectAll('machine').where('machine.provisioning_class', '=', 'shared-preview')
    .where('machine.handle', '=', handle)
    .where('machine.status', '=', 'running').where('machine.activation_state', '=', 'authorized')
    .where('machine.deleted_at', 'is', null);
  if (runtimeSlot !== undefined) query = query.where('machine.runtime_slot', '=', runtimeSlot);
  const row = await query.executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}
