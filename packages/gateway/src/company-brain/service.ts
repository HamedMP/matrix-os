import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { SlackBridgeEnvelopeSchema } from "@matrix-os/contracts/slack-bridge";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { AuthorizedCollaborationContext, CollaborationAction, CollaborationAuthority } from "../collaboration/authority.js";
import { fenceSharedChatAuthority } from "../collaboration/shared-chat-authority.js";
import type { OwnerCollaborationDatabase } from "../collaboration/database.js";
import type { CompanyBrainDatabase, CompanyBrainDocumentsTable } from "./database.js";
import { BrainRevisionSchema, BrainScopeIdSchema, BrainSourceIdSchema, PublishBrainSourceSchema, SearchBrainSchema, type PublishBrainSource, type SearchBrain } from "./schemas.js";

export class CompanyBrainError extends Error {
  constructor(readonly code: "not_found" | "forbidden" | "conflict" | "capacity") {
    super("Company Brain request failed");
    this.name = "CompanyBrainError";
  }
}
export interface BrainCitation {
  sourceId: string;
  incarnation: string;
  audienceScopeId: string;
  title: string;
  permalink: string;
  revision: number;
  sourceUpdatedAt: string;
  publishedAt: string;
  updatedAt: string;
  provenance: "manually_published" | "slack_thread";
}
export interface BrainSearchResult extends BrainCitation { excerpt: string }
export interface BrainEvidenceProof {sourceId:string;incarnation:string;revision:number}
export interface CompanyBrainOptions {
  db: Kysely<CompanyBrainDatabase>;
  authority: Pick<CollaborationAuthority, "authorize">;
  ownerId: string;
  now?: () => Date;
  maxDocumentsPerScope?: number;
}
const MAX_SCOPE_BYTES = 8 * 1024 * 1024;
const MAX_RETRIEVAL_CHARS = 16_000;

/** Company context hosted by an individual owner; this is not organization-owned runtime provisioning. */
export class CompanyBrainService {
  private readonly now: () => Date;
  private readonly maxDocuments: number;
  constructor(private readonly options: CompanyBrainOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxDocuments = options.maxDocumentsPerScope ?? 1000;
    if (!options.ownerId || !Number.isInteger(this.maxDocuments) || this.maxDocuments < 1 || this.maxDocuments > 1000) {
      throw new Error("Invalid Company Brain configuration");
    }
  }

  private async authorize(scopeId: string, actorId: string, action: CollaborationAction, ownerOnly = false) {
    BrainScopeIdSchema.parse(scopeId);
    const context = await this.options.authority.authorize({ scopeId, actorId, action });
    if (context.scopeId !== scopeId || context.actorId !== actorId || context.ownerId !== this.options.ownerId
      || !context.organizationId || (ownerOnly && (context.ownerId !== actorId || context.role !== "owner"))) {
      throw new CompanyBrainError("forbidden");
    }
    return context;
  }

  private async binding(context: AuthorizedCollaborationContext, db: Kysely<CompanyBrainDatabase> | Transaction<CompanyBrainDatabase>) {
    const bound = await db.selectFrom("company_brain_scopes").selectAll().where("scope_id", "=", context.scopeId).executeTakeFirst();
    if (bound && (bound.organization_id !== context.organizationId || bound.owner_id !== context.ownerId
      || bound.resource_kind !== context.resourceKind || bound.resource_id !== context.resourceId)) {
      throw new CompanyBrainError("forbidden");
    }
    return bound;
  }

  /** Recheck live authority before returning derived data; no cached membership or read proof is accepted. */
  private async recheck(context: AuthorizedCollaborationContext, ownerOnly = false) {
    const current = await this.authorize(context.scopeId, context.actorId, context.capability, ownerOnly);
    if (current.authEpoch !== context.authEpoch || current.membershipEvidenceEpoch !== context.membershipEvidenceEpoch
      || current.authorityRuntimeId !== context.authorityRuntimeId || current.authorityGeneration !== context.authorityGeneration
      || current.resourceId !== context.resourceId || current.organizationId !== context.organizationId
      || current.ownerId !== context.ownerId) throw new CompanyBrainError("forbidden");
    await this.binding(current, this.options.db);
  }

