import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql, type ColumnType, type Dialect, type Selectable, type Transaction } from "kysely";
import pg from "pg";
import {
  CanvasDocumentWriteSchema,
  CanvasIdSchema,
  type CanvasDocumentWrite,
  type CanvasOwnerScope,
  type CanvasScopeType,
} from "./contracts.js";

export interface CanvasDocumentsTable {
  id: string;
  owner_scope: CanvasOwnerScope;
  owner_id: string;
  scope_type: CanvasScopeType;
  scope_ref: ColumnType<unknown | null, unknown | null, unknown | null>;
  title: string;
  revision: ColumnType<number, number | undefined, number>;
  schema_version: number;
  nodes: ColumnType<unknown, unknown, unknown>;
  edges: ColumnType<unknown, unknown, unknown>;
  view_states: ColumnType<unknown, unknown, unknown>;
  display_options: ColumnType<unknown, unknown, unknown>;
  deleted_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface CanvasDatabase {
  canvas_documents: CanvasDocumentsTable;
}

export interface CanvasOwner {
  ownerScope: CanvasOwnerScope;
  ownerId: string;
}

export interface CreateCanvasInput {
  title: string;
  scopeType: CanvasScopeType;
  scopeRef: Record<string, unknown> | null;
  document: CanvasDocumentWrite;
}

export interface ReplaceCanvasInput {
  baseRevision: number;
  document: CanvasDocumentWrite;
}

export interface PatchCanvasNodeInput {
  baseRevision: number;
  nodeId: string;
  updates: Record<string, unknown>;
}

export interface CanvasRecord {
  id: string;
  ownerScope: CanvasOwnerScope;
  ownerId: string;
  scopeType: CanvasScopeType;
  scopeRef: Record<string, unknown> | null;
  title: string;
  revision: number;
  schemaVersion: 1;
  nodes: unknown[];
  edges: unknown[];
  viewStates: unknown[];
  displayOptions: Record<string, unknown>;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CanvasConflictError extends Error {
  readonly canvasId: string;
  readonly latestRevision: number;

  constructor(canvasId: string, latestRevision: number) {
    super("Canvas conflict");
    this.name = "CanvasConflictError";
    this.canvasId = canvasId;
    this.latestRevision = latestRevision;
  }
}

export class CanvasNotFoundError extends Error {
  constructor(readonly canvasId: string) {
    super("Canvas not found");
    this.name = "CanvasNotFoundError";
  }
}

function createCanvasId(): string {
  return `cnv_${randomUUID().replaceAll("-", "")}`;
}

function asIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function toRecord(row: Selectable<CanvasDocumentsTable>): CanvasRecord {
  return {
    id: row.id,
    ownerScope: row.owner_scope,
    ownerId: row.owner_id,
    scopeType: row.scope_type,
    scopeRef: parseJson<Record<string, unknown> | null>(row.scope_ref, null),
    title: row.title,
    revision: Number(row.revision),
    schemaVersion: 1,
    nodes: parseJson<unknown[]>(row.nodes, []),
    edges: parseJson<unknown[]>(row.edges, []),
    viewStates: parseJson<unknown[]>(row.view_states, []),
    displayOptions: parseJson<Record<string, unknown>>(row.display_options, {}),
    deletedAt: asIso(row.deleted_at),
    createdAt: asIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: asIso(row.updated_at) ?? new Date().toISOString(),
  };
}

export class CanvasRepository {
  readonly kysely: Kysely<CanvasDatabase>;
  private readonly ownsConnection: boolean;
  private readonly pool: pg.Pool | null;

  constructor(dialectOrKysely: Dialect | Kysely<CanvasDatabase>, pool: pg.Pool | null = null) {
    if (dialectOrKysely instanceof Kysely) {
      this.kysely = dialectOrKysely;
      this.ownsConnection = false;
      this.pool = pool;
      return;
    }
    this.kysely = new Kysely<CanvasDatabase>({ dialect: dialectOrKysely });
    this.ownsConnection = true;
    this.pool = pool;
  }

