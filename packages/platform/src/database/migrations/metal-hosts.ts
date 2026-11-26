import { sql, type ColumnType, type Generated } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/**
 * Spec 2691 (ENG-520): Matrix-operated bare-metal hosts that run free-tier VMs
 * through the host agent. Runs before the user-machines step, which adds the
 * `user_machines.metal_host_id` reference to this table. Host agent tokens come
 * from platform configuration and are never stored here.
 */
export async function migrateMetalHosts(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS metal_hosts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CONSTRAINT metal_hosts_name_key UNIQUE,
      api_url TEXT NOT NULL,
      ingress_host TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CONSTRAINT metal_hosts_status_check CHECK (status IN ('active', 'draining', 'down')),
      memory_capacity_mib INTEGER NOT NULL
        CONSTRAINT metal_hosts_memory_capacity_check CHECK (memory_capacity_mib > 0),
      admission_ceiling_mib INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT metal_hosts_admission_ceiling_check
        CHECK (admission_ceiling_mib > 0 AND admission_ceiling_mib <= memory_capacity_mib)
    )
  `.execute(db);
  // Durable intent to destroy a metal VM whose provisioning failed or was
  // abandoned. Keyed by the platform machine and generation, because hostd may
  // hold a VM the platform never learned the id of (create timed out). One open
  // entry per machine generation; the drainer completes it once hostd has no VM.
  await sql`
    CREATE TABLE IF NOT EXISTS metal_vm_deletions (
      id TEXT PRIMARY KEY,
      metal_host_id TEXT NOT NULL CONSTRAINT metal_vm_deletions_metal_host_id_fkey REFERENCES metal_hosts(id),
      machine_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      metal_vm_id TEXT,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error TEXT,
      completed_at TIMESTAMPTZ
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_metal_vm_deletions_open
    ON metal_vm_deletions(machine_id, generation)
    WHERE completed_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_metal_vm_deletions_due
    ON metal_vm_deletions(next_attempt_at)
    WHERE completed_at IS NULL
  `.execute(db);
}

/** Row shape of `metal_vm_deletions`. */
export interface MetalVmDeletionsTable {
  id: string;
  metal_host_id: string;
  machine_id: string;
  generation: number;
  metal_vm_id: string | null;
  reason: string;
  attempts: Generated<number>;
  next_attempt_at: ColumnType<Date, Date | string, Date | string>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  last_error: string | null;
  completed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** Row shape of `metal_hosts`. */
export interface MetalHostsTable {
  id: string;
  name: string;
  api_url: string;
  ingress_host: string;
  status: Generated<string>;
  memory_capacity_mib: number;
  admission_ceiling_mib: number;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}
