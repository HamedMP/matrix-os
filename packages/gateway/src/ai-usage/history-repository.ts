import { sql, type Kysely } from "kysely";
import { createHash } from "node:crypto";
import type { UsageEvent } from "@matrix-os/contracts/ai-usage";
import type { UsageBatch } from "@matrix-os/contracts/ai-usage";
import type { UsageParserState } from "@matrix-os/contracts/ai-usage";
export interface UsageCheckpoint {
  offset: number;
  state: UsageParserState | null;
  fingerprint: string;
  prefix: string;
  size: number;
  issues: number;
  complete?: boolean;
  eof?: boolean;
  modified?: number;
  verifiedHash?: string;
}
const sourceKey = (machine: string, path: string) =>
  createHash("sha256")
    .update(machine + "\0" + path)
    .digest("hex");
/** Uses the caller's owner database/pool; never closes injected resources. */
export class UsageHistoryRepository {
  constructor(readonly db: Kysely<any>) {}
  async bootstrap() {
    await this.db.transaction().execute(async (tx) => {
      await tx.schema
        .createTable("ai_usage_sources")
        .ifNotExists()
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("source_id", "text", (c) => c.notNull())
        .addColumn("machine", "text", (c) => c.notNull())
        .addColumn("checkpoint", "jsonb", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("updated_at", "timestamptz", (c) =>
          c.notNull().defaultTo(sql`now()`),
        )
        .addPrimaryKeyConstraint("ai_usage_source_pk", [
          "owner_id",
          "source_id",
        ])
        .execute();
      await tx.schema
        .createTable("ai_usage_observations")
        .ifNotExists()
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("source_id", "text", (c) => c.notNull())
        .addColumn("event_id", "text", (c) => c.notNull())
        .addColumn("event", "jsonb", (c) => c.notNull())
        .addForeignKeyConstraint(
          "ai_usage_observation_source_fk",
          ["owner_id", "source_id"],
          "ai_usage_sources",
          ["owner_id", "source_id"],
          (c) => c.onDelete("cascade"),
        )
        .addPrimaryKeyConstraint("ai_usage_observation_pk", [
          "owner_id",
          "source_id",
          "event_id",
        ])
        .execute();
      await tx.schema
        .createIndex("ai_usage_observation_event")
        .ifNotExists()
        .on("ai_usage_observations")
        .columns(["owner_id", "event_id"])
        .execute();
    });
  }
  async getSource(
    owner: string,
    machine: string,
    path: string,
  ): Promise<UsageCheckpoint | undefined> {
    const r = await this.db
      .selectFrom("ai_usage_sources")
      .select("checkpoint")
      .where("owner_id", "=", owner)
      .where("source_id", "=", sourceKey(machine, path))
      .executeTakeFirst();
    return r?.checkpoint;
  }
  async commit(
    owner: string,
    machine: string,
    path: string,
    base: UsageCheckpoint | null,
    next: UsageCheckpoint,
    batch: UsageBatch,
    status: string,
    reset = false,
  ) {
    if (batch.events.length > 1000) throw new RangeError("Usage batch limit");
    const id = sourceKey(machine, path);
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("ai_usage_sources")
        .values({
          owner_id: owner,
          source_id: id,
          machine,
          checkpoint: JSON.stringify({ offset: 0 }),
          status: "indexing",
        })
        .onConflict((c) => c.columns(["owner_id", "source_id"]).doNothing())
        .execute();
      const locked = await tx
        .selectFrom("ai_usage_sources")
        .select("checkpoint")
        .where("owner_id", "=", owner)
        .where("source_id", "=", id)
        .where(
          sql<boolean>`checkpoint = ${JSON.stringify(base ?? { offset: 0 })}::jsonb`,
        )
        .forUpdate()
        .executeTakeFirst();
      if (!locked) throw new Error("Usage checkpoint conflict");
      if (reset)
        await tx
          .deleteFrom("ai_usage_observations")
          .where("owner_id", "=", owner)
          .where("source_id", "=", id)
          .execute();
      const unique = new Map<string, UsageEvent>(); // At most one 256-record collector batch; released on commit.
      for (const event of batch.events) {
        const old = unique.get(event.id);
        if (!old || event.output >= old.output) unique.set(event.id, event);
      }
      if (unique.size) {
        const rows = await tx
          .insertInto("ai_usage_observations")
          .values(
            [...unique.values()].map((event) => ({
              owner_id: owner,
              source_id: id,
              event_id: event.id,
              event: JSON.stringify(event),
            })),
          )
          .onConflict((c) =>
            c
              .columns(["owner_id", "source_id", "event_id"])
              .doUpdateSet({ event: sql`excluded.event` })
              .where(
                sql<boolean>`(excluded.event->>'output')::bigint >= (ai_usage_observations.event->>'output')::bigint AND (excluded.event->>'input')::bigint >= (ai_usage_observations.event->>'input')::bigint AND (excluded.event->>'cachedInput')::bigint >= (ai_usage_observations.event->>'cachedInput')::bigint AND (excluded.event->>'cacheWrite')::bigint >= (ai_usage_observations.event->>'cacheWrite')::bigint`,
              ),
          )
          .returning("event_id")
          .execute();
        next.issues += unique.size - rows.length;
      }
      await tx
        .updateTable("ai_usage_sources")
        .set({
          checkpoint: JSON.stringify(next),
          status,
          updated_at: new Date(),
        })
        .where("owner_id", "=", owner)
        .where("source_id", "=", id)
        .execute();
    });
  }
  async *events(owner: string): AsyncGenerator<UsageEvent> {
    // Keyset pages bound transport memory. Every row is owner-filtered before mirror deduplication.
    let after = "";
    for (;;) {
      const rows = await this.db
        .selectFrom("ai_usage_observations")
        .select(["event_id", "event"])
        .distinctOn("event_id")
        .where("owner_id", "=", owner)
        .where("event_id", ">", after)
        .orderBy("event_id")
        .orderBy(sql`(event->>'output')::bigint`, "desc")
        .orderBy(sql`(event->>'input')::bigint`, "desc")
        .limit(512)
        .execute();
      if (!rows.length) break;
      for (const row of rows) yield row.event as UsageEvent;
      after = rows.at(-1)!.event_id;
    }
  }
  async withSnapshot<T>(
    read: (repo: UsageHistoryRepository) => Promise<T>,
  ): Promise<T> {
    if (this.db.isTransaction) return read(this);
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((tx) => read(new UsageHistoryRepository(tx)));
  }
  async visitEvents(
    owner: string,
    visit: (event: UsageEvent) => void,
  ): Promise<{ issues: number }> {
    if (!this.db.isTransaction)
      return this.withSnapshot((repo) => repo.visitEvents(owner, visit));
    const canonical = this.db
      .selectFrom("ai_usage_observations")
      .select(["event_id", "event"])
      .distinctOn("event_id")
      .where("owner_id", "=", owner)
      .orderBy("event_id")
      .orderBy(sql`(event->>'output')::bigint`, "desc")
      .orderBy(sql`(event->>'input')::bigint`, "desc");
    let last = "",
      previous = { input: 0, cached: 0, output: 0 },
      issues = 0;
    const tx = this.db;
    {
      await sql`DECLARE ai_usage_history_read NO SCROLL CURSOR FOR
          WITH canonical AS MATERIALIZED (${canonical}),
          precise AS (SELECT DISTINCT event->>'session' AS session, event->'cumulative' AS cumulative FROM canonical WHERE event->>'sourceKind'='response' AND event->'cumulative' IS NOT NULL),
          native_max AS (SELECT session, max((cumulative->>'input')::bigint+(cumulative->>'output')::bigint) AS endpoint FROM precise GROUP BY session),
          legacy AS (SELECT DISTINCT event->>'session' AS session, event->'cumulative' AS cumulative FROM canonical WHERE event->>'sourceKind'='cumulative'),
          uncertain AS (SELECT DISTINCT event->>'session' AS session FROM canonical WHERE event->>'agent'='codex' AND event->>'sourceKind'='response' AND event->'cumulative' IS NULL)
          SELECT c.event, p.session IS NOT NULL AS covered, l.session IS NOT NULL AS legacy,
            u.session IS NOT NULL AS uncertain,
            coalesce((c.event->'cumulative'->>'input')::bigint+(c.event->'cumulative'->>'output')::bigint <= n.endpoint, false) AS native_range
          FROM canonical c
          LEFT JOIN precise p ON c.event->>'session'=p.session AND c.event->'cumulative'=p.cumulative
          LEFT JOIN legacy l ON c.event->>'session'=l.session AND c.event->'cumulative'=l.cumulative
          LEFT JOIN native_max n ON c.event->>'session'=n.session
          LEFT JOIN uncertain u ON c.event->>'session'=u.session
          ORDER BY c.event->>'agent', c.event->>'session',
            coalesce((c.event->'cumulative'->>'input')::bigint+(c.event->'cumulative'->>'output')::bigint,0),
            (c.event->>'sourceKind'='response') DESC, c.event->>'timestamp', c.event_id`.execute(
        tx,
      );
      for (;;) {
        const result = await sql<{
          event: UsageEvent;
          covered: boolean;
          uncertain: boolean;
          legacy: boolean;
          native_range: boolean;
        }>`FETCH FORWARD 512 FROM ai_usage_history_read`.execute(tx);
        if (!result.rows.length) break;
        for (const {
          event: raw,
          covered,
          uncertain,
          legacy,
          native_range,
        } of result.rows) {
          let event = raw;
          if (raw.agent === "codex" && raw.sourceKind === "response") {
            if (raw.session !== last) {
              last = raw.session;
              previous = { input: 0, cached: 0, output: 0 };
            }
            if (
              raw.cumulative &&
              raw.cumulative.input >= previous.input &&
              raw.cumulative.output >= previous.output
            ) {
              const input =
                  raw.cumulative.input -
                  previous.input -
                  raw.input -
                  raw.cachedInput,
                cached =
                  raw.cumulative.cached - previous.cached - raw.cachedInput,
                output = raw.cumulative.output - previous.output - raw.output;
              if (input > 0 || output > 0) {
                if (
                  legacy &&
                  !uncertain &&
                  input >= cached &&
                  cached >= 0 &&
                  output >= 0
                )
                  visit({
                    ...raw,
                    id: raw.id + ":recovered-prefix",
                    model: "unknown",
                    sourceKind: "cumulative",
                    cumulative: undefined,
                    input: input - cached,
                    cachedInput: cached,
                    output,
                  });
                else issues++;
              }
              previous = { ...raw.cumulative };
            }
            visit(raw);
            continue;
          }
          if (raw.agent === "codex" && raw.cumulative) {
            // Without response endpoints the cumulative mirror cannot be reconciled safely.
            if (uncertain) {
              issues++;
              continue;
            }
            // Intermediate legacy snapshots may overlap a native request. Its matching endpoint
            // recovers the missing prefix once, rather than summing partial counters over it.
            if (native_range) {
              if (!covered) issues++;
              continue;
            }
            const session = raw.session;
            if (session !== last) {
              previous = { input: 0, cached: 0, output: 0 };
              last = session;
            }
            const next = raw.cumulative,
              input = next.input - previous.input,
              cached = next.cached - previous.cached,
              output = next.output - previous.output;
            if (input < 0 || cached < 0 || output < 0 || cached > input) {
              issues++;
              continue;
            }
            previous = next;
            if (covered) continue;
            if (input + output === 0) continue;
            event = {
              ...raw,
              input: input - cached,
              cachedInput: cached,
              output,
            };
          }
          visit(event);
        }
      }
      await sql`CLOSE ai_usage_history_read`.execute(tx);
    }
    return { issues };
  }
  async bounds(owner: string) {
    const result = await this.db
      .selectFrom("ai_usage_observations")
      .select([
        sql<string | null>`min(event->>'timestamp')`.as("oldest"),
        sql<string | null>`max(event->>'timestamp')`.as("newest"),
      ])
      .where("owner_id", "=", owner)
      .executeTakeFirstOrThrow();
    return result;
  }
  async activity(owner: string) {
    return this.db
      .selectFrom("ai_usage_sources")
      .select([
        sql<string | null>`min(checkpoint->'state'->>'firstSeen')`.as(
          "oldestActivity",
        ),
        sql<number>`count(distinct checkpoint->'state'->>'session') filter (where coalesce((checkpoint->'state'->>'usageRecords')::bigint,0)=0)`.as(
          "activityOnlySessions",
        ),
      ])
      .where("owner_id", "=", owner)
      .executeTakeFirstOrThrow();
  }
  async coverage(owner: string) {
    const rows = await this.db
      .selectFrom("ai_usage_sources")
      .select([
        "machine",
        sql<string>`count(*)`.as("files"),
        sql<string>`coalesce(sum((checkpoint->>'size')::bigint),0)`.as("bytes"),
        sql<string>`coalesce(sum((checkpoint->>'offset')::bigint),0)`.as(
          "indexedBytes",
        ),
        sql<string>`coalesce(sum((checkpoint->>'issues')::bigint),0)`.as(
          "issues",
        ),
        sql<Date>`max(updated_at)`.as("updated_at"),
      ])
      .where("owner_id", "=", owner)
      .groupBy("machine")
      .orderBy("machine")
      .limit(129)
      .execute();
    if (rows.length > 128) throw new RangeError("Usage machine limit");
    return {
      sources: rows.map((r) => ({
        machine: r.machine,
        files: Number(r.files),
        bytes: Number(r.bytes),
        indexedBytes: Number(r.indexedBytes),
        issues: Number(r.issues),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    };
  }
}