  static fromConnectionString(connectionString: string): CanvasRepository {
    const pool = new pg.Pool({ connectionString, max: 10 });
    pool.on("error", (err) => {
      console.error("[canvas-repository] Idle pool client error:", err.message);
    });
    return new CanvasRepository(new PostgresDialect({ pool }), pool);
  }

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS canvas_documents (
        id TEXT PRIMARY KEY,
        owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'org')),
        owner_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'project', 'task', 'pull_request', 'review_loop')),
        scope_ref JSONB,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        schema_version INTEGER NOT NULL DEFAULT 1,
        nodes JSONB NOT NULL DEFAULT '[]',
        edges JSONB NOT NULL DEFAULT '[]',
        view_states JSONB NOT NULL DEFAULT '[]',
        display_options JSONB NOT NULL DEFAULT '{}',
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);

    await sql`CREATE INDEX IF NOT EXISTS idx_canvas_documents_owner ON canvas_documents(owner_scope, owner_id)`.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_canvas_documents_scope ON canvas_documents(owner_scope, owner_id, scope_type)`.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_canvas_documents_updated ON canvas_documents(owner_scope, owner_id, updated_at DESC)`.execute(this.kysely);
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_documents_unique_active_scope
      ON canvas_documents(owner_scope, owner_id, scope_type, COALESCE(scope_ref::text, 'null'))
      WHERE deleted_at IS NULL
    `.execute(this.kysely);
  }

  async destroy(): Promise<void> {
    if (this.ownsConnection) {
      await this.kysely.destroy();
    }
    await this.pool?.end();
  }

  async create(owner: CanvasOwner, input: CreateCanvasInput): Promise<CanvasRecord> {
    const document = CanvasDocumentWriteSchema.parse(input.document);
    let id = createCanvasId();
    while (!CanvasIdSchema.safeParse(id).success) {
      id = createCanvasId();
    }

    const row = await this.kysely
      .insertInto("canvas_documents")
      .values({
        id,
        owner_scope: owner.ownerScope,
        owner_id: owner.ownerId,
        scope_type: input.scopeType,
        scope_ref: input.scopeRef === null ? null : jsonb(input.scopeRef),
        title: input.title,
        revision: 1,
        schema_version: document.schemaVersion,
        nodes: jsonb(document.nodes),
        edges: jsonb(document.edges),
        view_states: jsonb(document.viewStates),
        display_options: jsonb(document.displayOptions),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toRecord(row);
  }

  async list(owner: CanvasOwner, limit = 50): Promise<CanvasRecord[]> {
    const rows = await this.kysely
      .selectFrom("canvas_documents")
      .selectAll()
      .where("owner_scope", "=", owner.ownerScope)
      .where("owner_id", "=", owner.ownerId)
      .where("deleted_at", "is", null)
      .orderBy("updated_at", "desc")
      .limit(Math.min(Math.max(limit, 1), 100))
      .execute();

    return rows.map(toRecord);
  }

  async get(owner: CanvasOwner, canvasId: string): Promise<CanvasRecord | null> {
    const row = await this.kysely
      .selectFrom("canvas_documents")
      .selectAll()
      .where("id", "=", canvasId)
      .where("owner_scope", "=", owner.ownerScope)
      .where("owner_id", "=", owner.ownerId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    return row ? toRecord(row) : null;
  }

  async export(owner: CanvasOwner, canvasId: string): Promise<CanvasRecord | null> {
    const row = await this.kysely
      .selectFrom("canvas_documents")
      .selectAll()
      .where("id", "=", canvasId)
      .where("owner_scope", "=", owner.ownerScope)
      .where("owner_id", "=", owner.ownerId)
      .executeTakeFirst();

    return row ? toRecord(row) : null;
  }

  async replaceDocument(owner: CanvasOwner, canvasId: string, input: ReplaceCanvasInput): Promise<{ revision: number; updatedAt: string }> {
    const document = CanvasDocumentWriteSchema.parse(input.document);
    const row = await this.kysely.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("canvas_documents")
        .select(["revision"])
        .where("id", "=", canvasId)
        .where("owner_scope", "=", owner.ownerScope)
        .where("owner_id", "=", owner.ownerId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();

      if (!current) {
        throw new CanvasNotFoundError(canvasId);
      }
      if (Number(current.revision) !== input.baseRevision) {
        throw new CanvasConflictError(canvasId, Number(current.revision));
      }

      return trx
        .updateTable("canvas_documents")
        .set({
          revision: input.baseRevision + 1,
          schema_version: document.schemaVersion,
          nodes: jsonb(document.nodes),
          edges: jsonb(document.edges),
          view_states: jsonb(document.viewStates),
          display_options: jsonb(document.displayOptions),
          updated_at: sql`now()`,
        })
        .where("id", "=", canvasId)
        .where("owner_scope", "=", owner.ownerScope)
        .where("owner_id", "=", owner.ownerId)
        .returning(["revision", "updated_at"])
        .executeTakeFirstOrThrow();
    });

    return { revision: Number(row.revision), updatedAt: asIso(row.updated_at) ?? new Date().toISOString() };
  }

  async patchNode(owner: CanvasOwner, canvasId: string, input: PatchCanvasNodeInput): Promise<{ revision: number; updatedAt: string }> {
    const current = await this.get(owner, canvasId);
    if (!current) throw new CanvasNotFoundError(canvasId);
    if (current.revision !== input.baseRevision) {
      throw new CanvasConflictError(canvasId, current.revision);
    }
    const nodes = current.nodes.map((node) => {
      if (typeof node !== "object" || node === null || (node as { id?: unknown }).id !== input.nodeId) {
        return node;
      }
      return {
        ...node,
        ...input.updates,
        updatedAt: new Date().toISOString(),
      };
    });
    if (!nodes.some((node) => typeof node === "object" && node !== null && (node as { id?: unknown }).id === input.nodeId)) {
      throw new CanvasNotFoundError(input.nodeId);
    }
    return this.replaceDocument(owner, canvasId, {
      baseRevision: input.baseRevision,
      document: {
        schemaVersion: 1,
        nodes: nodes as CanvasDocumentWrite["nodes"],
        edges: current.edges as CanvasDocumentWrite["edges"],
        viewStates: current.viewStates as CanvasDocumentWrite["viewStates"],
        displayOptions: current.displayOptions,
      },
    });
  }

  async softDelete(owner: CanvasOwner, canvasId: string): Promise<void> {
    const result = await this.kysely
      .updateTable("canvas_documents")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", canvasId)
      .where("owner_scope", "=", owner.ownerScope)
      .where("owner_id", "=", owner.ownerId)
      .returning("id")
      .executeTakeFirst();

    if (!result) {
      throw new CanvasNotFoundError(canvasId);
    }
  }

  async withTransaction<T>(fn: (repository: CanvasRepository) => Promise<T>): Promise<T> {
    return this.kysely.transaction().execute((trx: Transaction<CanvasDatabase>) => {
      return fn(new CanvasRepository(trx));
    });
  }
}
