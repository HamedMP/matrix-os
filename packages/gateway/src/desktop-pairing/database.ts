import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";

export interface DesktopPairingDatabase {
  desktop_pairings: {
    owner_id: string;
    machine_id: string;
    device_id: string | null;
    public_key: string | null;
    revision: ColumnType<string | number | bigint, number, number>;
    // What the paired desktop last reported over the desktop link (spec 2716, D3).
    // Shown only, never used for authorization; cleared whenever the revision moves.
    device_name: string | null;
    device_platform: "darwin" | "linux" | "win32" | null;
    device_arch: "x64" | "arm64" | null;
    device_screenshot: boolean | null;
    last_seen_at: ColumnType<Date | null, Date | null, Date | null>;
  };
}

/** What a paired desktop's own report says about its system (spec 2716). */
export interface DesktopPairingDeviceSystem {
  platform: "darwin" | "linux" | "win32";
  arch: "x64" | "arm64";
  screenshot: boolean;
}
/** A paired desktop's own report: its name, and its system once it reports one (spec 2716). */
export interface DesktopPairingDeviceReport {
  name: string;
  system?: DesktopPairingDeviceSystem | null;
}

// Pair and disconnect move the revision; a new pairing never inherits the old device's report.
const CLEARED_REPORT = {
  device_name: null, device_platform: null, device_arch: null, device_screenshot: null, last_seen_at: null,
} as const;
/** The desktop link writes last-seen at most this often per device. */
export const DESKTOP_LINK_SEEN_INTERVAL_MS = 60_000;

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
      // Spec 2716 (D3): the paired desktop's own report, added in place on existing tables.
      await sql`
        ALTER TABLE desktop_pairings
          ADD COLUMN IF NOT EXISTS device_name TEXT
            CHECK (char_length(device_name) BETWEEN 1 AND 64 AND device_name !~ '[[:cntrl:]]'),
          ADD COLUMN IF NOT EXISTS device_platform TEXT CHECK (device_platform IN ('darwin', 'linux', 'win32')),
          ADD COLUMN IF NOT EXISTS device_arch TEXT CHECK (device_arch IN ('x64', 'arm64')),
          ADD COLUMN IF NOT EXISTS device_screenshot BOOLEAN,
          ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ
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
    const values = { device_id: deviceId, public_key: publicKey, revision: nextRevision, ...CLEARED_REPORT };
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

  /** The paired desktop's last report and when it was last heard, if any (spec 2716). */
  async readReport(deviceId: string, revision: number) {
    const row = await this.bounded(tx => tx.selectFrom("desktop_pairings")
      .select(["device_name", "device_platform", "device_arch", "device_screenshot", "last_seen_at"])
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revision", "=", revision)
      .executeTakeFirst());
    if (!row) return null;
    const { device_name: name, device_platform: platform, device_arch: arch, device_screenshot: screenshot } = row;
    return {
      name,
      system: platform && arch && screenshot !== null ? { platform, arch, screenshot } : null,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    };
  }

  /** Stores what the paired desktop reported on admission; only at exactly its current revision. */
  async describe(deviceId: string, revision: number, report: DesktopPairingDeviceReport, at: Date): Promise<boolean> {
    const row = await this.bounded(tx => tx.updateTable("desktop_pairings")
      .set({
        device_name: report.name, device_platform: report.system?.platform ?? null, device_arch: report.system?.arch ?? null,
        device_screenshot: report.system?.screenshot ?? null, last_seen_at: at,
      })
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revision", "=", revision)
      .returning("revision").executeTakeFirst());
    return row !== undefined;
  }

  /**
   * Records that the paired desktop was heard, at most once a minute: the row
   * is only touched when its last-seen time is older than the interval.
   */
  async touch(deviceId: string, revision: number, at: Date): Promise<void> {
    await this.bounded(tx => tx.updateTable("desktop_pairings")
      .set({ last_seen_at: at })
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revision", "=", revision)
      .where(eb => eb.or([
        eb("last_seen_at", "is", null),
        eb("last_seen_at", "<", new Date(at.getTime() - DESKTOP_LINK_SEEN_INTERVAL_MS)),
      ]))
      .execute());
  }

  async revoke(deviceId: string, revision: number) {
    const nextRevision = revision + 1;
    if (!Number.isSafeInteger(nextRevision)) return null;
    const row = await this.bounded(tx => tx.updateTable("desktop_pairings")
      .set({ device_id: null, public_key: null, revision: nextRevision, ...CLEARED_REPORT })
      .where("owner_id", "=", this.scope.ownerId)
      .where("machine_id", "=", this.scope.machineId)
      .where("device_id", "=", deviceId)
      .where("revision", "=", revision)
      .returning("revision").executeTakeFirst());
    return row ? { machineId: this.scope.machineId, deviceId: null, revision: Number(row.revision) } : null;
  }
}
