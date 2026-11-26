import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import { HostdError, type HostdClient } from './hostd-client.js';
import type { MetalHost, MetalHostsRepository } from './metal-hosts-repository.js';

// Hostd teardown identifies a VM by host, machine and generation, even if
// create timed out before returning the VM ID.
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/**
 * An entry without a VM id is completed on an empty hostd listing only after
 * this long, because hostd may not list a VM it is still creating.
 */
export const METAL_UNLISTED_GRACE_MS = 10 * 60_000;

type Log = (event: string, fields: Record<string, unknown>) => void;
const defaultLog: Log = (event, fields) => console.error(`[metal-vm-deletions] ${event}`, JSON.stringify(fields));

export interface MetalVmDeletionInput {
  metalHostId: string;
  machineId: string;
  generation: number;
  metalVmId: string | null;
  reason: string;
  now: Date;
  /** First attempt time; defaults to now. */
  notBefore?: Date;
  /** The provider explicitly refused the create before allocating a VM. */
  confirmedAbsent?: boolean;
}

/** Enqueue in the caller's transaction so teardown and the status change commit together. */
export async function enqueueMetalVmDeletion(db: PlatformDB, input: MetalVmDeletionInput): Promise<void> {
  await db.ready;
  await db.executor.insertInto('metal_vm_deletions')
    .values({
      id: randomUUID(),
      metal_host_id: input.metalHostId,
      machine_id: input.machineId,
      generation: input.generation,
      metal_vm_id: input.metalVmId,
      reason: input.reason,
      next_attempt_at: (input.notBefore ?? input.now).toISOString(),
      created_at: input.now.toISOString(),
      completed_at: input.confirmedAbsent ? input.now.toISOString() : null,
    })
    .onConflict((oc) => oc.columns(['machine_id', 'generation']).where('completed_at', 'is', null)
      .doUpdateSet({ metal_vm_id: sql`COALESCE(metal_vm_deletions.metal_vm_id, excluded.metal_vm_id)` }))
    .execute();
}

export interface MetalVmDeletionDrainerDeps {
  db: PlatformDB;
  hosts: Pick<MetalHostsRepository, 'get'>;
  clientFor: (host: MetalHost) => HostdClient;
  now?: () => Date;
  batchSize?: number;
  log?: Log;
}

export interface MetalVmDeletionDrainResult {
  completed: number;
  retried: number;
}

class MetalVmNotListedError extends Error {
  constructor() { super('metal VM not listed yet'); this.name = 'MetalVmNotListedError'; }
}

function errorCode(error: unknown): string {
  if (error instanceof MetalVmNotListedError) return 'not_listed';
  if (error instanceof HostdError) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

export function createMetalVmDeletionDrainer(deps: MetalVmDeletionDrainerDeps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;
  const batchSize = Math.min(Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE), MAX_BATCH_SIZE);

  /** Destroys the entry's VM. 'pending' means hostd listed nothing yet for an id-less entry inside the grace period. */
  async function destroy(entry: {
    metal_host_id: string; machine_id: string; generation: number; metal_vm_id: string | null; created_at: Date;
  }, signal?: AbortSignal): Promise<'done' | 'pending'> {
    const host = await deps.hosts.get(entry.metal_host_id);
    if (!host) throw new Error('metal host is not registered');
    const client = deps.clientFor(host);
    const vmIds = new Set<string>();
    if (entry.metal_vm_id) vmIds.add(entry.metal_vm_id);
    for (const vm of await (signal ? client.listVms(signal) : client.listVms())) {
      if (vm.machineId === entry.machine_id && vm.generation === entry.generation) vmIds.add(vm.id);
    }
    if (vmIds.size === 0 && now().getTime() - new Date(entry.created_at).getTime() < METAL_UNLISTED_GRACE_MS) {
      return 'pending';
    }
    for (const vmId of vmIds) {
      try {
        await (signal ? client.destroy(vmId, signal) : client.destroy(vmId));
      } catch (error: unknown) {
        if (error instanceof HostdError && error.code === 'not_found') continue;
        throw error;
      }
    }
    return 'done';
  }

  type Entry = {
    id: string; metal_host_id: string; machine_id: string; generation: number;
    metal_vm_id: string | null; attempts: number; created_at: Date;
  };

  /** Destroys one entry's VM and completes it, or records the failure and backs it off. */
  async function processEntry(entry: Entry, signal?: AbortSignal): Promise<'completed' | 'retried'> {
    try {
      if (await destroy(entry, signal) === 'pending') throw new MetalVmNotListedError();
      await deps.db.executor.updateTable('metal_vm_deletions')
        .set({ completed_at: now().toISOString(), last_error: null })
        .where('id', '=', entry.id)
        .where('completed_at', 'is', null)
        .execute();
      return 'completed';
    } catch (error: unknown) {
      const code = errorCode(error);
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(entry.attempts, 20), MAX_BACKOFF_MS);
      log('metal_vm_destroy_failed', { machineId: entry.machine_id, hostId: entry.metal_host_id, code });
      await deps.db.executor.updateTable('metal_vm_deletions')
        .set({
          attempts: sql`attempts + 1`,
          last_error: code,
          next_attempt_at: new Date(now().getTime() + backoff).toISOString(),
        })
        .where('id', '=', entry.id)
        .where('completed_at', 'is', null)
        .execute();
      return 'retried';
    }
  }

  async function run(entries: Entry[], signal?: AbortSignal): Promise<MetalVmDeletionDrainResult> {
    let completed = 0;
    let retried = 0;
    for (const entry of entries) {
      if (await processEntry(entry, signal) === 'completed') completed += 1;
      else retried += 1;
    }
    return { completed, retried };
  }

  const ENTRY_COLUMNS = ['id', 'metal_host_id', 'machine_id', 'generation', 'metal_vm_id', 'attempts', 'created_at'] as const;

  return {
    async drainOnce(): Promise<MetalVmDeletionDrainResult> {
      await deps.db.ready;
      const due = await deps.db.executor.selectFrom('metal_vm_deletions')
        .select([...ENTRY_COLUMNS])
        .where('completed_at', 'is', null)
        .where('next_attempt_at', '<=', now())
        .orderBy('next_attempt_at')
        .limit(batchSize)
        .execute();
      return run(due);
    },

    /** Tries one machine's open teardowns immediately, leaving failures for the worker. */
    async drainMachine(machineId: string, signal?: AbortSignal): Promise<MetalVmDeletionDrainResult> {
      await deps.db.ready;
      const open = await deps.db.executor.selectFrom('metal_vm_deletions')
        .select([...ENTRY_COLUMNS])
        .where('machine_id', '=', machineId)
        .where('completed_at', 'is', null)
        .orderBy('created_at')
        .limit(batchSize)
        .execute();
      return run(open, signal);
    },
  };
}

export type MetalVmDeletionDrainer = ReturnType<typeof createMetalVmDeletionDrainer>;