  /** Authority callbacks can outlive a source erasure; validate loaded content after they settle. */
  private async assertCurrentSources(scopeId:string,rows:Array<Pick<Selectable<CompanyBrainDocumentsTable>,"source_id"|"incarnation"|"revision">>) {
    if(!rows.length) return;
    if(rows.length>1000) throw new CompanyBrainError("capacity");
    const current=await this.options.db.selectFrom("company_brain_documents").select(["source_id","incarnation","revision"])
      .where("scope_id","=",scopeId).where("source_id","in",rows.map(row=>row.source_id)).where("deleted_at","is",null).execute();
    if(current.length!==rows.length || rows.some(row=>!current.some(source=>source.source_id===row.source_id
      && source.incarnation===row.incarnation && source.revision===row.revision))) throw new CompanyBrainError("forbidden");
  }

  private async fenceOwner(context: AuthorizedCollaborationContext,trx: Transaction<CompanyBrainDatabase>) {
    const scope=await trx.selectFrom("collaboration_scopes").selectAll().where("id","=",context.scopeId).forUpdate().executeTakeFirst();
    const membership=scope?.id===context.membershipScopeId ? scope : await trx.selectFrom("collaboration_scopes").selectAll()
      .where("id","=",context.membershipScopeId).forUpdate().executeTakeFirst();
    const member=await trx.selectFrom("collaboration_members").selectAll().where("scope_id","=",context.membershipScopeId)
      .where("actor_id","=",context.ownerId).forUpdate().executeTakeFirst();
    if(!scope || !membership || !member || context.actorId!==context.ownerId || scope.deleted_at || membership.deleted_at
      || scope.lifecycle!=="shared" || membership.lifecycle!=="shared" || scope.owner_id!==context.ownerId
      || scope.resource_id!==context.resourceId || scope.kind!==context.resourceKind || scope.organization_id!==context.organizationId
      || scope.authority_runtime_id!==context.authorityRuntimeId || Number(scope.authority_generation)!==context.authorityGeneration
      || membership.owner_id!==context.ownerId || membership.organization_id!==context.organizationId
      || membership.authority_runtime_id!==context.authorityRuntimeId || Number(membership.authority_generation)!==context.authorityGeneration
      || (scope.membership_mode==="direct" && (scope.parent_scope_id!==null || membership.id!==scope.id))
      || (scope.membership_mode==="inherited" && (scope.parent_scope_id!==membership.id || membership.kind!=="project"))
      || Number(scope.auth_epoch)!==(context.resourceAuthEpoch ?? context.authEpoch)
      || Number(membership.auth_epoch)!==(context.membershipAuthEpoch ?? context.authEpoch)
      || member.organization_id!==context.organizationId || member.role!=="owner" || member.status!=="accepted" || member.dispositioned_at!==null
      || (member.expires_at!==null && new Date(member.expires_at).getTime()<=this.now().getTime())) throw new CompanyBrainError("forbidden");
  }
  private async fenceRun(context: AuthorizedCollaborationContext,trx: Transaction<CompanyBrainDatabase>) {
    const scope=await trx.selectFrom("collaboration_scopes").selectAll().where("id","=",context.scopeId).forUpdate().executeTakeFirst();
    if(!scope) throw new CompanyBrainError("forbidden");
    await fenceSharedChatAuthority(trx as unknown as Transaction<OwnerCollaborationDatabase>,scope,context,context.actorId,"request_ai");
  }

  async publish(scopeId: string, actorId: string, source: PublishBrainSource): Promise<BrainCitation> {
    const input = PublishBrainSourceSchema.parse(source);
    const context = await this.authorize(scopeId, actorId, "publish_snapshot", true);
    // Explicit publication into this scope is required; personal/private sources are never copied automatically.
    if (input.audienceScopeId !== scopeId) throw new CompanyBrainError("forbidden");
    return this.writeSource(context, input, "manually_published");
  }

