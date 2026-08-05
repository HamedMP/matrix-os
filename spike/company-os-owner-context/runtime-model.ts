import { randomUUID } from "node:crypto";
import { type ColumnType, type Kysely, sql } from "kysely";
import { OwnerRefSchema, type OwnerRef } from "./context-token.js";

type RuntimeStatus = "provisioning" | "running" | "failed" | "suspended" | "deleting";
type RuntimeClass = "production" | "preview";

interface RuntimeRow {
  runtime_id: string;
  owner_type: OwnerRef["type"];
  owner_id: string;
  runtime_slot: string;
  runtime_class: RuntimeClass;
  status: RuntimeStatus;
  provisioning_generation: number;
  deleted_at: string | null;
  created_at: ColumnType<string, string | undefined, never>;
  updated_at: ColumnType<string, string | undefined, string>;
}

interface MembershipRow {
  membership_id: string;
  organization_id: string;
  actor_user_id: string;
  role: "owner" | "admin" | "member" | "guest";
  status: "active" | "revoked";
  membership_version: number;
  policy_version: number;
}

export interface RuntimeDatabase {
  company_os_spike_runtimes: RuntimeRow;
  company_os_spike_memberships: MembershipRow;
}

export async function initializeRuntimeSpikeSchema(db: Kysely<RuntimeDatabase>): Promise<void> {
  await sql`
    CREATE TABLE company_os_spike_runtimes (
      runtime_id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'organization')),
      owner_id TEXT NOT NULL,
      runtime_slot TEXT NOT NULL,
      runtime_class TEXT NOT NULL CHECK (runtime_class IN ('production', 'preview')),
      status TEXT NOT NULL CHECK (status IN ('provisioning', 'running', 'failed', 'suspended', 'deleting')),
      provisioning_generation INTEGER NOT NULL CHECK (provisioning_generation > 0),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (runtime_class <> 'preview' OR owner_type = 'user')
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX company_os_spike_one_active_slot
    ON company_os_spike_runtimes (owner_type, owner_id, runtime_slot)
    WHERE deleted_at IS NULL
  `.execute(db);
  await sql`
    CREATE TABLE company_os_spike_memberships (
      membership_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      membership_version INTEGER NOT NULL,
      policy_version INTEGER NOT NULL,
      UNIQUE (organization_id, actor_user_id)
    )
  `.execute(db);
}

export interface RuntimeRecord {
  runtimeId: string;
  owner: OwnerRef;
  runtimeSlot: string;
  runtimeClass: RuntimeClass;
  status: RuntimeStatus;
  provisioningGeneration: number;
}

function toRuntimeRecord(row: RuntimeRow): RuntimeRecord {
  return {
    runtimeId: row.runtime_id,
    owner: OwnerRefSchema.parse({ type: row.owner_type, id: row.owner_id }),
    runtimeSlot: row.runtime_slot,
    runtimeClass: row.runtime_class,
    status: row.status,
    provisioningGeneration: row.provisioning_generation,
  };
}

export async function ensureRuntime(
  db: Kysely<RuntimeDatabase>,
  input: { owner: OwnerRef; runtimeSlot: string; runtimeClass: RuntimeClass },
): Promise<RuntimeRecord> {
  const owner = OwnerRefSchema.parse(input.owner);
  const runtimeId = `rtm_${randomUUID().replaceAll("-", "")}`;
  const result = await sql<RuntimeRow>`
    INSERT INTO company_os_spike_runtimes
      (runtime_id, owner_type, owner_id, runtime_slot, runtime_class, status, provisioning_generation)
    VALUES
      (${runtimeId}, ${owner.type}, ${owner.id}, ${input.runtimeSlot}, ${input.runtimeClass}, 'provisioning', 1)
    ON CONFLICT (owner_type, owner_id, runtime_slot) WHERE deleted_at IS NULL
    DO UPDATE SET
      status = CASE
        WHEN company_os_spike_runtimes.status = 'failed' THEN 'provisioning'
        ELSE company_os_spike_runtimes.status
      END,
      provisioning_generation = CASE
        WHEN company_os_spike_runtimes.status = 'failed'
          THEN company_os_spike_runtimes.provisioning_generation + 1
        ELSE company_os_spike_runtimes.provisioning_generation
      END,
      updated_at = now()
    RETURNING *
  `.execute(db);
  const row = result.rows[0];
  if (!row) throw new Error("runtime convergence failed");
  return toRuntimeRecord(row);
}

export async function findActiveRuntime(
  db: Kysely<RuntimeDatabase>,
  owner: OwnerRef,
  runtimeSlot: string,
): Promise<RuntimeRecord | null> {
  const parsedOwner = OwnerRefSchema.parse(owner);
  const row = await db
    .selectFrom("company_os_spike_runtimes")
    .selectAll()
    .where("owner_type", "=", parsedOwner.type)
    .where("owner_id", "=", parsedOwner.id)
    .where("runtime_slot", "=", runtimeSlot)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row ? toRuntimeRecord(row) : null;
}
