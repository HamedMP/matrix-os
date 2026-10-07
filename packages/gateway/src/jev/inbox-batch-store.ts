import { Kysely, sql, type ColumnType } from "kysely";
import { z } from "zod/v4";
import { JevInboxGmailIdSchema } from "@matrix-os/contracts";
export const BatchJobId = z.string().regex(/^jev_batch_[a-f0-9]{32}$/);
const Item = z.object({ id: JevInboxGmailIdSchema, status: z.enum(["labeled", "no_op", "review", "proposal", "unconfirmed"]), messages: z.number().int().min(0).max(4) });
export const BatchDocumentSchema = z.object({ jobId: BatchJobId, ownerId: z.string().min(1).max(256), agentId: z.string().min(1).max(160),
  binding: z.string().regex(/^[a-f0-9]{64}$/), activeRunId: z.string().min(1).max(160).nullable().default(null), revision: z.number().int().min(1), status: z.enum(["ready", "running", "paused", "completed", "completed_with_unconfirmed", "limit_reached"]),
  maxThreads: z.number().int().min(1).max(10000), createdAt: z.number().int(), expiresAt: z.number().int(),
  queue: z.array(JevInboxGmailIdSchema).max(30), pageToken: z.string().min(1).max(4096).nullable(), listed: z.boolean(),
  items: z.array(Item).max(10000), pages: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000).default([]),
  pending: z.object({ threadId: JevInboxGmailIdSchema.nullable(), attempt: z.string().max(160), runId: z.string().max(160) }).nullable(),
  last: z.object({ threadId: JevInboxGmailIdSchema, status: Item.shape.status }).nullable() });
export type BatchDocument = z.infer<typeof BatchDocumentSchema>;
export interface JevInboxBatchStore {
  get(ownerId: string, agentId: string, jobId?: string): Promise<BatchDocument | null>;
  open(document: BatchDocument): Promise<BatchDocument>;
  save(document: BatchDocument, baseRevision: number): Promise<BatchDocument>;
}
interface Table {
  owner_id: string;
  agent_id: string;
  job_id: string;
  binding: string;
  revision: number;
  document: ColumnType<unknown, string, string>;
  expires_at: ColumnType<Date, Date, Date>;
}
interface Database {
  jev_inbox_batches: Table;
}
const parse = (value: unknown) => BatchDocumentSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
/** Uses the owner database pool without owning or closing it. */
export class JevInboxBatchRepository implements JevInboxBatchStore {
  private readonly db: Kysely<Database>;
  constructor(db: Kysely<any>) { this.db = db as Kysely<Database>; }
  async bootstrap(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql `SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('jev_inbox_batches'))`.execute(trx);
      await sql `CREATE TABLE IF NOT EXISTS jev_inbox_batches (
owner_id TEXT NOT NULL,agent_id TEXT NOT NULL,job_id TEXT NOT NULL,binding TEXT NOT NULL,
revision INTEGER NOT NULL,document JSONB NOT NULL,expires_at TIMESTAMPTZ NOT NULL,
PRIMARY KEY(owner_id,job_id))`.execute(trx);
      await sql `CREATE INDEX IF NOT EXISTS idx_jev_inbox_batches_owner ON jev_inbox_batches(owner_id,agent_id,expires_at)`.execute(trx);
    });
  }
  async get(ownerId: string, agentId: string, jobId?: string): Promise<BatchDocument | null> {
    let query = this.db.selectFrom("jev_inbox_batches").select("document").where("owner_id", "=", ownerId).where("agent_id", "=", agentId)
      .where("expires_at", ">", new Date());
    if (jobId)
      query = query.where("job_id", "=", BatchJobId.parse(jobId));
    const row = await query.orderBy("expires_at", "desc").executeTakeFirst();
    return row ? parse(row.document) : null;
  }
  async open(raw: BatchDocument): Promise<BatchDocument> {
    const document = BatchDocumentSchema.parse(raw);
    return this.db.transaction().execute(async (trx) => {
      await sql `SELECT pg_advisory_xact_lock(hashtext(${document.ownerId}),hashtext('jev_inbox_batches'))`.execute(trx);
      await trx.deleteFrom("jev_inbox_batches").where("owner_id", "=", document.ownerId).where("expires_at", "<=", new Date()).execute();
      const prior = await trx.selectFrom("jev_inbox_batches").selectAll().where("owner_id", "=", document.ownerId)
        .where("agent_id", "=", document.agentId).where("binding", "=", document.binding).orderBy("expires_at", "desc").execute();
      const exact = prior.find(row => row.job_id === document.jobId);
      if (exact)
        return parse(exact.document);
      const unfinished = prior.find(row => ["ready", "running", "paused"].includes(parse(row.document).status));
      if (unfinished)
        return parse(unfinished.document);
      const count = await trx.selectFrom("jev_inbox_batches").select(sql<number> `count(*)::int`.as("count")).where("owner_id", "=", document.ownerId).executeTakeFirstOrThrow();
      if (count.count >= 128)
        throw new Error("Inbox batch capacity unavailable");
      const row = await trx.insertInto("jev_inbox_batches").values({ owner_id: document.ownerId, agent_id: document.agentId, job_id: document.jobId, binding: document.binding,
        revision: document.revision, document: JSON.stringify(document), expires_at: new Date(document.expiresAt) })
        .onConflict(c => c.columns(["owner_id", "job_id"]).doNothing()).returning("document").executeTakeFirst();
      if (!row)
        throw new Error("Inbox batch conflict");
      return parse(row.document);
    });
  }
  async save(raw: BatchDocument, baseRevision: number): Promise<BatchDocument> {
    const document = BatchDocumentSchema.parse(raw);
    if (document.revision !== baseRevision + 1)
      throw new Error("Inbox batch revision invalid");
    const row = await this.db.updateTable("jev_inbox_batches").set({ document: JSON.stringify(document), revision: document.revision })
      .where("owner_id", "=", document.ownerId).where("agent_id", "=", document.agentId).where("job_id", "=", document.jobId)
      .where("binding", "=", document.binding).where("revision", "=", baseRevision).where("expires_at", ">", new Date()).returning("document").executeTakeFirst();
    if (!row)
      throw new Error("Inbox batch conflict");
    return parse(row.document);
  }
}
