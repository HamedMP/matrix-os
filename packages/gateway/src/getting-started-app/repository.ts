/**
 * Getting started app points (spec 639) in the owner's Postgres. Each task
 * pays out once per owner: the primary key plus ON CONFLICT DO NOTHING makes
 * concurrent awards from several windows or surfaces record one row. The
 * total is summed from the rows, so there is no counter to drift.
 */
import { Kysely, sql, type ColumnType, type Dialect } from "kysely";
import {
  gettingStartedAppTaskPoints,
  type GettingStartedAppAwardableTaskId,
  type GettingStartedAppAwardResponse,
  type GettingStartedAppProgress,
} from "@matrix-os/contracts";

interface GettingStartedAwardsTable {
  owner_id: string;
  task_id: GettingStartedAppAwardableTaskId;
  points: number;
  silent: boolean;
  awarded_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

interface GettingStartedOwnerStateTable {
  owner_id: string;
  auto_opened_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
  desktop_icon_placed_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
}

interface GettingStartedAppDatabase {
  getting_started_awards: GettingStartedAwardsTable;
  getting_started_owner_state: GettingStartedOwnerStateTable;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class GettingStartedAppRepository {
  readonly kysely: Kysely<GettingStartedAppDatabase>;
  private readonly ownsConnection: boolean;

  constructor(dialectOrKysely: Dialect | Kysely<GettingStartedAppDatabase>) {
    if (dialectOrKysely instanceof Kysely) {
      this.kysely = dialectOrKysely;
      this.ownsConnection = false;
    } else {
      this.kysely = new Kysely<GettingStartedAppDatabase>({ dialect: dialectOrKysely });
      this.ownsConnection = true;
    }
  }

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS getting_started_awards (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
        task_id TEXT NOT NULL CHECK (task_id ~ '^[a-z][a-z0-9-]{1,31}$'),
        points INTEGER NOT NULL CHECK (points BETWEEN 0 AND 1000),
        silent BOOLEAN NOT NULL,
        awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, task_id)
      )
    `.execute(this.kysely);
    await sql`
      CREATE TABLE IF NOT EXISTS getting_started_owner_state (
        owner_id TEXT PRIMARY KEY CHECK (char_length(owner_id) BETWEEN 1 AND 128),
        auto_opened_at TIMESTAMPTZ
      )
    `.execute(this.kysely);
    // Added after the first release of this table; idempotent for existing owners.
    await sql`
      ALTER TABLE getting_started_owner_state ADD COLUMN IF NOT EXISTS desktop_icon_placed_at TIMESTAMPTZ
    `.execute(this.kysely);
  }

  /** Only closes a connection this repository created; the shared owner pool belongs to startup. */
  async destroy(): Promise<void> {
    if (this.ownsConnection) await this.kysely.destroy();
  }

  async progress(ownerId: string): Promise<GettingStartedAppProgress> {
    const rows = await this.kysely
      .selectFrom("getting_started_awards")
      .select(["task_id", "points", "awarded_at"])
      .where("owner_id", "=", ownerId)
      .orderBy("awarded_at")
      .execute();
    return {
      awards: rows.map((row) => ({ taskId: row.task_id, points: row.points, awardedAt: iso(row.awarded_at) })),
      total: rows.reduce((sum, row) => sum + row.points, 0),
    };
  }

  async award(
    ownerId: string,
    taskId: GettingStartedAppAwardableTaskId,
    silent: boolean,
  ): Promise<GettingStartedAppAwardResponse> {
    const inserted = await this.kysely
      .insertInto("getting_started_awards")
      .values({ owner_id: ownerId, task_id: taskId, points: gettingStartedAppTaskPoints(taskId), silent })
      .onConflict((conflict) => conflict.columns(["owner_id", "task_id"]).doNothing())
      .returning("points")
      .executeTakeFirst();
    const progress = await this.progress(ownerId);
    const recorded = progress.awards.find((award) => award.taskId === taskId);
    return { awarded: inserted !== undefined, points: recorded?.points ?? 0, total: progress.total };
  }

  /** True for exactly one caller per owner, so the app opens itself once across Web and Electron. */
  async claimAutoOpen(ownerId: string): Promise<boolean> {
    const claimed = await this.kysely
      .insertInto("getting_started_owner_state")
      .values({ owner_id: ownerId, auto_opened_at: sql`now()` })
      .onConflict((conflict) => conflict.column("owner_id").doUpdateSet({ auto_opened_at: sql`now()` })
        .where("getting_started_owner_state.auto_opened_at", "is", null))
      .returning("owner_id")
      .executeTakeFirst();
    return claimed !== undefined;
  }

  /**
   * Whether a surface has saved the app's icon to this owner's desktop. Placement is
   * recorded only after the save succeeds, so a failed save is retried on the next
   * load, and an icon the owner removes afterwards is never put back.
   */
  async desktopIconPlaced(ownerId: string): Promise<boolean> {
    const row = await this.kysely
      .selectFrom("getting_started_owner_state")
      .select("desktop_icon_placed_at")
      .where("owner_id", "=", ownerId)
      .executeTakeFirst();
    return row?.desktop_icon_placed_at != null;
  }

  /** Idempotent: the first confirmation's time is kept. */
  async markDesktopIconPlaced(ownerId: string): Promise<void> {
    await this.kysely
      .insertInto("getting_started_owner_state")
      .values({ owner_id: ownerId, desktop_icon_placed_at: sql`now()` })
      .onConflict((conflict) => conflict.column("owner_id").doUpdateSet({ desktop_icon_placed_at: sql`now()` })
        .where("getting_started_owner_state.desktop_icon_placed_at", "is", null))
      .execute();
  }
}
