import type { CustomerVpsServiceDeps } from '../customer-vps-types.js';
import { CustomerVpsError } from '../customer-vps-errors.js';
import type { UserMachineRecord } from '../db.js';
import { HOSTD_STOP_TIMEOUT_MS } from './hostd-client.js';

export async function changeMetalBillingState(
  { db, substrates }: Pick<CustomerVpsServiceDeps, 'db' | 'substrates'>,
  machine: UserMachineRecord,
  target: 'suspended' | 'running',
  shouldContinue?: () => Promise<boolean>,
): Promise<void> {
  const { machineId, generation, metalVmId, handle, runtimeSlot } = machine;
  const lookup = substrates?.get(machine.substrate);
  if (!lookup?.ok || !lookup.substrate.powerOff) {
    throw new CustomerVpsError(503, 'provider_unavailable', 'Runtime provider unavailable');
  }
  const { substrate } = lookup;
  const suspend = target === 'suspended';
  const transition = suspend ? 'suspending' : 'resuming';
  const from = suspend ? ['running', 'resuming'] : ['suspended', 'suspending'];
  const conflict = () => new CustomerVpsError(409, 'invalid_state', 'Machine state changed');
  if (!metalVmId || (machine.status !== transition && !from.includes(machine.status))) throw conflict();

  const setStatus = (statuses: string[], status: string) => db.executor.updateTable('user_machines')
    .set({ status, failure_code: null, failure_at: null })
    .where('machine_id', '=', machineId).where('generation', '=', generation)
    .where('substrate', '=', 'metal').where('metal_vm_id', '=', metalVmId)
    .where('status', 'in', statuses).where('deleted_at', 'is', null)
    .returning('machine_id').executeTakeFirst();

  if (shouldContinue && !(await shouldContinue())) return;
  if (!(await setStatus([...from, transition], transition))) throw conflict();
  if (shouldContinue && !(await shouldContinue())) return;
  const ref = { machineId, generation, handle, runtimeSlot };
  const ready = suspend
    ? await lookup.substrate.powerOff(ref, AbortSignal.timeout(HOSTD_STOP_TIMEOUT_MS + 10_000))
    : (await substrate.ensureRunning(ref, AbortSignal.timeout(25_000))).state === 'running';
  if (!ready) throw new CustomerVpsError(503, 'provider_unavailable', 'Runtime provider unavailable');
  if (shouldContinue && !(await shouldContinue())) return;
  if (!(await setStatus([transition], target))) throw conflict();
  if (!suspend) substrate.onResumed?.(ref);
}
