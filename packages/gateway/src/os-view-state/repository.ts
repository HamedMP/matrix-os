import {
  Kysely,
  PostgresDialect,
  sql,
  type ColumnType,
  type Dialect,
  type Selectable,
  type Transaction,
} from "kysely";
import pg from "pg";
import {
  LegacyDesktopImportSchema,
  OsViewDocumentSchema,
  PatchOsViewStateRequestSchema,
  createDefaultOsViewDesktopIcons,
  createDefaultOsViewDocument,
  mergeOsViewStatePatch,
  normalizeOsViewDesktopIcons,
  type LegacyDesktopImport,
  type OsViewDocument,
  type OsViewStatePatch,
  type OsViewStateResponse,
  type PatchOsViewStateRequest,
} from "@matrix-os/contracts";

const RECENT_MUTATION_LIMIT = 64;

interface OsViewStatesTable {
  owner_type: "user";
  owner_id: string;
  revision: ColumnType<number, number | undefined, number>;
  schema_version: number;
  document: ColumnType<unknown, unknown, unknown>;
  recent_mutation_ids: ColumnType<unknown, unknown | undefined, unknown>;
  desktop_icons_initialized_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  legacy_desktop_imported_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

interface OsViewStateDatabase {
  os_view_states: OsViewStatesTable;
}

export class OsViewStateConflictError extends Error {
  constructor(readonly latestRevision: number) {
    super("OS-view state conflict");
    this.name = "OsViewStateConflictError";
  }
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mutationIds(row: Selectable<OsViewStatesTable>): string[] {
  const parsed = parseJson<unknown>(row.recent_mutation_ids, []);
  return Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === "string").slice(-RECENT_MUTATION_LIMIT)
    : [];
}

function sameDocumentValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeCachedLegacyMigration(
  row: Selectable<OsViewStatesTable>,
  request: PatchOsViewStateRequest,
): { patch: OsViewStatePatch; markImported: boolean } {
  const patch: OsViewStatePatch = request.patch.desktop?.icons !== undefined
    ? {
        ...request.patch,
        desktop: {
          ...request.patch.desktop,
          icons: normalizeOsViewDesktopIcons(request.patch.desktop.icons),
        },
      }
    : request.patch;
  if (row.legacy_desktop_imported_at !== null) {
    return { patch, markImported: false };
  }
  const patchKeys = Object.keys(patch);
  const desktopKeys = Object.keys(patch.desktop ?? {});
  const matchesLegacyClient = patch.pinnedApps !== undefined
    && patch.desktop?.icons !== undefined
    && patchKeys.every((key) => key === "pinnedApps" || key === "desktop")
    && desktopKeys.every((key) => key === "icons");
  if (!matchesLegacyClient || request.baseRevision !== 1) {
    return {
      patch,
      markImported: patch.pinnedApps !== undefined || patch.desktop?.icons !== undefined,
    };
  }

  const currentDocument = OsViewDocumentSchema.parse(parseJson(row.document, createDefaultOsViewDocument()));
  const sentIcons = patch.desktop?.icons ?? [];
  const shouldDiscardPoisonedEmptyIcons = sentIcons.length === 0
    && sameDocumentValue(currentDocument.desktop.icons, createDefaultOsViewDesktopIcons());
  return {
    patch: shouldDiscardPoisonedEmptyIcons
      ? { pinnedApps: patch.pinnedApps }
      : patch,
    markImported: true,
  };
}

function toResponse(row: Selectable<OsViewStatesTable>): OsViewStateResponse {
  return {
    revision: Number(row.revision),
    document: OsViewDocumentSchema.parse(parseJson(row.document, createDefaultOsViewDocument())),
    updatedAt: iso(row.updated_at),
  };
}

export class OsViewStateRepository {
  readonly kysely: Kysely<OsViewStateDatabase>;
  private readonly ownsConnection: boolean;

  constructor(dialectOrKysely: Dialect | Kysely<OsViewStateDatabase>) {
    if (dialectOrKysely instanceof Kysely) {
      this.kysely = dialectOrKysely;
      this.ownsConnection = false;
    } else {
      this.kysely = new Kysely<OsViewStateDatabase>({ dialect: dialectOrKysely });
      this.ownsConnection = true;
    }
  }

