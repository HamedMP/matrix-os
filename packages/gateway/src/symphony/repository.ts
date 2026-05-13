import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import {
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_EVENTS,
  type OperatorEvent,
  type SaveSymphonyConfigInput,
  type SymphonyInstallation,
  type SymphonyRun,
  type SymphonyRunStatus,
  type SymphonySnapshot,
  type TicketSourceRule,
} from "./contracts.js";

export interface SymphonyRepository {
  bootstrap(): Promise<void>;
  resolveOwnerIdForOperator(principalUserId: string): Promise<string | null>;
  listEnabledOwnerIds(): Promise<string[]>;
  getSnapshot(ownerId: string): Promise<SymphonySnapshot>;
  saveConfig(ownerId: string, input: SaveSymphonyConfigInput, actorId: string, credentialConfigured: boolean): Promise<{ installation: SymphonyInstallation; rule: TicketSourceRule }>;
  setCredentialConfigured(ownerId: string, configured: boolean, actorId: string): Promise<void>;
  setEnabled(ownerId: string, enabled: boolean, actorId: string): Promise<SymphonyInstallation>;
  upsertRun(ownerId: string, run: SymphonyRun): Promise<SymphonyRun>;
  updateRun(ownerId: string, runId: string, patch: Partial<SymphonyRun>, options?: { allowedStatuses?: SymphonyRunStatus[] }): Promise<SymphonyRun | null>;
  getRun(ownerId: string, runId: string): Promise<SymphonyRun | null>;
  findActiveRunByClaim(ownerId: string, claimKey: string): Promise<SymphonyRun | null>;
  listRuns(ownerId: string, input?: { status?: SymphonyRunStatus; limit?: number }): Promise<SymphonyRun[]>;
  appendEvent(ownerId: string, event: Omit<OperatorEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<OperatorEvent>;
  recordPoll(ownerId: string, at: string): Promise<void>;
}

interface InstallationRecord {
  installation: SymphonyInstallation;
  rule: TicketSourceRule | null;
  lastPollAt: string | null;
}

const ACTIVE_RUN_STATUSES = new Set<SymphonyRunStatus>(["queued", "running", "retrying", "blocked"]);

function nowIso(): string {
  return new Date().toISOString();
}

function defaultInstallation(ownerId: string, credentialConfigured: boolean): SymphonyInstallation {
  const timestamp = nowIso();
  return {
    id: `sym_${ownerId}`,
    ownerId,
    enabled: false,
    projectSlug: "matrix-os",
    credentialConfigured,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
    defaultAgent: "codex",
    authorizedOperators: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function rowJson<T>(row: Record<string, unknown>, key: string): T {
  const value = row[key];
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

async function getInstallationRecord(
  executor: Pick<Kysely<any>, "selectFrom">,
  ownerId: string,
): Promise<InstallationRecord | null> {
  const row = await executor
    .selectFrom("symphony_installations")
    .selectAll()
    .where("owner_id", "=", ownerId)
    .executeTakeFirst() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    installation: rowJson<SymphonyInstallation>(row, "installation"),
    rule: row.rule ? rowJson<TicketSourceRule>(row, "rule") : null,
    lastPollAt: row.last_poll_at as string | null ?? null,
  };
}

export class KyselySymphonyRepository implements SymphonyRepository {
  constructor(private readonly db: Kysely<any>) {}

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS symphony_installations (
        owner_id text PRIMARY KEY,
        installation jsonb NOT NULL,
        rule jsonb,
        last_poll_at text,
        updated_at timestamptz DEFAULT now()
      )
    `.execute(this.db);
    await sql`
      CREATE TABLE IF NOT EXISTS symphony_runs (
        id text PRIMARY KEY,
        owner_id text NOT NULL,
        claim_key text NOT NULL,
        status text NOT NULL,
        run jsonb NOT NULL,
        updated_at timestamptz DEFAULT now()
      )
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_symphony_runs_owner_status
      ON symphony_runs (owner_id, status, updated_at DESC)
    `.execute(this.db);
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_symphony_runs_active_claim
      ON symphony_runs (owner_id, claim_key)
      WHERE status IN ('queued', 'running', 'retrying', 'blocked')
    `.execute(this.db);
    await sql`
      CREATE TABLE IF NOT EXISTS symphony_events (
        id text PRIMARY KEY,
        owner_id text NOT NULL,
        installation_id text NOT NULL,
        run_id text,
        event jsonb NOT NULL,
        created_at timestamptz DEFAULT now()
      )
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_symphony_events_owner_created
      ON symphony_events (owner_id, created_at DESC)
    `.execute(this.db);
    await sql`
      CREATE TABLE IF NOT EXISTS symphony_operators (
        owner_id text NOT NULL,
        operator_user_id text NOT NULL,
        PRIMARY KEY (owner_id, operator_user_id)
      )
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_symphony_operators_operator
      ON symphony_operators (operator_user_id)
    `.execute(this.db);
  }

  async getSnapshot(ownerId: string): Promise<SymphonySnapshot> {
    const record = await getInstallationRecord(this.db, ownerId);
    const runs = await this.listRuns(ownerId, { limit: 100 });
    const eventRows = await this.db
      .selectFrom("symphony_events")
      .select(["event"])
      .where("owner_id", "=", ownerId)
      .orderBy("created_at", "desc")
      .limit(MAX_EVENTS)
      .execute() as Record<string, unknown>[];
    return {
      installation: record?.installation ?? null,
      rule: record?.rule ?? null,
      runs,
      events: eventRows.map((row) => rowJson<OperatorEvent>(row, "event")).reverse(),
      lastPollAt: record?.lastPollAt ?? null,
    };
  }

  async resolveOwnerIdForOperator(principalUserId: string): Promise<string | null> {
    const direct = await this.db
      .selectFrom("symphony_installations")
      .select(["owner_id"])
      .where("owner_id", "=", principalUserId)
      .executeTakeFirst() as Record<string, unknown> | undefined;
    if (direct) return principalUserId;
    const operator = await this.db
      .selectFrom("symphony_operators")
      .select(["owner_id"])
      .where("operator_user_id", "=", principalUserId)
      .orderBy("owner_id", "asc")
      .executeTakeFirst() as Record<string, unknown> | undefined;
    return operator ? String(operator.owner_id) : null;
  }

  async listEnabledOwnerIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom("symphony_installations")
      .select(["owner_id", "installation"])
      .execute() as Record<string, unknown>[];
    return rows
      .filter((row) => rowJson<SymphonyInstallation>(row, "installation").enabled)
      .map((row) => String(row.owner_id));
  }

  async saveConfig(ownerId: string, input: SaveSymphonyConfigInput, actorId: string, credentialConfigured: boolean): Promise<{ installation: SymphonyInstallation; rule: TicketSourceRule }> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("symphony_installations")
        .selectAll()
        .where("owner_id", "=", ownerId)
        .executeTakeFirst() as Record<string, unknown> | undefined;
      const previous = existing ? rowJson<SymphonyInstallation>(existing, "installation") : defaultInstallation(ownerId, credentialConfigured);
      const timestamp = nowIso();
      const installation: SymphonyInstallation = {
        ...previous,
        ...input.installation,
        id: previous.id,
        ownerId,
        credentialConfigured,
        enabled: previous.enabled,
        updatedAt: timestamp,
        createdAt: previous.createdAt,
      };
      const rule: TicketSourceRule = {
        ...input.rule,
        installationId: installation.id,
        updatedAt: timestamp,
      };
      await trx
        .insertInto("symphony_installations")
        .values({
          owner_id: ownerId,
          installation: JSON.stringify(installation),
          rule: JSON.stringify(rule),
          last_poll_at: existing?.last_poll_at ?? null,
        })
        .onConflict((oc) => oc.column("owner_id").doUpdateSet({
          installation: JSON.stringify(installation),
          rule: JSON.stringify(rule),
          updated_at: sql`now()`,
        }))
        .execute();
      await this.replaceOperators(trx, ownerId, installation.authorizedOperators);
      await this.insertEvent(trx, ownerId, {
        installationId: installation.id,
        type: "symphony.config.updated",
        message: "Symphony configuration updated",
        severity: "info",
        actorId,
      });
      return { installation, rule };
    });
  }

  async setCredentialConfigured(ownerId: string, configured: boolean, actorId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const record = await getInstallationRecord(trx, ownerId);
      const installation = {
        ...(record?.installation ?? defaultInstallation(ownerId, configured)),
        credentialConfigured: configured,
        updatedAt: nowIso(),
      };
      await trx
        .insertInto("symphony_installations")
        .values({
          owner_id: ownerId,
          installation: JSON.stringify(installation),
          rule: record?.rule ? JSON.stringify(record.rule) : null,
          last_poll_at: record?.lastPollAt ?? null,
        })
        .onConflict((oc) => oc.column("owner_id").doUpdateSet({
          installation: JSON.stringify(installation),
          updated_at: sql`now()`,
        }))
        .execute();
      await this.insertEvent(trx, ownerId, {
        installationId: installation.id,
        type: configured ? "symphony.credential.updated" : "symphony.credential.deleted",
        message: configured ? "Linear credential updated" : "Linear credential removed",
        severity: "info",
        actorId,
      });
    });
  }

  async setEnabled(ownerId: string, enabled: boolean, actorId: string): Promise<SymphonyInstallation> {
    return this.db.transaction().execute(async (trx) => {
      const record = await getInstallationRecord(trx, ownerId);
      const installation = {
        ...(record?.installation ?? defaultInstallation(ownerId, false)),
        enabled,
        updatedAt: nowIso(),
      };
      await trx
        .insertInto("symphony_installations")
        .values({
          owner_id: ownerId,
          installation: JSON.stringify(installation),
          rule: record?.rule ? JSON.stringify(record.rule) : null,
          last_poll_at: record?.lastPollAt ?? null,
        })
        .onConflict((oc) => oc.column("owner_id").doUpdateSet({
          installation: JSON.stringify(installation),
          updated_at: sql`now()`,
        }))
        .execute();
      await this.insertEvent(trx, ownerId, {
        installationId: installation.id,
        type: enabled ? "symphony.started" : "symphony.stopped",
        message: enabled ? "Symphony started" : "Symphony stopped",
        severity: "info",
        actorId,
      });
      return installation;
    });
  }

  async upsertRun(ownerId: string, run: SymphonyRun): Promise<SymphonyRun> {
    await this.db
      .insertInto("symphony_runs")
      .values({
        id: run.id,
        owner_id: ownerId,
        claim_key: run.claimKey,
        status: run.status,
        run: JSON.stringify(run),
      })
      .onConflict((oc) => oc.column("id").doUpdateSet({
        claim_key: run.claimKey,
        status: run.status,
        run: JSON.stringify(run),
        updated_at: sql`now()`,
      }))
      .execute();
    return run;
  }

  async updateRun(ownerId: string, runId: string, patch: Partial<SymphonyRun>, options: { allowedStatuses?: SymphonyRunStatus[] } = {}): Promise<SymphonyRun | null> {
    const current = await this.getRun(ownerId, runId);
    if (!current) return null;
    const updated = { ...current, ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    let query = this.db
      .updateTable("symphony_runs")
      .set({
        status: updated.status,
        run: JSON.stringify(updated),
        updated_at: sql`now()`,
      })
      .where("owner_id", "=", ownerId)
      .where("id", "=", runId);
    if (options.allowedStatuses && options.allowedStatuses.length > 0) {
      query = query.where("status", "in", options.allowedStatuses);
    }
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows) > 0 ? updated : null;
  }

  async getRun(ownerId: string, runId: string): Promise<SymphonyRun | null> {
    const row = await this.db
      .selectFrom("symphony_runs")
      .select(["run"])
      .where("owner_id", "=", ownerId)
      .where("id", "=", runId)
      .executeTakeFirst() as Record<string, unknown> | undefined;
    return row ? rowJson<SymphonyRun>(row, "run") : null;
  }

  async findActiveRunByClaim(ownerId: string, claimKey: string): Promise<SymphonyRun | null> {
    const row = await this.db
      .selectFrom("symphony_runs")
      .select(["run"])
      .where("owner_id", "=", ownerId)
      .where("claim_key", "=", claimKey)
      .where("status", "in", Array.from(ACTIVE_RUN_STATUSES))
      .executeTakeFirst() as Record<string, unknown> | undefined;
    return row ? rowJson<SymphonyRun>(row, "run") : null;
  }

  async listRuns(ownerId: string, input: { status?: SymphonyRunStatus; limit?: number } = {}): Promise<SymphonyRun[]> {
    let query = this.db
      .selectFrom("symphony_runs")
      .select(["run"])
      .where("owner_id", "=", ownerId);
    if (input.status) query = query.where("status", "=", input.status);
    const rows = await query
      .orderBy("updated_at", "desc")
      .limit(Math.min(input.limit ?? 100, 100))
      .execute() as Record<string, unknown>[];
    return rows.map((row) => rowJson<SymphonyRun>(row, "run"));
  }

  async appendEvent(ownerId: string, event: Omit<OperatorEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<OperatorEvent> {
    return this.insertEvent(this.db, ownerId, event);
  }

  async recordPoll(ownerId: string, at: string): Promise<void> {
    await this.db
      .updateTable("symphony_installations")
      .set({ last_poll_at: at, updated_at: sql`now()` })
      .where("owner_id", "=", ownerId)
      .execute();
  }

  private async insertEvent(
    executor: Pick<Kysely<any>, "insertInto">,
    ownerId: string,
    event: Omit<OperatorEvent, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<OperatorEvent> {
    const record: OperatorEvent = {
      ...event,
      id: event.id ?? `evt_${randomUUID()}`,
      createdAt: event.createdAt ?? nowIso(),
    };
    await executor
      .insertInto("symphony_events")
      .values({
        id: record.id,
        owner_id: ownerId,
        installation_id: record.installationId,
        run_id: record.runId ?? null,
        event: JSON.stringify(record),
      })
      .execute();
    return record;
  }

  private async replaceOperators(
    executor: Pick<Kysely<any>, "deleteFrom" | "insertInto">,
    ownerId: string,
    operatorIds: string[],
  ): Promise<void> {
    await executor
      .deleteFrom("symphony_operators")
      .where("owner_id", "=", ownerId)
      .execute();
    const uniqueOperators = Array.from(new Set(operatorIds)).filter((operatorId) => operatorId !== ownerId);
    if (uniqueOperators.length === 0) return;
    await executor
      .insertInto("symphony_operators")
      .values(uniqueOperators.map((operatorId) => ({
        owner_id: ownerId,
        operator_user_id: operatorId,
      })))
      .onConflict((oc) => oc.columns(["owner_id", "operator_user_id"]).doNothing())
      .execute();
  }
}