  private async writeSource(context: AuthorizedCollaborationContext, input: z.output<typeof PublishBrainSourceSchema>, provenance: BrainCitation["provenance"], runContext?: AuthorizedCollaborationContext) {
    const scopeId=context.scopeId;
    return this.options.db.transaction().execute(async (trx) => {
      await trx.insertInto("company_brain_scopes").values({ scope_id: scopeId, organization_id: context.organizationId, owner_id: context.ownerId,
        resource_kind: context.resourceKind, resource_id: context.resourceId, created_at: this.now() })
        .onConflict((oc) => oc.column("scope_id").doNothing()).execute();
      // One scope lock serializes CAS, admission counts, and erasure.
      await trx.selectFrom("company_brain_scopes").select("scope_id").where("scope_id", "=", scopeId).forUpdate().executeTakeFirstOrThrow();
      if(runContext) await this.fenceRun(runContext,trx);
      await this.fenceOwner(context,trx);
      await this.binding(context, trx);
      const existing = await trx.selectFrom("company_brain_documents").selectAll().where("scope_id", "=", scopeId).where("source_id", "=", input.sourceId).executeTakeFirst();
      if (existing && !existing.deleted_at && provenance === "slack_thread") {
        if (existing.provenance !== "slack_thread") throw new CompanyBrainError("conflict");
        return citation(existing);
      }
      if (existing?.deleted_at || (existing?.revision ?? 0) !== input.expectedRevision) throw new CompanyBrainError("conflict");
      const usage = await trx.selectFrom("company_brain_documents").select([
        sql<string>`count(*)`.as("count"), sql<string>`coalesce(sum(byte_count), 0)`.as("bytes"),
      ]).where("scope_id", "=", scopeId).executeTakeFirstOrThrow();
      const bytes = Buffer.byteLength(input.text, "utf8") + Buffer.byteLength(input.title, "utf8");
      if ((!existing && Number(usage.count) >= this.maxDocuments) || Number(usage.bytes) - (existing?.byte_count ?? 0) + bytes > MAX_SCOPE_BYTES) {
        throw new CompanyBrainError("capacity");
      }
      const now = this.now();
      const values = { title: input.title, text: input.text, permalink: input.permalink, source_updated_at: input.sourceUpdatedAt,
        updated_at: now, revision: input.expectedRevision + 1, byte_count: bytes };
      let row: Selectable<CompanyBrainDocumentsTable>;
      if (existing) {
        const updated = await trx.updateTable("company_brain_documents").set(values).where("scope_id", "=", scopeId)
          .where("source_id", "=", input.sourceId).where("revision", "=", input.expectedRevision).where("deleted_at", "is", null).returningAll().executeTakeFirst();
        if (!updated) throw new CompanyBrainError("conflict");
        row = updated;
      } else {
        const created = await trx.insertInto("company_brain_documents").values({ ...values, scope_id: scopeId, source_id: input.sourceId,
          published_at: now, provenance, deleted_at: null }).onConflict((oc) => oc.columns(["scope_id", "source_id"]).doNothing()).returningAll().executeTakeFirst();
        if (!created) throw new CompanyBrainError("conflict");
        row = created;
      }
      return citation(row);
    });
  }

  /** Internal transport capability only. No HTTP route lets an editor assert publication consent. */
  async captureSlackMention(sourceScopeId: string, runScopeId: string, actorId: string, raw: {
    approval: {ownerId:string;organizationId:string;scopeId:string}; appId:string;teamId:string;channelId:string;
    eventId:string;ts:string;threadTs?:string;text:string;
  }) {
    const input=z.object({approval:z.object({ownerId:z.string().max(256),organizationId:z.string().max(256),scopeId:BrainScopeIdSchema}).strict(),
      ...SlackBridgeEnvelopeSchema.shape.event.pick({appId:true,teamId:true,channelId:true,eventId:true,ts:true,threadTs:true}).shape,
      text:z.string().min(1).max(32_000)}).strict().parse(raw);
    const owner=await this.authorize(sourceScopeId,this.options.ownerId,"publish_snapshot",true);
    const run=await this.authorize(runScopeId,actorId,"request_ai");
    if (input.approval.ownerId !== owner.ownerId || input.approval.organizationId !== owner.organizationId || input.approval.scopeId !== owner.scopeId
      || owner.resourceKind !== "project" || owner.membershipScopeId !== owner.scopeId || run.resourceKind !== "chat"
      || run.membershipScopeId !== owner.scopeId || run.organizationId !== owner.organizationId || run.ownerId !== owner.ownerId
      || run.authorityRuntimeId !== owner.authorityRuntimeId || run.authorityGeneration !== owner.authorityGeneration) throw new CompanyBrainError("forbidden");
    const sourceId=createHash("sha256").update(JSON.stringify([input.appId,input.teamId,input.channelId,input.eventId])).digest("hex");
    const permalink=`https://app.slack.com/client/${input.teamId}/${input.channelId}/thread/${input.channelId}-${input.threadTs ?? input.ts}`;
    const source=PublishBrainSourceSchema.parse({sourceId,audienceScopeId:sourceScopeId,title:"Slack company thread",text:input.text,permalink,
      sourceUpdatedAt:new Date(Number(input.ts)*1000).toISOString(),expectedRevision:0});
    return this.writeSource(owner,source,"slack_thread",run);
  }

