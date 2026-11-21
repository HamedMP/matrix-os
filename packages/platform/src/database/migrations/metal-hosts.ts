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
