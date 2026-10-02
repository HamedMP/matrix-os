import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { Hono } from "hono";
import { createCompanyBrainRoutes } from "../../packages/gateway/src/company-brain/routes.js";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { bootstrapCompanyBrainDatabase, type CompanyBrainDatabase } from "../../packages/gateway/src/company-brain/database.js";
import { CompanyBrainService } from "../../packages/gateway/src/company-brain/service.js";
import { allowAllOrganizationPrecondition, collaborationActors as actors, collaborationIds as ids, createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const sourceId = "a".repeat(64);
const at = new Date("2026-09-30T10:00:00.000Z");
const document = {
  sourceId, audienceScopeId: ids.scope, title: "Launch decision", text: "The release decision is to launch the mobile app in October.",
  permalink: "https://example.com/notes/launch", sourceUpdatedAt: at.toISOString(), expectedRevision: 0,
};

describe("owner-hosted Company Brain durable sources", () => {
  let fixture: CollaborationTestDatabase;
  let db: Kysely<CompanyBrainDatabase>;
  let service: CompanyBrainService;
  let authority: CollaborationAuthority;

  beforeEach(async () => {
    fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealCollaborationTestDatabase() : createCollaborationTestDatabase());
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    db = fixture.db as unknown as Kysely<CompanyBrainDatabase>;
    await bootstrapCompanyBrainDatabase(db);
    const repository = new CollaborationRepository(fixture.db, { now: () => at });
    await repository.createDirectScope({ scopeId: ids.scope, organizationId: "org_team", ownerId: actors.owner, kind: "chat", resourceId: ids.chat, authorityRuntimeId: ids.runtime });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", execution_generation: 1, execution_eligibility: {} }).where("id", "=", ids.scope).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: ids.scope, actor_id: actors.editor, organization_id: "org_team", role: "editor", status: "accepted", invitation_id: null, invited_by: actors.owner,
      accepted_at: at, expires_at: null, joined_at: at, updated_at: at, dispositioned_at: null,
    }).execute();
    authority = new CollaborationAuthority(repository, { now: () => at, organizationPrecondition: allowAllOrganizationPrecondition });
    service = new CompanyBrainService({ db, authority, ownerId: actors.owner, now: () => at });
  });
  afterEach(async () => { await fixture.destroy(); });

  it("stores source evidence durably, searches with citations, and retrieves under request_ai authority", async () => {
    const published = await service.publish(ids.scope, actors.owner, document);
    expect(published).toMatchObject({ revision: 1, provenance: "manually_published", sourceUpdatedAt: at.toISOString() });
    const restarted = new CompanyBrainService({ db, authority, ownerId: actors.owner, now: () => at });
    const result = await restarted.search(ids.scope, actors.editor, { query: "release decision", limit: 5 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sourceId, revision: 1, permalink: document.permalink, audienceScopeId: ids.scope });
    const context = await restarted.retrieve(ids.scope, actors.editor, { query: "mobile", limit: 5 });
    expect(context.sources).toHaveLength(1);
    expect(context.trust).toBe("untrusted_source_material");
    expect((await restarted.export(ids.scope, actors.owner)).documents[0].text).toBe(document.text);
  });

  it("requires owner publication and explicit identical source audience", async () => {
    await expect(service.publish(ids.scope, actors.editor, document)).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.publish(ids.scope, actors.owner, { ...document, audienceScopeId: "10000000-0000-4000-8000-000000000002" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await db.selectFrom("company_brain_documents").selectAll().execute()).toHaveLength(0);
  });

  it.each(["publish","remove","erase"] as const)("refuses %s when live organization membership is revoked after initial authorization",async(operation)=>{
    await service.publish(ids.scope,actors.owner,document);
    let member=true;
    const organizationPrecondition=createOrganizationPrecondition({now:()=>at,source:{assertMembership:async()=>member
      ? {member:true,expiresAt:new Date(at.getTime()+60_000).toISOString(),membershipEpoch:"1",aiSubmission:"members"}
      : {member:false}}});
    const live=new CollaborationAuthority(new CollaborationRepository(fixture.db,{now:()=>at}),{now:()=>at,organizationPrecondition});
    const guarded=new CompanyBrainService({db,ownerId:actors.owner,now:()=>at,authority:{organizationPrecondition,authorize:async(input)=>{
      const context=await live.authorize(input);member=false;return context;
    }}});
    const mutation=operation==="publish" ? guarded.publish(ids.scope,actors.owner,{...document,expectedRevision:1,text:"Revoked correction"})
      : operation==="remove" ? guarded.remove(ids.scope,actors.owner,sourceId,1) : guarded.erase(ids.scope,actors.owner);
    await expect(mutation).rejects.toMatchObject({code:"not_found"});
    expect(await db.selectFrom("company_brain_documents").select(["revision","text","deleted_at"]).executeTakeFirstOrThrow())
      .toMatchObject({revision:1,text:document.text,deleted_at:null});
    expect(await db.selectFrom("company_brain_scopes").select("scope_id").execute()).toHaveLength(1);
  });

  it("refuses writes when the organization membership epoch changes after initial authorization",async()=>{
    let epoch="1";
    const organizationPrecondition=createOrganizationPrecondition({now:()=>at,source:{assertMembership:async()=>({member:true,
      expiresAt:new Date(at.getTime()+60_000).toISOString(),membershipEpoch:epoch,aiSubmission:"members"})}});
    const live=new CollaborationAuthority(new CollaborationRepository(fixture.db,{now:()=>at}),{now:()=>at,organizationPrecondition});
    const guarded=new CompanyBrainService({db,ownerId:actors.owner,authority:{organizationPrecondition,authorize:async(input)=>{
      const context=await live.authorize(input);epoch="2";return context;
    }}});
    await expect(guarded.publish(ids.scope,actors.owner,document)).rejects.toMatchObject({code:"forbidden"});
    expect(await db.selectFrom("company_brain_scopes").select("scope_id").execute()).toEqual([]);
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toEqual([]);
  });

  it("accepts repeated current proofs but checks every duplicate incarnation and revision",async()=>{
    const source=await service.publish(ids.scope,actors.owner,document);
    const proof={sourceId,incarnation:source.incarnation,revision:source.revision};
    await expect(service.verifyEvidence(ids.scope,actors.editor,[proof,proof])).resolves.toBe(true);
    await expect(service.verifyEvidence(ids.scope,actors.editor,[proof,{...proof,revision:2}])).rejects.toMatchObject({code:"forbidden"});
    await expect(service.verifyEvidence(ids.scope,actors.editor,[proof,{...proof,incarnation:"10000000-0000-4000-8000-000000000099"}])).rejects.toMatchObject({code:"forbidden"});
    await expect(service.verifyEvidence(ids.scope,actors.editor,Array.from({length:7},()=>proof))).rejects.toMatchObject({name:"ZodError"});
  });

  it("returns empty evidence safely for stopword-only natural queries",async()=>{
    await service.publish(ids.scope,actors.owner,document);
    expect(await service.retrieve(ids.scope,actors.editor,{query:"the and for me"})).toMatchObject({sources:[]});
    expect(await service.search(ids.scope,actors.editor,{query:"the and for me"})).toEqual([]);
  });

  it("publishes under inherited owner membership and fences expiration after owner preflight",async()=>{
    const parent="10000000-0000-4000-8000-000000000030";
    const repository=new CollaborationRepository(fixture.db,{now:()=>at});
    await repository.createDirectScope({scopeId:parent,organizationId:"org_team",ownerId:actors.owner,kind:"project",resourceId:"inherited_brain",authorityRuntimeId:ids.runtime});
    await fixture.db.updateTable("collaboration_scopes").set({lifecycle:"shared"}).where("id","=",parent).execute();
    await fixture.db.updateTable("collaboration_scopes").set({membership_mode:"inherited",parent_scope_id:parent}).where("id","=",ids.scope).execute();
    await service.publish(ids.scope,actors.owner,document);
    expect((await service.get(ids.scope,actors.owner,sourceId)).text).toBe(document.text);
    const expiring=new CompanyBrainService({db,ownerId:actors.owner,now:()=>at,authority:{organizationPrecondition:authority.organizationPrecondition,authorize:async(input)=>{
      const context=await authority.authorize(input);
      await fixture.db.updateTable("collaboration_members").set({expires_at:at}).where("scope_id","=",parent).where("actor_id","=",actors.owner).execute();
      return context;
    }}});
    await expect(expiring.publish(ids.scope,actors.owner,{...document,expectedRevision:1,text:"Expired correction"})).rejects.toMatchObject({code:"forbidden"});
    expect((await db.selectFrom("company_brain_documents").select("revision").executeTakeFirstOrThrow()).revision).toBe(1);
  });

  it("requires explicit revision for corrections and refuses to resurrect tombstones", async () => {
    await service.publish(ids.scope, actors.owner, document);
    await expect(service.publish(ids.scope, actors.owner, { ...document, text: "Actually launch in November" })).rejects.toMatchObject({ code: "conflict" });
    expect(await service.publish(ids.scope, actors.owner, { ...document, text: "Actually launch in November", expectedRevision: 1 })).toMatchObject({ revision: 2 });
    await expect(service.remove(ids.scope, actors.owner, sourceId, 1)).rejects.toMatchObject({ code: "conflict" });
    await service.remove(ids.scope, actors.owner, sourceId, 2);
    expect(await service.search(ids.scope, actors.owner, { query: "November", limit: 5 })).toEqual([]);
    expect((await service.export(ids.scope, actors.owner)).documents).toEqual([]);
    const row = await db.selectFrom("company_brain_documents").selectAll().executeTakeFirstOrThrow();
    expect(row.text).toBe("");
    expect(row.title).toBe("");
    expect(row.permalink).toBe("");
    await expect(service.publish(ids.scope, actors.owner, { ...document, expectedRevision: 3 })).rejects.toMatchObject({ code: "conflict" });
    await expect(service.remove(ids.scope, actors.owner, sourceId, 3)).rejects.toMatchObject({ code: "not_found" });
  });

  it("checks live membership for every source read, export, and AI retrieval", async () => {
    await service.publish(ids.scope, actors.owner, document);
    await fixture.db.updateTable("collaboration_members").set({ status: "revoked" }).where("actor_id", "=", actors.editor).execute();
    await expect(service.search(ids.scope, actors.editor, { query: "release", limit: 5 })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.get(ids.scope, actors.editor, sourceId)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.retrieve(ids.scope, actors.editor, { query: "release", limit: 5 })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.export(ids.scope, actors.editor)).rejects.toMatchObject({ code: "not_found" });
  });

  it("fails closed if bound owner, org, or resource identity changes", async () => {
    await service.publish(ids.scope, actors.owner, document);
    await fixture.db.updateTable("collaboration_scopes").set({ resource_id: "different_chat" }).where("id", "=", ids.scope).execute();
    await expect(service.search(ids.scope, actors.owner, { query: "release", limit: 5 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("separates read from execution eligibility", async () => {
    await service.publish(ids.scope, actors.owner, document);
    await fixture.db.updateTable("collaboration_scopes").set({ execution_generation: null }).where("id", "=", ids.scope).execute();
    expect(await service.search(ids.scope, actors.editor, { query: "release", limit: 5 })).toHaveLength(1);
    await expect(service.retrieve(ids.scope, actors.editor, { query: "release", limit: 5 })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("exercises publication through authenticated HTTP into persisted retrieval and erasure", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, actors.owner); await next(); });
    app.route("/api/company-brain", createCompanyBrainRoutes({ service }));
    const base = `/api/company-brain/scopes/${ids.scope}`;
    const published = await app.request(`${base}/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(document) });
    expect(published.status).toBe(201);
    expect((await (await app.request(`${base}/search?q=release`)).json()).sources).toHaveLength(1);
    const fetched = await (await app.request(`${base}/sources/${sourceId}`)).json();
    expect(fetched.text).toBe(document.text);
    expect((await app.request(`${base}/export`)).status).toBe(200);
    await expect(service.export(ids.scope, actors.editor)).rejects.toMatchObject({ code: "forbidden" });
    expect((await app.request(base, { method: "DELETE" })).status).toBe(200);
    expect(await db.selectFrom("company_brain_documents").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("company_brain_scopes").selectAll().execute()).toEqual([]);
    expect(await service.search(ids.scope, actors.owner, { query: "release" })).toEqual([]);
    await expect(service.get(ids.scope, actors.owner, sourceId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps independent scopes isolated even under the same owner", async () => {
    const otherScope = "10000000-0000-4000-8000-000000000009";
    const repository = new CollaborationRepository(fixture.db, { now: () => at });
    await repository.createDirectScope({ scopeId: otherScope, organizationId: "org_other", ownerId: actors.owner, kind: "chat", resourceId: "other_chat", authorityRuntimeId: ids.runtime });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", otherScope).execute();
    await service.publish(ids.scope, actors.owner, document);
    await service.publish(otherScope, actors.owner, { ...document, audienceScopeId: otherScope, text: "The release decision belongs to another company" });
    const found = await service.search(ids.scope, actors.editor, { query: "release" });
    expect(found).toHaveLength(1);
    expect(found[0].excerpt).toBe(document.text);
    await expect(service.search(otherScope, actors.editor, { query: "release" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("atomically enforces the storage ceiling and includes tombstones in document capacity", async () => {
    const bounded = new CompanyBrainService({ db, authority, ownerId: actors.owner, maxDocumentsPerScope: 1 });
    await bounded.publish(ids.scope, actors.owner, document);
    await bounded.remove(ids.scope, actors.owner, sourceId, 1);
    await expect(bounded.publish(ids.scope, actors.owner, { ...document, sourceId: "c".repeat(64) })).rejects.toMatchObject({ code: "capacity" });
    await bounded.erase(ids.scope, actors.owner);
    await expect(bounded.publish(ids.scope, actors.owner, document)).resolves.toMatchObject({ revision: 1 });
    await db.updateTable("company_brain_documents").set({ byte_count: 65536 }).execute();
    await sql`INSERT INTO company_brain_documents (scope_id,source_id,title,text,permalink,source_updated_at,published_at,updated_at,revision,byte_count,provenance,deleted_at)
      SELECT scope_id, md5(i::text) || md5(i::text), title, text, permalink,
      source_updated_at, published_at, updated_at, revision, 65536, provenance, deleted_at
      FROM company_brain_documents CROSS JOIN generate_series(1, 127) i`.execute(db);
    await expect(service.publish(ids.scope, actors.owner, { ...document, sourceId: "d".repeat(64) })).rejects.toMatchObject({ code: "capacity" });
  });

  it("returns no material if authority is revoked while a search is executing", async () => {
    await service.publish(ids.scope, actors.owner, document);
    let calls = 0;
    const changingAuthority = { organizationPrecondition:authority.organizationPrecondition,authorize: async (input: Parameters<CollaborationAuthority["authorize"]>[0]) => {
      calls += 1;
      if (calls === 2) await fixture.db.updateTable("collaboration_members").set({ status: "revoked" }).where("actor_id", "=", actors.editor).execute();
      return authority.authorize(input);
    } };
    const guarded = new CompanyBrainService({ db, authority: changingAuthority, ownerId: actors.owner });
    await expect(guarded.search(ids.scope, actors.editor, { query: "release" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("authorizes project Brain retrieval only through its exact inherited runnable Chat audience", async () => {
    const projectScope = "10000000-0000-4000-8000-000000000010";
    const childScope = "10000000-0000-4000-8000-000000000011";
    const repository = new CollaborationRepository(fixture.db, { now: () => at });
    await repository.createDirectScope({ scopeId: projectScope, organizationId: "org_team", ownerId: actors.owner, kind: "project", resourceId: "project_brain", authorityRuntimeId: ids.runtime });
    await repository.createDirectScope({ scopeId: childScope, organizationId: "org_team", ownerId: actors.owner, kind: "chat", resourceId: "project_brain_chat", authorityRuntimeId: ids.runtime });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", projectScope).execute();
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", membership_mode: "inherited", parent_scope_id: projectScope,
      execution_generation: 1, execution_eligibility: {} }).where("id", "=", childScope).execute();
    await service.publish(projectScope, actors.owner, { ...document, audienceScopeId: projectScope });
    expect((await service.retrieveForRun(projectScope, childScope, actors.owner, { query: "release" })).sources).toHaveLength(1);
    await expect(service.retrieveForRun(projectScope, ids.scope, actors.owner, { query: "release" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.retrieveForRun(ids.scope, childScope, actors.owner, { query: "release" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects invalid configuration and changed authorization evidence before output", async () => {
    expect(() => new CompanyBrainService({ db, authority, ownerId: "" })).toThrow("Invalid Company Brain configuration");
    expect(() => new CompanyBrainService({ db, authority, ownerId: actors.owner, maxDocumentsPerScope: 0 })).toThrow();
    await service.publish(ids.scope, actors.owner, document);
    let calls = 0;
    const changed = new CompanyBrainService({ db, ownerId: actors.owner, authority: { organizationPrecondition:authority.organizationPrecondition,authorize: async (input) => {
      const context = await authority.authorize(input);
      return ++calls === 2 ? { ...context, authEpoch: context.authEpoch + 1 } : context;
    } } });
    await expect(changed.search(ids.scope, actors.owner, { query: "release" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("captures approved Slack mentions under the owner ceiling without exposing an editor publication endpoint", async () => {
    const projectScope="10000000-0000-4000-8000-000000000020";
    const childScope="10000000-0000-4000-8000-000000000021";
    const repository=new CollaborationRepository(fixture.db,{now:()=>at});
    await repository.createDirectScope({scopeId:projectScope,organizationId:"org_team",ownerId:actors.owner,kind:"project",resourceId:"company_capture",authorityRuntimeId:ids.runtime});
    await repository.createDirectScope({scopeId:childScope,organizationId:"org_team",ownerId:actors.owner,kind:"chat",resourceId:"company_capture_chat",authorityRuntimeId:ids.runtime});
    await fixture.db.updateTable("collaboration_scopes").set({lifecycle:"shared"}).where("id","=",projectScope).execute();
    await fixture.db.updateTable("collaboration_scopes").set({lifecycle:"shared",membership_mode:"inherited",parent_scope_id:projectScope,execution_generation:1,execution_eligibility:{}}).where("id","=",childScope).execute();
    await fixture.db.insertInto("collaboration_members").values({scope_id:projectScope,actor_id:actors.editor,organization_id:"org_team",role:"editor",status:"accepted",invitation_id:null,invited_by:actors.owner,accepted_at:at,expires_at:null,joined_at:at,updated_at:at,dispositioned_at:null}).execute();
    const input={approval:{ownerId:actors.owner,organizationId:"org_team",scopeId:projectScope},appId:"A123",teamId:"T123",channelId:"C123",eventId:"Ev123",ts:"1790766000.000001",text:"Approved Slack launch decision"};
    const first=await service.captureSlackMention(projectScope,childScope,actors.editor,input);
    expect(first).toMatchObject({provenance:"slack_thread",revision:1,audienceScopeId:projectScope,permalink:expect.stringContaining("T123/C123/thread/C123-1790766000.000001")});
    expect(await service.captureSlackMention(projectScope,childScope,actors.editor,input)).toEqual(first);
    const retrieved=await service.retrieveForRun(projectScope,childScope,actors.editor,{query:"launch"});
    const proofs=[first,...retrieved.sources].map(({sourceId,incarnation,revision})=>({sourceId,incarnation,revision}));
    expect(await service.verifyEvidence(projectScope,actors.editor,proofs)).toBe(true);
    for(const revokedActor of [actors.owner,actors.editor]){
      let revoked=false;
      const organizationPrecondition=createOrganizationPrecondition({now:()=>at,source:{assertMembership:async(request)=>revoked && request.actorId===revokedActor
        ? {member:false} : {member:true,expiresAt:new Date(at.getTime()+60_000).toISOString(),membershipEpoch:"1",aiSubmission:"members"}}});
      const live=new CollaborationAuthority(repository,{now:()=>at,organizationPrecondition});
      const guarded=new CompanyBrainService({db,ownerId:actors.owner,authority:{organizationPrecondition,authorize:async(request)=>{
        const context=await live.authorize(request);if(request.scopeId===childScope) revoked=true;return context;
      }}});
      await expect(guarded.captureSlackMention(projectScope,childScope,actors.editor,{...input,eventId:"EvOrgRevoked"})).rejects.toMatchObject({code:"not_found"});
      expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toHaveLength(1);
    }
    await expect(service.captureSlackMention(projectScope,childScope,actors.editor,{...input,approval:{...input.approval,ownerId:actors.editor}})).rejects.toMatchObject({code:"forbidden"});
    await expect(service.captureSlackMention(projectScope,ids.scope,actors.editor,input)).rejects.toBeDefined();
    await expect(service.publish(projectScope,actors.editor,{...document,audienceScopeId:projectScope})).rejects.toMatchObject({code:"forbidden"});
    expect((await service.search(projectScope,actors.editor,{query:"launch"}))[0].provenance).toBe("slack_thread");
    await service.remove(projectScope,actors.owner,first.sourceId,1);
    await expect(service.captureSlackMention(projectScope,childScope,actors.editor,input)).rejects.toMatchObject({code:"conflict"});
    await service.erase(projectScope,actors.owner);
    await service.publish(projectScope,actors.owner,{...document,sourceId:first.sourceId,audienceScopeId:projectScope});
    await expect(service.captureSlackMention(projectScope,childScope,actors.editor,input)).rejects.toMatchObject({code:"conflict"});
    const disappearing=new CompanyBrainService({db,ownerId:actors.owner,authority:{organizationPrecondition:authority.organizationPrecondition,authorize:async(request)=>{
      const context=await authority.authorize(request);
      if(request.scopeId===childScope) await fixture.db.deleteFrom("collaboration_scopes").where("id","=",childScope).execute();
      return context;
    }}});
    await expect(disappearing.captureSlackMention(projectScope,childScope,actors.editor,{...input,eventId:"Ev124"})).rejects.toMatchObject({code:"forbidden"});
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toHaveLength(1);
  });

  it.each(["documents","bytes"] as const)("bounds export when an existing owner dataset exceeds the %s ceiling",async(ceiling)=>{
    const text=ceiling==="bytes" ? "x".repeat(65_520) : document.text;
    await service.publish(ids.scope,actors.owner,{...document,text});
    await sql`INSERT INTO company_brain_documents (scope_id,source_id,title,text,permalink,source_updated_at,published_at,updated_at,revision,byte_count,provenance,deleted_at)
      SELECT scope_id,md5(i::text)||md5(i::text),title,text,permalink,source_updated_at,published_at,updated_at,revision,byte_count,provenance,deleted_at
      FROM company_brain_documents CROSS JOIN generate_series(1,${ceiling==="bytes" ? 128 : 1000}) i`.execute(db);
    await expect(service.export(ids.scope,actors.owner)).rejects.toMatchObject({code:"capacity"});
  });

  it("bounds retrieval evidence across many long matching sources while preserving citations",async()=>{
    const text=("release "+"evidence".repeat(40)+" ").repeat(20);
    for(let index=0;index<10;index++) await service.publish(ids.scope,actors.owner,{...document,sourceId:index.toString(16).padStart(64,"0"),text});
    const context=await service.retrieve(ids.scope,actors.owner,{query:"release",limit:20});
    expect(context.sources).toHaveLength(8);
    expect(context.sources.reduce((total,source)=>total+source.excerpt.length,0)).toBe(16_000);
    expect(context.sources.every(source=>source.revision===1 && source.audienceScopeId===ids.scope && source.permalink===document.permalink)).toBe(true);
  });

  it("retrieves ranked evidence for natural questions without demanding every conversational word",async()=>{
    await service.publish(ids.scope,actors.owner,document);
    const found=await service.retrieve(ids.scope,actors.owner,{query:"Summarize the release decision for me"});
    expect(found.sources).toHaveLength(1);
    expect(found.sources[0].sourceId).toBe(sourceId);
  });

  it("does not acquire another pool connection for authority reads while a write transaction holds its connection",async()=>{
    let inside=false;
    const guardedDb=new Proxy(db,{get(target,property){
      if(property==="transaction") return ()=>({execute:async<T>(operation:(trx:unknown)=>Promise<T>)=>target.transaction().execute(async(trx)=>{inside=true;try{return await operation(trx);}finally{inside=false;}})});
      const value=Reflect.get(target,property,target);return typeof value==="function" ? value.bind(target) : value;
    }});
    const guardedAuthority={organizationPrecondition:authority.organizationPrecondition,authorize:async(input:Parameters<CollaborationAuthority["authorize"]>[0])=>{
      if(inside) throw new Error("Cannot acquire a second connection from a saturated pool");
      return authority.authorize(input);
    }};
    const boundedPoolService=new CompanyBrainService({db:guardedDb,authority:guardedAuthority,ownerId:actors.owner});
    await expect(boundedPoolService.publish(ids.scope,actors.owner,document)).resolves.toMatchObject({revision:1});
    await expect(boundedPoolService.remove(ids.scope,actors.owner,sourceId,1)).resolves.toBeUndefined();
    await expect(boundedPoolService.erase(ids.scope,actors.owner)).resolves.toBeUndefined();
  });

  it("bounds stored bytes, search limits, and source count without accepting arbitrary provenance", async () => {
    await expect(service.publish(ids.scope, actors.owner, { ...document, text: "x".repeat(65_537) })).rejects.toMatchObject({ name: "ZodError" });
    await expect(service.publish(ids.scope, actors.owner, { ...document, provenance: "provider_imported" } as never)).rejects.toMatchObject({ name: "ZodError" });
    await expect(service.search(ids.scope, actors.owner, { query: "release", limit: 21 })).rejects.toMatchObject({ name: "ZodError" });
    const bounded = new CompanyBrainService({ db, authority, ownerId: actors.owner, now: () => at, maxDocumentsPerScope: 1 });
    await bounded.publish(ids.scope, actors.owner, document);
    await expect(bounded.publish(ids.scope, actors.owner, { ...document, sourceId: "b".repeat(64) })).rejects.toMatchObject({ code: "capacity" });
    await expect(bounded.publish(ids.scope, actors.owner, { ...document, permalink: "https://user:password@example.com/notes", expectedRevision: 1 })).rejects.toMatchObject({ name: "ZodError" });
  });

  it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("serializes concurrent quota admission and revisions across more writers than pool connections",async()=>{
    const bounded=new CompanyBrainService({db,authority,ownerId:actors.owner,now:()=>at,maxDocumentsPerScope:2});
    const admissions=await Promise.allSettled(Array.from({length:16},(_,index)=>bounded.publish(ids.scope,actors.owner,{
      ...document,sourceId:index.toString(16).padStart(64,"0"),text:`Launch decision ${index}`,
    })));
    expect(admissions.filter(result=>result.status==="fulfilled")).toHaveLength(2);
    for(const result of admissions) if(result.status==="rejected") expect(result.reason).toMatchObject({code:"capacity"});
    const sources=await db.selectFrom("company_brain_documents").select(["source_id","revision"]).execute();
    expect(sources).toHaveLength(2);
    const updates=await Promise.allSettled(Array.from({length:16},(_,index)=>bounded.publish(ids.scope,actors.owner,{
      ...document,sourceId:sources[0].source_id,expectedRevision:1,text:`Correction ${index}`,
    })));
    expect(updates.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    for(const result of updates) if(result.status==="rejected") expect(result.reason).toMatchObject({code:"conflict"});
    expect((await service.get(ids.scope,actors.owner,sources[0].source_id)).revision).toBe(2);
  });

  it("rolls back publication when owner scope authority changes after preflight",async()=>{
    let changed=false;
    const changing=new CompanyBrainService({db,ownerId:actors.owner,authority:{organizationPrecondition:authority.organizationPrecondition,authorize:async(input)=>{
      const context=await authority.authorize(input);
      if(!changed){changed=true;await fixture.db.updateTable("collaboration_scopes").set({auth_epoch:context.authEpoch+1}).where("id","=",ids.scope).execute();}
      return context;
    }}});
    await expect(changing.publish(ids.scope,actors.owner,document)).rejects.toMatchObject({code:"forbidden"});
    expect(await db.selectFrom("company_brain_scopes").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("company_brain_documents").selectAll().execute()).toEqual([]);
  });

  it("retains a source incarnation through corrections but replaces it after scope erasure",async()=>{
    const first=await service.publish(ids.scope,actors.owner,document);
    const corrected=await service.publish(ids.scope,actors.owner,{...document,expectedRevision:1,text:"Correction"});
    expect(corrected.incarnation).toBe(first.incarnation);
    await service.erase(ids.scope,actors.owner);
    const recreated=await service.publish(ids.scope,actors.owner,{...document,text:"Replacement"});
    expect(recreated.revision).toBe(1);
    expect(recreated.incarnation).toMatch(/^[a-f0-9-]{36}$/);
    expect(recreated.incarnation).not.toBe(first.incarnation);
  });

  it.each(["get","search","export"] as const)("refuses evidence erased and recreated during the authority recheck of %s",async(operation)=>{
    await service.publish(ids.scope,actors.owner,document);
    let calls=0;
    const racing=new CompanyBrainService({db,ownerId:actors.owner,authority:{organizationPrecondition:authority.organizationPrecondition,authorize:async(input)=>{
      const context=await authority.authorize(input);
      if(++calls===2){
        await service.erase(ids.scope,actors.owner);
        await service.publish(ids.scope,actors.owner,{...document,text:"Replacement release decision"});
      }
      return context;
    }}});
    const request=operation==="get" ? racing.get(ids.scope,actors.owner,sourceId)
      : operation==="export" ? racing.export(ids.scope,actors.owner) : racing.search(ids.scope,actors.owner,{query:"release"});
    await expect(request).rejects.toMatchObject({code:"forbidden"});
  });

  it("backfills durable distinct incarnations for existing sources without rewriting their revisions",async()=>{
    await service.publish(ids.scope,actors.owner,document);
    await service.publish(ids.scope,actors.owner,{...document,sourceId:"b".repeat(64)});
    await sql`ALTER TABLE company_brain_documents DROP COLUMN incarnation`.execute(db);
    await bootstrapCompanyBrainDatabase(db);
    const migrated=await db.selectFrom("company_brain_documents").select(["source_id","incarnation","revision"]).orderBy("source_id").execute();
    expect(migrated.map(source=>source.revision)).toEqual([1,1]);
    expect(migrated.every(source=>/^[a-f0-9-]{36}$/.test(source.incarnation))).toBe(true);
    expect(migrated[0].incarnation).not.toBe(migrated[1].incarnation);
    await bootstrapCompanyBrainDatabase(db);
    expect(await db.selectFrom("company_brain_documents").select(["source_id","incarnation","revision"]).orderBy("source_id").execute()).toEqual(migrated);
  });

  it("verifies all evidence identities in one fresh batch after authority and receipt callbacks",async()=>{
    const first=await service.publish(ids.scope,actors.owner,document);
    const second=await service.publish(ids.scope,actors.owner,{...document,sourceId:"b".repeat(64)});
    const proofs=[first,second].map(source=>({sourceId:source.sourceId,incarnation:source.incarnation,revision:source.revision}));
    expect(await service.verifyEvidence(ids.scope,actors.owner,proofs)).toBe(true);
    let calls=0;
    const racing=new CompanyBrainService({db,ownerId:actors.owner,authority:{organizationPrecondition:authority.organizationPrecondition,authorize:async(input)=>{
      const context=await authority.authorize(input);
      if(++calls===2) await service.remove(ids.scope,actors.owner,first.sourceId,1);
      return context;
    }}});
    await expect(racing.verifyEvidence(ids.scope,actors.owner,proofs)).rejects.toMatchObject({code:"forbidden"});
    await expect(service.verifyEvidence(ids.scope,actors.owner,[proofs[1]],async()=>{
      await service.remove(ids.scope,actors.owner,second.sourceId,1);
    })).rejects.toMatchObject({code:"forbidden"});
  });

  it.each(["revocation","epoch"] as const)("rechecks evidence authority after an awaited receipt callback changes %s",async(change)=>{
    const source=await service.publish(ids.scope,actors.owner,document);
    const proofs=[{sourceId:source.sourceId,incarnation:source.incarnation,revision:source.revision}];
    await expect(service.verifyEvidence(ids.scope,actors.editor,proofs,async()=>{
      await Promise.resolve();
      if(change==="revocation") await fixture.db.updateTable("collaboration_members").set({status:"revoked"}).where("scope_id","=",ids.scope).where("actor_id","=",actors.editor).execute();
      else await fixture.db.updateTable("collaboration_scopes").set(eb=>({auth_epoch:eb("auth_epoch","+",1)})).where("id","=",ids.scope).execute();
    })).rejects.toMatchObject({code:change==="revocation"?"not_found":"forbidden"});
  });

  it("fences the owner member organization inside publication transactions",async()=>{
    const changed=new CompanyBrainService({db,ownerId:actors.owner,authority:{organizationPrecondition:authority.organizationPrecondition,authorize:async(input)=>{
      const context=await authority.authorize(input);
      await fixture.db.updateTable("collaboration_members").set({organization_id:"org_other"}).where("scope_id","=",ids.scope).where("actor_id","=",actors.owner).execute();
      return context;
    }}});
    await expect(changed.publish(ids.scope,actors.owner,document)).rejects.toMatchObject({code:"forbidden"});
    expect(await db.selectFrom("company_brain_documents").selectAll().execute()).toEqual([]);
  });
});