  async get(scopeId: string, actorId: string, sourceId: string) {
    BrainSourceIdSchema.parse(sourceId);
    const context = await this.authorize(scopeId, actorId, "read");
    await this.binding(context, this.options.db);
    const row = await this.options.db.selectFrom("company_brain_documents").selectAll().where("scope_id", "=", scopeId)
      .where("source_id", "=", sourceId).where("deleted_at", "is", null).executeTakeFirst();
    await this.recheck(context);
    if (!row) throw new CompanyBrainError("not_found");
    await this.assertCurrentSources(scopeId,[row]);
    return { ...citation(row), text: row.text };
  }

  async search(scopeId: string, actorId: string, input: SearchBrain): Promise<BrainSearchResult[]> {
    return this.find(scopeId, actorId, input, "read");
  }

  /** Bounded all-source snapshot after live authority and any trusted transport receipt fence. */
  async verifyEvidence(scopeId:string,actorId:string,raw:BrainEvidenceProof[],beforeRead?:()=>Promise<void>):Promise<true> {
    const proofs=z.array(z.object({sourceId:BrainSourceIdSchema,incarnation:z.uuid(),revision:BrainRevisionSchema.refine(value=>value>0)}).strict()).max(6).parse(raw);
    const context=await this.authorize(scopeId,actorId,"read");
    await this.binding(context,this.options.db);
    await this.recheck(context);
    await beforeRead?.();
    await this.assertCurrentSources(scopeId,proofs.map(proof=>({source_id:proof.sourceId,incarnation:proof.incarnation,revision:proof.revision})));
    return true;
  }

  private async find(scopeId: string, actorId: string, input: SearchBrain, action: "read" | "request_ai", naturalQuestion=false) {
    const query = SearchBrainSchema.parse(input);
    const context = await this.authorize(scopeId, actorId, action);
    await this.binding(context, this.options.db);
    const terms=naturalQuestion ? sql`replace(plainto_tsquery('english',${query.query})::text,' & ',' | ')::tsquery`
      : sql`plainto_tsquery('english',${query.query})`;
    const rows = await this.options.db.selectFrom("company_brain_documents").selectAll().where("scope_id", "=", scopeId)
      .select(sql<string>`ts_headline('english',text,${terms},'MaxWords=150,MinWords=20,StartSel="",StopSel=""')`.as("matched_excerpt"))
      .where("deleted_at", "is", null)
      .where(sql<boolean>`to_tsvector('english', title || ' ' || text) @@ ${terms}`)
      .orderBy(sql<number>`ts_rank_cd(to_tsvector('english',title || ' ' || text),${terms})`,"desc")
      .orderBy("updated_at", "desc").orderBy("source_id", "asc").limit(query.limit).execute();
    await this.recheck(context);
    await this.assertCurrentSources(scopeId,rows);
    return rows.map((row) => ({ ...citation(row), excerpt: row.matched_excerpt.slice(0, 2000) }));
  }

  /** Harness-neutral data only. Consumers must keep source text untrusted and recheck authority before output. */
  async retrieve(scopeId: string, actorId: string, input: SearchBrain) {
    const results = await this.find(scopeId, actorId, input, "request_ai",true);
    return { trust: "untrusted_source_material" as const, scopeId, sources: boundContext(results) };
  }

