import type { RuntimeState, SubstrateKind } from '@matrix-os/contracts';
import { getActiveUserMachineByClerkId } from '../database/user-machines.js';
import type { PlatformDB, UserMachineRecord } from '../db.js';

/**
 * The client-facing state of a container runtime. A stopped runtime is
 * `ready`: the first authenticated owner request wakes it, so clients open it
 * as usual and see `waking` only while compute is starting.
 */
export function containerRuntimeState(machine: { status: string; failureCode: string | null }): RuntimeState {
  switch (machine.status) {
    case 'running':
    case 'stopped':
      return 'ready';
    case 'provisioning':
    case 'starting':
    case 'quiescing':
      return 'waking';
    case 'failed_start':
      return machine.failureCode === 'busy' ? 'busy' : 'failed';
    case 'migrating':
      return 'migrating';
    default:
      return 'failed';
  }
}

export interface RuntimeStateProjection {
  substrate: SubstrateKind;
  state: RuntimeState;
}

/** Present only for container runtimes, so VPS responses keep their exact shape. */
export function projectContainerRuntime(machine: Pick<UserMachineRecord, 'substrate' | 'status' | 'failureCode'> | null | undefined):
  RuntimeStateProjection | undefined {
  if (!machine || machine.substrate !== 'container') return undefined;
  return { substrate: 'container', state: containerRuntimeState(machine) };
}

/** The owner's own container runtime in a slot, whatever its status; collaborators never match. */
export async function getOwnContainerRuntime(
  db: PlatformDB,
  clerkUserId: string,
  runtimeSlot: string,
): Promise<UserMachineRecord | undefined> {
  const machine = await getActiveUserMachineByClerkId(db, clerkUserId, runtimeSlot);
  return machine?.substrate === 'container' ? machine : undefined;
}