  static fromConnectionString(connectionString: string): OsViewStateRepository {
    const pool = new pg.Pool({ connectionString, max: 10 });
    pool.on("error", (error) => {
      console.error("[os-view-state] Idle pool client error:", error.message);
    });
    return new OsViewStateRepository(new PostgresDialect({ pool }));
  }

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS os_view_states (
        owner_type TEXT NOT NULL CHECK (owner_type = 'user'),
        owner_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        schema_version INTEGER NOT NULL DEFAULT 1,
        document JSONB NOT NULL,
        recent_mutation_ids JSONB NOT NULL DEFAULT '[]',
        desktop_icons_initialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        legacy_desktop_imported_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_type, owner_id)
      )
    `.execute(this.kysely);
    await sql`ALTER TABLE os_view_states ADD COLUMN IF NOT EXISTS desktop_icons_initialized_at TIMESTAMPTZ`.execute(this.kysely);
    await sql`ALTER TABLE os_view_states ADD COLUMN IF NOT EXISTS legacy_desktop_imported_at TIMESTAMPTZ`.execute(this.kysely);
    const defaultIcons = JSON.stringify(createDefaultOsViewDesktopIcons());
    const repaired = await sql`
      UPDATE os_view_states
      SET document = jsonb_set(document, '{desktop,icons}', ${defaultIcons}::jsonb, false),
          revision = revision + 1,
          updated_at = now(),
          desktop_icons_initialized_at = now(),
          legacy_desktop_imported_at = now()
      WHERE desktop_icons_initialized_at IS NULL
        AND jsonb_typeof(document #> '{desktop,icons}') = 'array'
        AND jsonb_array_length(document #> '{desktop,icons}') = 0
    `.execute(this.kysely);
    await sql`
      UPDATE os_view_states
      SET desktop_icons_initialized_at = now(),
          legacy_desktop_imported_at = now()
      WHERE desktop_icons_initialized_at IS NULL
    `.execute(this.kysely);
    await sql`ALTER TABLE os_view_states ALTER COLUMN desktop_icons_initialized_at SET DEFAULT now()`.execute(this.kysely);
    await sql`ALTER TABLE os_view_states ALTER COLUMN desktop_icons_initialized_at SET NOT NULL`.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_os_view_states_updated ON os_view_states(updated_at DESC)`.execute(this.kysely);
    const repairedCount = Number(repaired.numAffectedRows ?? 0n);
    if (repairedCount > 0) {
      console.info(`[os-view-state] Restored default Desktop icons for ${repairedCount} layout${repairedCount === 1 ? "" : "s"}`);
    }
  }

  async destroy(): Promise<void> {
    if (this.ownsConnection) await this.kysely.destroy();
  }

  async getOrCreate(ownerId: string): Promise<OsViewStateResponse> {
    const inserted = await this.kysely
      .insertInto("os_view_states")
      .values({
        owner_type: "user",
        owner_id: ownerId,
        schema_version: 1,
        document: jsonb(createDefaultOsViewDocument()),
        recent_mutation_ids: jsonb([]),
      })
      .onConflict((conflict) => conflict.columns(["owner_type", "owner_id"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return toResponse(inserted);

    const existing = await this.kysely
      .selectFrom("os_view_states")
      .selectAll()
      .where("owner_type", "=", "user")
      .where("owner_id", "=", ownerId)
      .executeTakeFirstOrThrow();
    return toResponse(existing);
  }

  async importLegacyDesktop(ownerId: string, input: LegacyDesktopImport): Promise<OsViewStateResponse> {
    const legacy = LegacyDesktopImportSchema.parse(input);
    return this.kysely.transaction().execute(async (transaction: Transaction<OsViewStateDatabase>) => {
      const repository = new OsViewStateRepository(transaction);
      let current = await repository.getRowForUpdate(ownerId);
      if (!current) {
        await repository.getOrCreate(ownerId);
        current = await repository.getRowForUpdate(ownerId);
      }
      if (!current) throw new Error("OS-view state initialization failed");
      if (current.legacy_desktop_imported_at !== null) return toResponse(current);

      const currentDocument = OsViewDocumentSchema.parse(parseJson(current.document, createDefaultOsViewDocument()));
      const document = mergeOsViewStatePatch(currentDocument, {
        ...(legacy.pinnedApps !== undefined ? { pinnedApps: legacy.pinnedApps } : {}),
        ...(legacy.desktopIcons !== undefined ? {
          desktop: {
            icons: normalizeOsViewDesktopIcons(legacy.desktopIcons),
          },
        } : {}),
      });
      const updated = await repository.kysely
        .updateTable("os_view_states")
        .set({
          document: jsonb(document),
          revision: sql`revision + 1`,
          updated_at: sql`now()`,
          desktop_icons_initialized_at: sql`now()`,
          legacy_desktop_imported_at: sql`now()`,
        })
        .where("owner_type", "=", "user")
        .where("owner_id", "=", ownerId)
        .where("legacy_desktop_imported_at", "is", null)
        .returningAll()
        .executeTakeFirst();
      if (updated) return toResponse(updated);
      const latest = await repository.getRow(ownerId);
      if (!latest) throw new Error("OS-view state initialization failed");
      return toResponse(latest);
    });
  }

  async patch(ownerId: string, input: PatchOsViewStateRequest): Promise<OsViewStateResponse> {
    const request = PatchOsViewStateRequestSchema.parse(input);
    return this.kysely.transaction().execute(async (transaction: Transaction<OsViewStateDatabase>) => {
      const repository = new OsViewStateRepository(transaction);
      const current = await repository.getRow(ownerId);
      if (!current) {
        await repository.getOrCreate(ownerId);
        return repository.patchInTransaction(ownerId, request);
      }
      return repository.patchRow(ownerId, current, request);
    });
  }

  private async patchInTransaction(
    ownerId: string,
    request: PatchOsViewStateRequest,
  ): Promise<OsViewStateResponse> {
    const current = await this.getRow(ownerId);
    if (!current) throw new Error("OS-view state initialization failed");
    return this.patchRow(ownerId, current, request);
  }

  private async patchRow(
    ownerId: string,
    current: Selectable<OsViewStatesTable>,
    request: PatchOsViewStateRequest,
  ): Promise<OsViewStateResponse> {
    const recentIds = mutationIds(current);
    if (recentIds.includes(request.mutationId)) return toResponse(current);
    if (Number(current.revision) !== request.baseRevision) {
      throw new OsViewStateConflictError(Number(current.revision));
    }

    const normalized = normalizeCachedLegacyMigration(current, request);
    const currentDocument = OsViewDocumentSchema.parse(parseJson(current.document, createDefaultOsViewDocument()));
    const document: OsViewDocument = mergeOsViewStatePatch(currentDocument, normalized.patch);
    const nextMutationIds = [...recentIds, request.mutationId].slice(-RECENT_MUTATION_LIMIT);
    // The owner document is deliberately one aggregate with one revision:
    // apps and presentation geometry have cross-field invariants and must be
    // observed atomically. Concurrent writers re-read the latest aggregate,
    // three-way rebase their path-keyed changes, and retry with the same
    // mutation ID. A targeted jsonb_set under this same aggregate revision
    // would still contend, while making the validation boundary less explicit.
    const updated = await this.kysely
      .updateTable("os_view_states")
      .set({
        document: jsonb(document),
        recent_mutation_ids: jsonb(nextMutationIds),
        revision: sql`revision + 1`,
        updated_at: sql`now()`,
        ...(normalized.markImported ? { legacy_desktop_imported_at: sql`now()` } : {}),
      })
      .where("owner_type", "=", "user")
      .where("owner_id", "=", ownerId)
      .where("revision", "=", request.baseRevision)
      .returningAll()
      .executeTakeFirst();
    if (updated) return toResponse(updated);

    const latest = await this.getRow(ownerId);
    if (latest && mutationIds(latest).includes(request.mutationId)) return toResponse(latest);
    throw new OsViewStateConflictError(latest ? Number(latest.revision) : request.baseRevision);
  }

  private getRow(ownerId: string): Promise<Selectable<OsViewStatesTable> | undefined> {
    return this.kysely
      .selectFrom("os_view_states")
      .selectAll()
      .where("owner_type", "=", "user")
      .where("owner_id", "=", ownerId)
      .executeTakeFirst();
  }

  private getRowForUpdate(ownerId: string): Promise<Selectable<OsViewStatesTable> | undefined> {
    return this.kysely
      .selectFrom("os_view_states")
      .selectAll()
      .where("owner_type", "=", "user")
      .where("owner_id", "=", ownerId)
      .forUpdate()
      .executeTakeFirst();
  }
}
