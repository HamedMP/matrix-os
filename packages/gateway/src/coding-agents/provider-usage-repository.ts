import {
  ProviderUsageSourceSummarySchema,
  RuntimeIdSchema,
  type ProviderUsageAccuracy,
  type ProviderUsageSourceSummary,
  type ProviderUsageState,
} from "@matrix-os/contracts";
import {
  Kysely,
  sql,
  type ColumnType,
  type Dialect,
  type Selectable,
} from "kysely";
import { z } from "zod/v4";

const ProviderUsageOwnerIdSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/);

interface ProviderUsageSnapshotsTable {
  owner_id: string;
  runtime_id: string;
  source_id: string;
  display_name: string;
  linked_agent_provider_ids: ColumnType<unknown, unknown, unknown>;
  state: ProviderUsageState;
  accuracy: ProviderUsageAccuracy | null;
  windows: ColumnType<unknown, unknown, unknown>;
  credits: ColumnType<unknown | null, unknown | null, unknown | null>;
  observed_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
  expires_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
  setup_actions: ColumnType<unknown, unknown, unknown>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface ProviderUsageDatabase {
  coding_agent_provider_quota_snapshots: ProviderUsageSnapshotsTable;
}

export interface ProviderUsageSnapshotScope {
  ownerId: string;
  runtimeId: string;
}

export interface UpsertProviderUsageSnapshotInput extends ProviderUsageSnapshotScope {
  source: ProviderUsageSourceSummary;
}

function parseScope(scope: ProviderUsageSnapshotScope): ProviderUsageSnapshotScope {
  return {
    ownerId: ProviderUsageOwnerIdSchema.parse(scope.ownerId),
    runtimeId: RuntimeIdSchema.parse(scope.runtimeId),
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function asIso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSource(row: Selectable<ProviderUsageSnapshotsTable>): ProviderUsageSourceSummary {
  return ProviderUsageSourceSummarySchema.parse({
    id: row.source_id,
    displayName: row.display_name,
    linkedAgentProviderIds: parseJson<unknown[]>(row.linked_agent_provider_ids, []),
    state: row.state,
    ...(row.accuracy === null ? {} : { accuracy: row.accuracy }),
    windows: parseJson<unknown[]>(row.windows, []),
    ...(row.credits === null
      ? {}
      : { credits: parseJson<unknown>(row.credits, undefined) }),
    ...(row.observed_at === null ? {} : { observedAt: asIso(row.observed_at) }),
    ...(row.expires_at === null ? {} : { expiresAt: asIso(row.expires_at) }),
    setupActions: parseJson<unknown[]>(row.setup_actions, []),
  });
}

export class CodingAgentProviderUsageSnapshotRepository {
  readonly kysely: Kysely<ProviderUsageDatabase>;
  private readonly ownsConnection: boolean;

  constructor(dialectOrKysely: Dialect | Kysely<ProviderUsageDatabase>) {
    if (dialectOrKysely instanceof Kysely) {
      this.kysely = dialectOrKysely;
      this.ownsConnection = false;
      return;
    }

    this.kysely = new Kysely<ProviderUsageDatabase>({ dialect: dialectOrKysely });
    this.ownsConnection = true;
  }

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS coding_agent_provider_quota_snapshots (
        owner_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        linked_agent_provider_ids JSONB NOT NULL DEFAULT '[]',
        state TEXT NOT NULL CHECK (state IN ('available', 'stale', 'setup_required', 'unavailable', 'unsupported')),
        accuracy TEXT CHECK (accuracy IS NULL OR accuracy IN ('provider_reported', 'provider_derived')),
        windows JSONB NOT NULL DEFAULT '[]',
        credits JSONB,
        observed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        setup_actions JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, runtime_id, source_id)
      )
    `.execute(this.kysely);

    await sql`
      CREATE INDEX IF NOT EXISTS idx_coding_agent_provider_quota_snapshots_scope
      ON coding_agent_provider_quota_snapshots(owner_id, runtime_id, source_id)
    `.execute(this.kysely);
  }

  async upsert(input: UpsertProviderUsageSnapshotInput): Promise<void> {
    const scope = parseScope(input);
    const source = ProviderUsageSourceSummarySchema.parse(input.source);
    const updatedAt = new Date().toISOString();
    const values = {
      owner_id: scope.ownerId,
      runtime_id: scope.runtimeId,
      source_id: source.id,
      display_name: source.displayName,
      linked_agent_provider_ids: jsonb(source.linkedAgentProviderIds),
      state: source.state,
      accuracy: source.accuracy ?? null,
      windows: jsonb(source.windows),
      credits: source.credits === undefined ? null : jsonb(source.credits),
      observed_at: source.observedAt ?? null,
      expires_at: source.expiresAt ?? null,
      setup_actions: jsonb(source.setupActions),
      updated_at: updatedAt,
    };

    await this.kysely
      .insertInto("coding_agent_provider_quota_snapshots")
      .values(values)
      .onConflict((conflict) => conflict
        .columns(["owner_id", "runtime_id", "source_id"])
        .doUpdateSet({
          display_name: values.display_name,
          linked_agent_provider_ids: values.linked_agent_provider_ids,
          state: values.state,
          accuracy: values.accuracy,
          windows: values.windows,
          credits: values.credits,
          observed_at: values.observed_at,
          expires_at: values.expires_at,
          setup_actions: values.setup_actions,
          updated_at: values.updated_at,
        }))
      .execute();
  }

  async list(scopeInput: ProviderUsageSnapshotScope): Promise<ProviderUsageSourceSummary[]> {
    const scope = parseScope(scopeInput);
    const rows = await this.kysely
      .selectFrom("coding_agent_provider_quota_snapshots")
      .selectAll()
      .where("owner_id", "=", scope.ownerId)
      .where("runtime_id", "=", scope.runtimeId)
      .orderBy("source_id", "asc")
      .execute();

    return rows.map(toSource);
  }

  async destroy(): Promise<void> {
    if (this.ownsConnection) {
      await this.kysely.destroy();
    }
  }
}
