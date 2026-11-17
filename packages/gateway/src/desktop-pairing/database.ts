import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";

export interface DesktopPairingDatabase {
  desktop_pairings: {
    owner_id: string;
    machine_id: string;
    device_id: string | null;
    public_key: string | null;
    revision: ColumnType<string | number | bigint, number, number>;
  };
}

interface Scope {
  ownerId: string;
  machineId: string;
}

export class DesktopPairingRepository {
  constructor(private readonly db: Kysely<DesktopPairingDatabase>, private readonly scope: Scope) {}

  private bounded<T>(run: (tx: Transaction<DesktopPairingDatabase>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async tx => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(tx);
      await sql`SET LOCAL statement_timeout = '5s'`.execute(tx);
      return run(tx);
    });
  }

  bootstrap(): Promise<void> {
    return this.bounded(async tx => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('desktop_pairings_v1'))`.execute(tx);
      await sql`
        CREATE TABLE IF NOT EXISTS desktop_pairings (
          owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256 AND owner_id ~ '^[A-Za-z0-9_-]+$'),
          machine_id UUID NOT NULL,
          device_id TEXT CHECK (device_id ~ '^[0-9a-f]{64}$'),
          public_key TEXT CHECK (public_key ~ '^[A-Za-z0-9_-]{59}$'),
          revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
          PRIMARY KEY (owner_id, machine_id),
          CHECK ((device_id IS NULL) = (public_key IS NULL))
        )
      `.execute(tx);
    });
  }

  async read() {
    const row = await this.bounded(tx => tx.selectFrom("desktop_pairings")
      .select(["device_id", "revision"])
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .executeTakeFirst());
    return {
      machineId: this.scope.machineId,
      deviceId: row?.device_id ?? null,
      revision: row ? Number(row.revision) : 0,
    };
  }

  async readRegisteredKey(deviceId: string, revision: number) {
    const row = await this.bounded(tx => tx.selectFrom("desktop_pairings")
      .select("public_key")
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revision", "=", revision)
      .executeTakeFirst());
    return row?.public_key ?? null;
  }

  async pair(deviceId: string, publicKey: string, revision: number) {
    const nextRevision = revision + 1;
    if (!Number.isSafeInteger(nextRevision)) return null;
    const values = { device_id: deviceId, public_key: publicKey, revision: nextRevision };
    const row = await this.bounded(tx => revision === 0
      ? tx.insertInto("desktop_pairings").values({
        owner_id: this.scope.ownerId,
        machine_id: this.scope.machineId,
        ...values,
      }).onConflict(conflict => conflict.columns(["owner_id", "machine_id"]).doNothing())
        .returning("revision").executeTakeFirst()
      : tx.updateTable("desktop_pairings").set(values)
        .where("owner_id", "=", this.scope.ownerId)
        .where("machine_id", "=", this.scope.machineId)
        .where("device_id", "is", null)
        .where("revision", "=", revision)
        .returning("revision").executeTakeFirst());
    return row ? { machineId: this.scope.machineId, deviceId, revision: Number(row.revision) } : null;
  }

  async revoke(deviceId: string, revision: number) {
    const nextRevision = revision + 1;
    if (!Number.isSafeInteger(nextRevision)) return null;
    const row = await this.bounded(tx => tx.updateTable("desktop_pairings")
      .set({ device_id: null, public_key: null, revision: nextRevision })
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revision", "=", revision)
      .returning("revision").executeTakeFirst());
    return row ? { machineId: this.scope.machineId, deviceId: null, revision: Number(row.revision) } : null;
  }
}
