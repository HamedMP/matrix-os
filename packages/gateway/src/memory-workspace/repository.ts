import { createHash, randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql, type Dialect } from "kysely";
import pg from "pg";
import {
  MEMORY_ENGINES,
  MemoryImportRequestSchema,
  MemorySourcePatchSchema,
  type MemoryEngine,
  type MemorySource,
  type MemoryJob,
  type MemoryImportRequest,
  type MemoryImportResult,
  type MemorySourcePatch,
  type MemoryLibraryRequest,
  type MemorySearchResult,
} from "@matrix-os/contracts";
import { bootstrapMemoryDatabase, type MemoryDatabase } from "./database.js";
import {
  lockMemoryOwner,
  validateMemoryEvidence,
  type MemoryDb,
} from "./evidence.js";
import {
  enqueueRevisionCleanup,
  reconcileRevisionCleanup,
} from "./revision-cleanup.js";
export class MemoryConflictError extends Error {
  constructor() {
    super("Memory revision conflict");
  }
}
export class MemoryNotFoundError extends Error {
  constructor() {
    super("Memory source not found");
  }
}
export class MemoryLimitError extends Error {
  constructor() {
    super("Memory workspace limit reached");
  }
}
interface SourceRow {
  id: string;
  owner_id: string;
  title: string;
  content: string;
  kind: MemorySource["kind"];
  collection: string;
  revision: number;
  occurred_at: Date | string | null;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  content_truncated?: boolean;
}
interface JobRow {
  id: string;
  owner_id: string;
  source_id: string;
  engine: MemoryEngine;
  revision: number;
  operation: "upsert" | "delete";
  status: MemoryJob["status"];
  attempts: number;
  updated_at: Date | string;
  lease_token: string | null;
}
export interface LeasedMemoryJob extends MemoryJob {
  ownerId: string;
  leaseToken: string;
}
const iso = (v: Date | string) => new Date(v).toISOString();
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const job = (r: JobRow): MemoryJob => ({
  id: r.id,
  sourceId: r.source_id,
  engine: r.engine,
  revision: r.revision,
  operation: r.operation,
  status: r.status,
  attempts: r.attempts,
  updatedAt: iso(r.updated_at),
});
type Db = MemoryDb;
export class MemoryWorkspaceRepository {
  readonly kysely: Kysely<MemoryDatabase>;
  private ownsConnection: boolean;
  constructor(dialectOrDb: Dialect | Kysely<MemoryDatabase>) {
    this.ownsConnection = !(dialectOrDb instanceof Kysely);
    this.kysely =
      dialectOrDb instanceof Kysely
        ? dialectOrDb
        : new Kysely({ dialect: dialectOrDb });
  }
  static fromConnectionString(connectionString: string) {
    const pool = new pg.Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
    });
    pool.on("error", (err) =>
      console.error("[memory-workspace] Database pool error", err.name),
    );
    return new MemoryWorkspaceRepository(new PostgresDialect({ pool }));
  }
  bootstrap() {
    return bootstrapMemoryDatabase(this.kysely);
  }
  async destroy() {
    if (this.ownsConnection) await this.kysely.destroy();
  }
  private async enqueue(db: Db, r: SourceRow, operation: "upsert" | "delete") {
    await sql`UPDATE memory_workspace_jobs SET status='cancelled',updated_at=now() WHERE source_id=${r.id} AND operation='upsert' AND status IN ('pending','failed')`.execute(
      db,
    );
    if (operation === "upsert") {
      for (const engine of MEMORY_ENGINES)
        await sql`INSERT INTO memory_workspace_jobs(id,owner_id,source_id,engine,revision,operation,status) VALUES(${randomUUID()},${r.owner_id},${r.id},${engine},${r.revision},'upsert','pending') ON CONFLICT DO NOTHING`.execute(
          db,
        );
    }
    await enqueueRevisionCleanup(db, r);
    if (r.revision > 1) {
      // Queries can quote originals too; erase the owner's bounded comparison history.
      await sql`DELETE FROM memory_workspace_comparisons WHERE owner_id=${r.owner_id}`.execute(
        db,
      );
    }
  }
  private async hydrate(db: Db, rows: SourceRow[]): Promise<MemorySource[]> {
    if (!rows.length) return [];
    const receipts = (
      await sql<JobRow>`SELECT jobs.* FROM memory_workspace_jobs jobs JOIN (VALUES ${sql.join(rows.map((row) => sql`(${row.id}::uuid,${row.revision}::integer)`))}) AS current_source(id,revision) ON jobs.source_id=current_source.id AND jobs.revision=current_source.revision WHERE jobs.operation='upsert' ORDER BY jobs.updated_at DESC`.execute(
        db,
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      preview: r.content.slice(0, 240),
      kind: r.kind,
      collection: r.collection,
      revision: r.revision,
      occurredAt: r.occurred_at ? iso(r.occurred_at) : null,
      updatedAt: iso(r.updated_at),
      ingestion: Object.fromEntries(
        MEMORY_ENGINES.map((e) => {
          const j = receipts.find(
            (j) =>
              j.source_id === r.id &&
              j.engine === e &&
              j.revision === r.revision &&
              j.operation === "upsert",
          );
          return [
            e,
            j?.status ?? "pending",
          ];
        }),
      ) as MemorySource["ingestion"],
    }));
  }
  async listSources(
    owner: string,
    options: Partial<MemoryLibraryRequest> = {},
  ) {
    const rows = (
      await sql<SourceRow>`SELECT id,owner_id,title,left(content,240) AS content,char_length(content)>240 AS content_truncated,kind,collection,revision,occurred_at,updated_at,deleted_at FROM memory_workspace_sources WHERE owner_id=${owner} AND deleted_at IS NULL AND (${!options.kind} OR kind=${options.kind ?? ""}) AND (${!options.collection} OR collection=${options.collection ?? ""}) AND (${!options.q} OR search_text @@ plainto_tsquery('simple',${options.q ?? ""})) ORDER BY updated_at DESC,id LIMIT ${options.limit ?? 500} OFFSET ${options.cursor ?? 0}`.execute(
        this.kysely,
      )
    ).rows;
    return (await this.hydrate(this.kysely, rows)).map((s, index) => ({
      ...s,
      content: s.preview,
      contentTruncated: rows[index].content_truncated === true,
    }));
  }
  async countSources(
    owner: string,
    options: Partial<MemoryLibraryRequest> = {},
  ) {
    const row = (
      await sql<{
        total: string;
        filtered: string;
      }>`SELECT count(*)::text AS total,count(*) FILTER(WHERE (${!options.q} OR search_text @@ plainto_tsquery('simple',${options.q ?? ""})) AND (${!options.kind} OR kind=${options.kind ?? ""}) AND (${!options.collection} OR collection=${options.collection ?? ""}))::text AS filtered FROM memory_workspace_sources WHERE owner_id=${owner} AND deleted_at IS NULL`.execute(
        this.kysely,
      )
    ).rows[0];
    return {
      totalSources: Number(row.total),
      filteredSources: Number(row.filtered),
    };
  }
  async collections(owner: string) {
    const rows = (
      await sql<{
        name: string;
        count: string;
      }>`SELECT collection AS name,count(*)::text AS count FROM memory_workspace_sources WHERE owner_id=${owner} AND deleted_at IS NULL GROUP BY collection ORDER BY count(*) DESC,collection LIMIT 201`.execute(
        this.kysely,
      )
    ).rows;
    return {
      collections: rows
        .slice(0, 200)
        .map((r) => ({ name: r.name, count: Number(r.count) })),
      collectionsTruncated: rows.length > 200,
    };
  }
  async revalidateSearch(owner: string, results: MemorySearchResult[]) {
    return this.kysely.transaction().execute(async (db) => {
      await lockMemoryOwner(db, owner);
      return (await validateMemoryEvidence(db, owner, results)).current;
    });
  }
  async recordComparison(
    owner: string,
    query: string,
    results: MemorySearchResult[],
  ): Promise<MemorySearchResult[]> {
    return this.kysely.transaction().execute(async (db) => {
      await lockMemoryOwner(db, owner);
      const { current, invalidated } = await validateMemoryEvidence(
        db,
        owner,
        results,
      );
      // The query itself can quote deleted or corrected content. Skip the whole durable
      // history entry when evidence changed, while returning only currently valid hits.
      // Delete, revision writes and this revalidation share the same owner row lock.
      if (invalidated) return current;
      // A receipt records that a comparison occurred, without retaining arbitrary
      // query text that may quote a forgotten original even when there are no hits.
      await sql`INSERT INTO memory_workspace_comparisons(id,owner_id,query,results) VALUES(${randomUUID()},${owner},'[query omitted]',${JSON.stringify(current)}::jsonb)`.execute(
        db,
      );
      await sql`DELETE FROM memory_workspace_comparisons WHERE owner_id=${owner} AND id IN(SELECT id FROM memory_workspace_comparisons WHERE owner_id=${owner} ORDER BY created_at DESC OFFSET 1000)`.execute(
        db,
      );
      return current;
    });
  }
  async getSource(owner: string, id: string) {
    const row = (
      await sql<SourceRow>`SELECT * FROM memory_workspace_sources WHERE owner_id=${owner} AND id=${id} AND deleted_at IS NULL`.execute(
        this.kysely,
      )
    ).rows[0];
    return row ? (await this.hydrate(this.kysely, [row]))[0] : null;
  }
  async listJobs(owner: string) {
    return (
      await sql<JobRow>`SELECT * FROM memory_workspace_jobs WHERE owner_id=${owner} ORDER BY updated_at DESC LIMIT 200`.execute(
        this.kysely,
      )
    ).rows.map(job);
  }
  async importSources(
    owner: string,
    input: MemoryImportRequest,
  ): Promise<MemoryImportResult> {
    const req = MemoryImportRequestSchema.parse(input);
    const digest = hash(req.sources);
    return this.kysely.transaction().execute(async (db) => {
      await lockMemoryOwner(db, owner);
      const existing = (
        await sql<{
          request_hash: string;
          source_ids: string[];
        }>`SELECT request_hash,source_ids FROM memory_workspace_imports WHERE owner_id=${owner} AND request_id=${req.clientRequestId}`.execute(
          db,
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== digest) throw new MemoryConflictError();
        const rows = (
          await sql<SourceRow>`SELECT * FROM memory_workspace_sources WHERE owner_id=${owner} AND id IN (${sql.join(existing.source_ids)}) AND deleted_at IS NULL`.execute(
            db,
          )
        ).rows;
        return {
          sources: await this.hydrate(db, rows),
          receipt: {
            clientRequestId: req.clientRequestId,
            sourceIds: existing.source_ids,
          },
        };
      }
      const sourceIds: string[] = [];
      const rows: SourceRow[] = [];
      for (const s of req.sources) {
        const { restoreDeleted, ...original } = s;
        const r = (
          await sql<SourceRow>`INSERT INTO memory_workspace_sources(id,owner_id,external_id,title,content,kind,collection,revision,content_hash,metadata,occurred_at) VALUES(${randomUUID()},${owner},${s.externalId},${s.title},${s.content},${s.kind},${s.collection},1,${hash(original)},${JSON.stringify(s.metadata ?? {})}::jsonb,${s.occurredAt ?? null}) ON CONFLICT(owner_id,external_id) DO UPDATE SET title=excluded.title,content=excluded.content,kind=excluded.kind,collection=excluded.collection,metadata=excluded.metadata,occurred_at=excluded.occurred_at,content_hash=excluded.content_hash,revision=memory_workspace_sources.revision+1,updated_at=now(),deleted_at=NULL WHERE (memory_workspace_sources.deleted_at IS NULL OR ${restoreDeleted === true}) AND (memory_workspace_sources.content_hash<>excluded.content_hash OR memory_workspace_sources.deleted_at IS NOT NULL) RETURNING *`.execute(
            db,
          )
        ).rows[0];
        const row =
          r ??
          (
            await sql<SourceRow>`SELECT * FROM memory_workspace_sources WHERE owner_id=${owner} AND external_id=${s.externalId}`.execute(
              db,
            )
          ).rows[0];
        if (row.deleted_at !== null) throw new MemoryConflictError();
        if (r) await this.enqueue(db, row, "upsert");
        sourceIds.push(row.id);
        rows.push(row);
      }
      const quota = (
        await sql<{
          count: string;
          bytes: string;
        }>`SELECT count(*) FILTER(WHERE deleted_at IS NULL)::text AS count,COALESCE(sum(octet_length(content)),0)::text AS bytes FROM memory_workspace_sources WHERE owner_id=${owner}`.execute(
          db,
        )
      ).rows[0];
      if (Number(quota.count) > 100000 || Number(quota.bytes) > 1000000000)
        throw new MemoryLimitError();
      await sql`INSERT INTO memory_workspace_imports(owner_id,request_id,request_hash,source_ids) VALUES(${owner},${req.clientRequestId},${digest},${JSON.stringify(sourceIds)}::jsonb) ON CONFLICT DO NOTHING`.execute(
        db,
      );
      return {
        sources: await this.hydrate(db, rows),
        receipt: { clientRequestId: req.clientRequestId, sourceIds },
      };
    });
  }
  async patchSource(owner: string, id: string, input: MemorySourcePatch) {
    const req = MemorySourcePatchSchema.parse(input);
    return this.kysely.transaction().execute(async (db) => {
      await lockMemoryOwner(db, owner);
      if (req.content) {
        const quota = (
          await sql<{
            bytes: string;
          }>`SELECT COALESCE(sum(octet_length(content)),0)::text AS bytes FROM memory_workspace_sources WHERE owner_id=${owner} AND deleted_at IS NULL AND id<>${id}`.execute(
            db,
          )
        ).rows[0];
        if (Number(quota.bytes) + Buffer.byteLength(req.content) > 1000000000)
          throw new MemoryLimitError();
      }
      const row = (
        await sql<SourceRow>`UPDATE memory_workspace_sources SET title=COALESCE(${req.title ?? null},title),content=COALESCE(${req.content ?? null},content),collection=COALESCE(${req.collection ?? null},collection),revision=revision+1,content_hash=${hash({ id, ...req })},updated_at=now() WHERE owner_id=${owner} AND id=${id} AND revision=${req.baseRevision} AND deleted_at IS NULL RETURNING *`.execute(
          db,
        )
      ).rows[0];
      if (!row) {
        const current = (await sql`SELECT id FROM memory_workspace_sources WHERE owner_id=${owner} AND id=${id} AND deleted_at IS NULL`.execute(db)).rows[0];
        if (!current) throw new MemoryNotFoundError();
        throw new MemoryConflictError();
      }
      await this.enqueue(db, row, "upsert");
      return (await this.hydrate(db, [row]))[0];
    });
  }
  async deleteSource(owner: string, id: string) {
    return this.kysely.transaction().execute(async (db) => {
      await lockMemoryOwner(db, owner);
      const row = (
        await sql<SourceRow>`UPDATE memory_workspace_sources SET deleted_at=now(),updated_at=now(),content='',title='Deleted source',collection='Deleted',occurred_at=NULL,metadata='{}',revision=revision+1 WHERE owner_id=${owner} AND id=${id} AND deleted_at IS NULL RETURNING *`.execute(
          db,
        )
      ).rows[0];
      if (row) {
        await this.enqueue(db, row, "delete");
        // Comparison queries may quote the original; erase this owner's bounded history.
        await sql`DELETE FROM memory_workspace_comparisons WHERE owner_id=${owner}`.execute(
          db,
        );
      }
      return Boolean(row);
    });
  }
  async claimJob(
    engine: MemoryEngine,
    leaseMs = 120000,
  ): Promise<LeasedMemoryJob | null> {
    return this.kysely.transaction().execute(async (db) => {
      await sql`UPDATE memory_workspace_jobs SET status='failed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE engine=${engine} AND status='processing' AND lease_until<now() AND attempts>=3`.execute(
        db,
      );
      const r = (
        await sql<JobRow>`SELECT j.* FROM memory_workspace_jobs j JOIN memory_workspace_sources s ON s.id=j.source_id WHERE j.engine=${engine} AND j.attempts<3 AND j.available_at<=now() AND (j.status='pending' OR (j.status='processing' AND j.lease_until<now())) AND NOT EXISTS(SELECT 1 FROM memory_workspace_jobs other WHERE other.source_id=j.source_id AND other.engine=j.engine AND other.id<>j.id AND other.status='processing' AND other.lease_until>=now()) ORDER BY j.updated_at,CASE WHEN j.operation='upsert' THEN 0 ELSE 1 END,j.revision DESC LIMIT 1 FOR UPDATE OF s,j SKIP LOCKED`.execute(
          db,
        )
      ).rows[0];
      if (!r) return null;
      const leaseToken = randomUUID();
      const updated = (
        await sql<JobRow>`UPDATE memory_workspace_jobs SET status='processing',attempts=attempts+1,lease_token=${leaseToken},lease_until=now()+${leaseMs}*interval '1 millisecond',updated_at=now() WHERE id=${r.id} AND attempts<3 AND (status='pending' OR (status='processing' AND lease_until<now())) RETURNING *`.execute(
          db,
        )
      ).rows[0];
      if (!updated) return null;
      return { ...job(updated), ownerId: updated.owner_id, leaseToken };
    });
  }
  async finishJob(id: string, leaseToken: string, success: boolean) {
    const result =
      await sql`UPDATE memory_workspace_jobs SET status=CASE WHEN ${success} THEN 'ready' WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,available_at=now()+interval '5 seconds',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=${id} AND lease_token=${leaseToken} AND status='processing' RETURNING id`.execute(
        this.kysely,
      );
    return result.rows.length > 0;
  }
  async jobAction(owner: string, id: string, action: "retry" | "cancel") {
    const result =
      await sql`UPDATE memory_workspace_jobs SET status=${action === "retry" ? "pending" : "cancelled"},attempts=CASE WHEN ${action === "retry"} THEN 0 ELSE attempts END,available_at=now(),updated_at=now() WHERE id=${id} AND owner_id=${owner} AND status IN ('pending','failed','cancelled') AND (${action === "retry"} OR operation='upsert') RETURNING id`.execute(
        this.kysely,
      );
    return result.rows.length > 0;
  }
  async prune() {
    await this.kysely.transaction().execute(async (db) => {
      await reconcileRevisionCleanup(db);
      await sql`DELETE FROM memory_workspace_imports WHERE created_at<now()-interval '30 days'`.execute(
        db,
      );
    });
  }
}
