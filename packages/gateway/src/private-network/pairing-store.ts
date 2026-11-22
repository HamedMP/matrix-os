/**
 * Paired machines in the owner's Postgres (spec 2701). One revision per owner
 * guards every pair/remove with compare-and-set inside the write statement,
 * like spec 2698's device pairing. Each machine is identified by its Ed25519
 * public key; re-pairing the same key is idempotent (ON CONFLICT).
 */
import { sql, type ColumnType, type Kysely } from "kysely";

type Timestamp = ColumnType<Date | string, Date | string, Date | string>;

export interface PrivateNetworkPairingStateTable {
  owner_id: string;
  revision: ColumnType<number | string, number, number>;
}

export interface PrivateNetworkMachinesTable {
  owner_id: string;
  machine_id: string;
  public_key: string;
  name: string;
  dns_name: string;
  paired_at: Timestamp;
  updated_at: Timestamp;
}

export interface PrivateNetworkSchemaMigrationsTable {
  version: number;
}

export interface PrivateNetworkDatabase {
  private_network_schema_migrations: PrivateNetworkSchemaMigrationsTable;
  private_network_pairing_state: PrivateNetworkPairingStateTable;
  private_network_machines: PrivateNetworkMachinesTable;
}

export interface PairedMachineRecord {
  machineId: string;
  name: string;
  dnsName: string;
  pairedAt: string;
}

export interface PairingSnapshot {
  revision: number;
  machines: PairedMachineRecord[];
}

export type PairingStoreErrorCode = "stale" | "capacity" | "not_found";

export class PairingStoreError extends Error {
  constructor(readonly code: PairingStoreErrorCode) {
    super(`Pairing ${code}`);
    this.name = "PairingStoreError";
  }
}

/** Idempotent; serialised by an advisory lock so concurrent gateway starts agree. */
export async function bootstrapPrivateNetworkDatabase(db: Kysely<PrivateNetworkDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(270100519)`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS private_network_schema_migrations (version INTEGER PRIMARY KEY)`.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS private_network_pairing_state (
        owner_id TEXT PRIMARY KEY CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
      )
    `.execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS private_network_machines (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        machine_id TEXT NOT NULL CHECK (machine_id ~ '^[a-f0-9]{32}$'),
        public_key TEXT NOT NULL CHECK (char_length(public_key) = 43),
        name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 63),
        dns_name TEXT NOT NULL CHECK (char_length(dns_name) BETWEEN 1 AND 253),
        paired_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, machine_id)
      )
    `.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS private_network_machines_dns ON private_network_machines (owner_id, dns_name)`.execute(trx);
    await sql`INSERT INTO private_network_schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING`.execute(trx);
  });
}

export class PairingStore {
  private readonly maxMachines: number;

  constructor(
    private readonly db: Kysely<PrivateNetworkDatabase>,
    private readonly now: () => Date = () => new Date(),
    options: { maxMachines?: number } = {},
  ) {
    this.maxMachines = options.maxMachines ?? 32;
  }

  async list(ownerId: string): Promise<PairingSnapshot> {
    return this.read(this.db, ownerId);
  }

  async pair(ownerId: string, baseRevision: number, machine: { machineId: string; publicKey: string; name: string; dnsName: string }): Promise<PairingSnapshot> {
    return this.db.transaction().execute(async (trx) => {
      const revision = await this.advance(trx, ownerId, baseRevision);
      // A reinstalled machine keeps its tailnet name but has a new key: replace it.
      await trx.deleteFrom("private_network_machines")
        .where("owner_id", "=", ownerId)
        .where("dns_name", "=", machine.dnsName)
        .where("machine_id", "<>", machine.machineId)
        .execute();
      const others = await trx.selectFrom("private_network_machines")
        .select(sql<string>`count(*)`.as("total"))
        .where("owner_id", "=", ownerId)
        .where("machine_id", "<>", machine.machineId)
        .executeTakeFirstOrThrow();
      if (Number(others.total) >= this.maxMachines) throw new PairingStoreError("capacity");
      const at = this.now();
      await trx.insertInto("private_network_machines")
        .values({ owner_id: ownerId, machine_id: machine.machineId, public_key: machine.publicKey, name: machine.name, dns_name: machine.dnsName, paired_at: at, updated_at: at })
        .onConflict((oc) => oc.columns(["owner_id", "machine_id"]).doUpdateSet({ name: machine.name, dns_name: machine.dnsName, updated_at: at }))
        .execute();
      return { ...(await this.read(trx, ownerId)), revision };
    });
  }

  async remove(ownerId: string, machineId: string, baseRevision: number): Promise<PairingSnapshot> {
    return this.db.transaction().execute(async (trx) => {
      const revision = await this.advance(trx, ownerId, baseRevision);
      const deleted = await trx.deleteFrom("private_network_machines")
        .where("owner_id", "=", ownerId)
        .where("machine_id", "=", machineId)
        .returning("machine_id")
        .execute();
      if (deleted.length === 0) throw new PairingStoreError("not_found");
      return { ...(await this.read(trx, ownerId)), revision };
    });
  }

  /** Compare-and-set in the UPDATE itself; READ COMMITTED cannot lose a concurrent write. */
  private async advance(trx: Kysely<PrivateNetworkDatabase>, ownerId: string, baseRevision: number): Promise<number> {
    await trx.insertInto("private_network_pairing_state").values({ owner_id: ownerId, revision: 0 })
      .onConflict((oc) => oc.column("owner_id").doNothing()).execute();
    const updated = await trx.updateTable("private_network_pairing_state")
      .set({ revision: sql<number>`revision + 1` })
      .where("owner_id", "=", ownerId)
      .where("revision", "=", baseRevision)
      .returning("revision")
      .executeTakeFirst();
    if (!updated) throw new PairingStoreError("stale");
    return Number(updated.revision);
  }

  /**
   * One statement, so the revision and the rows come from the same snapshot even
   * under READ COMMITTED: a concurrent pair/remove cannot pair a new list with
   * an old revision.
   */
  private async read(db: Kysely<PrivateNetworkDatabase>, ownerId: string): Promise<PairingSnapshot> {
    const result = await sql<{ revision: number | string | null; machine_id: string | null; name: string | null; dns_name: string | null; paired_at: Date | string | null }>`
      SELECT
        (SELECT revision FROM private_network_pairing_state WHERE owner_id = ${ownerId}) AS revision,
        m.machine_id, m.name, m.dns_name, m.paired_at
      FROM (SELECT 1) AS one
      LEFT JOIN LATERAL (
        SELECT machine_id, name, dns_name, paired_at
        FROM private_network_machines
        WHERE owner_id = ${ownerId}
        ORDER BY paired_at, machine_id
        LIMIT ${this.maxMachines}
      ) AS m ON true
      ORDER BY m.paired_at, m.machine_id
    `.execute(db);
    const rows = result.rows;
    return {
      revision: Number(rows[0]?.revision ?? 0),
      machines: rows.flatMap((row) => row.machine_id === null || row.name === null || row.dns_name === null || row.paired_at === null
        ? []
        : [{ machineId: row.machine_id, name: row.name, dnsName: row.dns_name, pairedAt: new Date(row.paired_at).toISOString() }]),
    };
  }
}