  /** A Project Brain may serve only a runnable Chat inheriting that exact Project audience. */
  async retrieveForRun(sourceScopeId: string, runScopeId: string, actorId: string, input: SearchBrain) {
    const source = await this.authorize(sourceScopeId, actorId, "read");
    const run = await this.authorize(runScopeId, actorId, "request_ai");
    if (source.resourceKind !== "project" || source.membershipScopeId !== source.scopeId
      || run.resourceKind !== "chat" || run.membershipScopeId !== source.scopeId
      || run.organizationId !== source.organizationId || run.ownerId !== source.ownerId
      || run.authorityRuntimeId !== source.authorityRuntimeId || run.authorityGeneration !== source.authorityGeneration) {
      throw new CompanyBrainError("forbidden");
    }
    const results = await this.find(sourceScopeId, actorId, input, "read",true);
    await this.recheck(run);
    await this.assertCurrentSources(sourceScopeId,results.map(source=>({source_id:source.sourceId,incarnation:source.incarnation,revision:source.revision})));
    return { trust: "untrusted_source_material" as const, scopeId: sourceScopeId, runScopeId,
      sources: boundContext(results) };
  }

  async export(scopeId: string, actorId: string) {
    const context = await this.authorize(scopeId, actorId, "read", true);
    await this.binding(context, this.options.db);
    const rows = await this.options.db.selectFrom("company_brain_documents").selectAll().where("scope_id", "=", scopeId)
      .where("deleted_at", "is", null).orderBy("source_id", "asc").limit(1001).execute();
    if (rows.length > 1000 || rows.reduce((n, row) => n + row.byte_count, 0) > MAX_SCOPE_BYTES) throw new CompanyBrainError("capacity");
    await this.recheck(context, true);
    await this.assertCurrentSources(scopeId,rows);
    return { version: 1, hosting: "owner_hosted" as const, organizationId: context.organizationId, ownerId: context.ownerId,
      scopeId, exportedAt: this.now().toISOString(), documents: rows.map((row) => ({ ...citation(row), text: row.text })) };
  }

  async remove(scopeId: string, actorId: string, sourceId: string, expectedRevision: number) {
    BrainSourceIdSchema.parse(sourceId);
    BrainRevisionSchema.parse(expectedRevision);
    const context = await this.authorize(scopeId, actorId, "publish_snapshot", true);
    await this.options.db.transaction().execute(async (trx) => {
      await trx.selectFrom("company_brain_scopes").select("scope_id").where("scope_id", "=", scopeId).forUpdate().execute();
      await this.fenceOwner(context,trx);
      await this.binding(context, trx);
      const row = await trx.selectFrom("company_brain_documents").selectAll().where("scope_id", "=", scopeId)
        .where("source_id", "=", sourceId).where("deleted_at", "is", null).executeTakeFirst();
      if (!row) throw new CompanyBrainError("not_found");
      const removed = await trx.updateTable("company_brain_documents").set({ text: "", title: "", permalink: "", byte_count: 0,
        deleted_at: this.now(), updated_at: this.now(), revision: expectedRevision + 1 })
        .where("scope_id", "=", scopeId).where("source_id", "=", sourceId).where("revision", "=", expectedRevision)
        .where("deleted_at", "is", null).returning("source_id").executeTakeFirst();
      if (!removed) throw new CompanyBrainError("conflict");
    });
  }

  async erase(scopeId: string, actorId: string) {
    const context = await this.authorize(scopeId, actorId, "publish_snapshot", true);
    await this.options.db.transaction().execute(async (trx) => {
      await trx.selectFrom("company_brain_scopes").select("scope_id").where("scope_id", "=", scopeId).forUpdate().execute();
      await this.fenceOwner(context,trx);
      await this.binding(context, trx);
      await trx.deleteFrom("company_brain_documents").where("scope_id", "=", scopeId).execute();
      await trx.deleteFrom("company_brain_scopes").where("scope_id", "=", scopeId).execute();
    });
  }
}

function citation(row: Selectable<CompanyBrainDocumentsTable>): BrainCitation {
  return { sourceId: row.source_id, incarnation: row.incarnation, audienceScopeId: row.scope_id, title: row.title, permalink: row.permalink, revision: row.revision,
    sourceUpdatedAt: new Date(row.source_updated_at).toISOString(), publishedAt: new Date(row.published_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(), provenance: row.provenance };
}

function boundContext(results: BrainSearchResult[]): BrainSearchResult[] {
  let remaining = MAX_RETRIEVAL_CHARS;
  const sources: BrainSearchResult[] = [];
  for (const result of results) {
    if (remaining <= 0) break;
    const excerpt = result.excerpt.slice(0, remaining);
    sources.push({ ...result, excerpt });
    remaining -= excerpt.length;
  }
  return sources;
}
