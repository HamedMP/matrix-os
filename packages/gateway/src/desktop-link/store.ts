// desktops enrolled with this computer for the Desktop link (spec 2716), in the
// owner's Postgres. One row per device. A removed device keeps its row with
// `revoked_at` set, so its revision keeps rising and an old proof never
// verifies again.
import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { DESKTOP_LINK_MAX_DEVICES, DesktopLinkDeviceInfoSchema, type DesktopLinkDeviceInfo } from "@matrix-os/contracts/desktop-link";

export interface DesktopLinkDatabase {
  desktop_link_devices: {
    owner_id: string;
    machine_id: string;
    device_id: string;
    public_key: string;
    name: string;
    revision: ColumnType<string | number | bigint, number, number>;
    enrolled_at: ColumnType<Date, Date, Date>;
    revoked_at: ColumnType<Date | null, Date | null, Date | null>;
    last_seen_at: ColumnType<Date | null, Date | null, Date | null>;
    /** JSON of DesktopLinkDeviceInfo, as last reported at admission. */
    device_info: string | null;
  };
}

export interface DesktopLinkDeviceRecord {
  deviceId: string;
  name: string;
  revision: number;
  enrolledAt: Date;
  lastSeenAt: Date | null;
  device: DesktopLinkDeviceInfo | null;
}

export type DesktopLinkEnrolResult =
  | { ok: true; device: DesktopLinkDeviceRecord }
  | { ok: false; reason: "already_enrolled" | "too_many" };

interface Scope { ownerId: string; machineId: string }

export class DesktopLinkStore {
  constructor(private readonly db: Kysely<DesktopLinkDatabase>, private readonly scope: Scope) {}

  private bounded<T>(run: (tx: Transaction<DesktopLinkDatabase>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(tx);
      await sql`SET LOCAL statement_timeout = '5s'`.execute(tx);
      return run(tx);
    });
  }

  bootstrap(): Promise<void> {
    return this.bounded(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('desktop_link_devices_v1'))`.execute(tx);
      await sql`
        CREATE TABLE IF NOT EXISTS desktop_link_devices (
          owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256 AND owner_id ~ '^[A-Za-z0-9_-]+$'),
          machine_id UUID NOT NULL,
          device_id TEXT NOT NULL CHECK (device_id ~ '^[0-9a-f]{64}$'),
          public_key TEXT NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{59}$'),
          name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
          revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
          enrolled_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ,
          last_seen_at TIMESTAMPTZ,
          device_info TEXT CHECK (device_info IS NULL OR char_length(device_info) <= 1024),
          PRIMARY KEY (owner_id, machine_id, device_id)
        )
      `.execute(tx);
    });
  }

  private record(row: {
    device_id: string; name: string; revision: string | number | bigint; enrolled_at: Date; last_seen_at: Date | null;
    device_info?: string | null;
  }): DesktopLinkDeviceRecord {
    let device: DesktopLinkDeviceInfo | null = null;
    if (row.device_info) {
      try {
        const parsed = DesktopLinkDeviceInfoSchema.safeParse(JSON.parse(row.device_info));
        device = parsed.success ? parsed.data : null;
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return {
      deviceId: row.device_id,
      name: row.name,
      revision: Number(row.revision),
      enrolledAt: new Date(row.enrolled_at),
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
      device,
    };
  }

  /** Enrolled (not removed) devices, oldest first. */
  async list(): Promise<DesktopLinkDeviceRecord[]> {
    const rows = await this.bounded((tx) => tx.selectFrom("desktop_link_devices")
      .select(["device_id", "name", "revision", "enrolled_at", "last_seen_at", "device_info"])
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("revoked_at", "is", null)
      .orderBy("enrolled_at")
      .limit(DESKTOP_LINK_MAX_DEVICES)
      .execute());
    return rows.map((row) => this.record(row));
  }

  /** The key of an enrolled device at exactly this revision, or null. */
  async readKey(deviceId: string, revision: number): Promise<{ publicKey: string; name: string } | null> {
    const row = await this.bounded((tx) => tx.selectFrom("desktop_link_devices")
      .select(["public_key", "name"])
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revision", "=", revision)
      .where("revoked_at", "is", null)
      .executeTakeFirst());
    return row ? { publicKey: row.public_key, name: row.name } : null;
  }

  /**
   * Enrols a device, or enrols a removed one again with a higher revision.
   * A live enrolment is never replaced: the desktop must be removed first.
   * The cap is checked under a per-owner lock in the same transaction.
   */
  async enrol(input: { deviceId: string; publicKey: string; name: string; now: Date }): Promise<DesktopLinkEnrolResult> {
    return this.bounded(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${this.scope.ownerId}), hashtext(${this.scope.machineId}))`.execute(tx);
      const live = await tx.selectFrom("desktop_link_devices")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("owner_id", "=", this.scope.ownerId)
        .where("machine_id", "=", this.scope.machineId)
        .where("revoked_at", "is", null)
        .where("device_id", "!=", input.deviceId)
        .executeTakeFirstOrThrow();
      if (Number(live.count) >= DESKTOP_LINK_MAX_DEVICES) return { ok: false as const, reason: "too_many" as const };
      const row = await tx.insertInto("desktop_link_devices").values({
        owner_id: this.scope.ownerId,
        machine_id: this.scope.machineId,
        device_id: input.deviceId,
        public_key: input.publicKey,
        name: input.name,
        revision: 1,
        enrolled_at: input.now,
        revoked_at: null,
        last_seen_at: null,
        device_info: null,
      }).onConflict((conflict) => conflict.columns(["owner_id", "machine_id", "device_id"]).doUpdateSet({
        public_key: input.publicKey,
        name: input.name,
        revision: sql`desktop_link_devices.revision + 1`,
        enrolled_at: input.now,
        revoked_at: null,
        last_seen_at: null,
        device_info: null,
      }).where("desktop_link_devices.revoked_at", "is not", null))
        .returning(["device_id", "name", "revision", "enrolled_at", "last_seen_at"])
        .executeTakeFirst();
      return row ? { ok: true as const, device: this.record(row) } : { ok: false as const, reason: "already_enrolled" as const };
    });
  }

  /** Removes a device at exactly this revision. Returns the new revision, or null on a mismatch. */
  async revoke(deviceId: string, revision: number, now: Date): Promise<number | null> {
    if (!Number.isSafeInteger(revision + 1)) return null;
    const row = await this.bounded((tx) => tx.updateTable("desktop_link_devices")
      .set({ revoked_at: now, revision: revision + 1 })
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revision", "=", revision)
      .where("revoked_at", "is", null)
      .returning("revision")
      .executeTakeFirst());
    return row ? Number(row.revision) : null;
  }

  /** What the desktop reported at admission: its OS, CPU and capabilities. */
  async describe(deviceId: string, info: DesktopLinkDeviceInfo): Promise<void> {
    await this.bounded((tx) => tx.updateTable("desktop_link_devices")
      .set({ device_info: JSON.stringify(info) })
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .execute());
  }

  /** Records that a link for this device was admitted or is still alive. */
  async touch(deviceId: string, now: Date): Promise<void> {
    await this.bounded((tx) => tx.updateTable("desktop_link_devices")
      .set({ last_seen_at: now })
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .execute());
  }
}
