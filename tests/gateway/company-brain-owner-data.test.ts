import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely, KyselyPlugin } from "kysely";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationChatScopeService } from "../../packages/gateway/src/collaboration/chat-scope.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createProjectChatAssignmentCoordinator } from "../../packages/gateway/src/collaboration/project-chat-assignment.js";
import { createCollaborationProjectLifecycle } from "../../packages/gateway/src/collaboration/project-lifecycle.js";
import { bootstrapCompanyBrainDatabase, type CompanyBrainDatabase } from "../../packages/gateway/src/company-brain/database.js";
import { CompanyBrainService } from "../../packages/gateway/src/company-brain/service.js";
import { collaborationActors as actors, collaborationIds as ids, createCollaborationTestDatabase,
  createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const at = new Date("2026-09-30T10:00:00Z");
const document = { sourceId: "a".repeat(64), audienceScopeId: ids.scope, title: "Public fixture", text: "Approved source contents",
  permalink: "https://example.com/public-fixture", sourceUpdatedAt: at.toISOString(), expectedRevision: 0 };
let fixture: CollaborationTestDatabase;
let db: Kysely<CompanyBrainDatabase>;
let repository: CollaborationRepository;
let authority: CollaborationAuthority;
let service: CompanyBrainService;
let organizationMember: boolean;

beforeEach(async () => {
  fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealCollaborationTestDatabase() : createCollaborationTestDatabase());
  await bootstrapChatDatabase(fixture.db); await bootstrapCollaborationDatabase(fixture.db);
  db = fixture.db as unknown as Kysely<CompanyBrainDatabase>; await bootstrapCompanyBrainDatabase(db);
  const chats = new ChatRepository(fixture.db);
  await chats.create({ type: "personal", ownerId: actors.owner }, { id: ids.chat, clientRequestId: "req_brain_owner_data", title: "Public fixture" });
  const sharing = new CollaborationChatScopeService(fixture.db, { runtimeId: ids.runtime,
    preflightSecret: "0123456789abcdef0123456789abcdef", createScopeId: () => ids.scope, now: () => at });
  const preflight = await sharing.preflight({ ownerId: actors.owner, organizationId: "org_team", chatId: ids.chat });
  await sharing.shareChat({ ownerId: actors.owner, organizationId: "org_team", chatId: ids.chat,
    clientRequestId: "50000000-0000-4000-8000-000000000010", payloadHash: "a".repeat(64), expectedChatRevision: 0,
    confirmationToken: preflight.confirmationToken! });
  repository = new CollaborationRepository(fixture.db, { now: () => at, chatRepository: chats });
  organizationMember = true;
  const organizationPrecondition = createOrganizationPrecondition({ now: () => at,
    source: { assertMembership: async () => organizationMember
      ? { member: true, expiresAt: new Date(at.getTime() + 60_000).toISOString(), membershipEpoch: "1", aiSubmission: "members" }
      : { member: false } } });
  authority = new CollaborationAuthority(repository, { now: () => at, organizationPrecondition });
  service = new CompanyBrainService({ db, authority, ownerId: actors.owner, now: () => at });
  await service.publish(ids.scope, actors.owner, document);
});
afterEach(async () => { await fixture.destroy(); });

async function lifecycle(type: "delete" | "archive" = "delete") {
  await repository.applyChatLifecycle({ scopeId: ids.scope, actorId: actors.owner, type,
    clientRequestId: "50000000-0000-4000-8000-000000000011", payloadHash: "b".repeat(64), expectedRevision: 1 });
}
async function exportAudits() {
  const rows = await db.selectFrom("collaboration_audit").select(["scope_id", "actor_id", "action", "outcome", "revision"])
    .where("action", "=", "brain.exported").execute();
  return rows.map(row => ({ ...row, revision: Number(row.revision) }));
}

async function inheritedTombstone(deleteParent = false) {
  const parent = "10000000-0000-4000-8000-000000000030";
  const owner = { type: "personal" as const, ownerId: actors.owner };
  const chats = new ChatRepository(fixture.db);
  await repository.createDirectScope({ scopeId: parent, organizationId: "org_team", ownerId: actors.owner,
    kind: "project", resourceId: "project_brain_cleanup", authorityRuntimeId: ids.runtime });
  await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", parent).execute();
  const assignments = createProjectChatAssignmentCoordinator({ db: fixture.db, chatRepository: chats, now: () => at });
  const chat = await chats.get(owner, ids.chat);
  const assigned = await assignments.run(owner, repository => repository.update(owner, ids.chat,
    { baseRevision: chat!.chat.revision, projectId: "project_brain_cleanup" }));
  expect(await authority.authorize({ scopeId: ids.scope, actorId: actors.owner, action: "read" }))
    .toMatchObject({ membershipScopeId: parent, scopeId: ids.scope });
  if (deleteParent) {
    const projectLifecycle = createCollaborationProjectLifecycle({ db: fixture.db, now: () => at,
      stageTransfer: async () => { throw new Error("Unexpected fixture transfer"); },
      deleteProject: async () => { await chats.hardDelete(owner, { chatId: ids.chat, clientRequestId: "req_inherited_cleanup" }); } });
    const project = await fixture.db.selectFrom("collaboration_scopes").select("revision").where("id", "=", parent).executeTakeFirstOrThrow();
    await expect(projectLifecycle.apply({ scopeId: parent, actorId: actors.owner, type: "delete", expectedRevision: Number(project.revision),
      clientRequestId: "50000000-0000-4000-8000-000000000031", payloadHash: "d".repeat(64) }))
      .resolves.toMatchObject({ status: "completed" });
  } else {
    await assignments.run(owner, repository => repository.update(owner, ids.chat, { baseRevision: assigned.chat.revision, projectId: null }));
    await chats.hardDelete(owner, { chatId: ids.chat, clientRequestId: "req_inherited_cleanup" });
  }
  expect(await fixture.db.selectFrom("chats").select("id").where("id", "=", ids.chat).execute()).toEqual([]);
  expect(await fixture.db.selectFrom("collaboration_scopes").select(["lifecycle", "membership_mode", "parent_scope_id", "deleted_at"])
    .where("id", "=", ids.scope).executeTakeFirstOrThrow())
    .toMatchObject({ lifecycle: "deleted", membership_mode: "inherited", parent_scope_id: parent, deleted_at: expect.anything() });
  return parent;
}

async function archivedOwnerDataScope(kind: "chat" | "project" | "inherited_chat") {
  if (kind === "chat") { await lifecycle("archive"); return ids.scope; }
  const parent = "10000000-0000-4000-8000-000000000045";
  await repository.createDirectScope({ scopeId: parent, organizationId: "org_team", ownerId: actors.owner,
    kind: "project", resourceId: "project_archived_brain", authorityRuntimeId: ids.runtime });
  await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", parent).execute();
  if (kind === "project") await service.publish(parent, actors.owner, { ...document, audienceScopeId: parent });
  else {
    const owner = { type: "personal" as const, ownerId: actors.owner };
    const chats = new ChatRepository(fixture.db);
    const assignments = createProjectChatAssignmentCoordinator({ db: fixture.db, chatRepository: chats, now: () => at });
    const chat = await chats.get(owner, ids.chat);
    await assignments.run(owner, repository => repository.update(owner, ids.chat,
      { baseRevision: chat!.chat.revision, projectId: "project_archived_brain" }));
  }
  const projectLifecycle = createCollaborationProjectLifecycle({ db: fixture.db, now: () => at,
    stageTransfer: async () => { throw new Error("Unexpected archived fixture transfer"); },
    deleteProject: async () => { throw new Error("Unexpected archived fixture deletion"); } });
  const project = await fixture.db.selectFrom("collaboration_scopes").select("revision").where("id", "=", parent).executeTakeFirstOrThrow();
  await expect(projectLifecycle.apply({ scopeId: parent, actorId: actors.owner, type: "archive", expectedRevision: Number(project.revision),
    clientRequestId: "50000000-0000-4000-8000-000000000045", payloadHash: "e".repeat(64) }))
    .resolves.toMatchObject({ status: "completed" });
  return kind === "project" ? parent : ids.scope;
}

describe("owner-controlled Brain data and durable export audit", () => {
  it.each(["chat", "project", "inherited_chat"] as const)("erases archived %s owner data without restoring publication", async kind => {
    const scopeId = await archivedOwnerDataScope(kind);
    const scope = await fixture.db.selectFrom("collaboration_scopes").selectAll().where("id", "=", scopeId).executeTakeFirstOrThrow();
    expect(scope).toMatchObject({ lifecycle: "archived", deleted_at: null });
    const context = await authority.authorize({ scopeId, actorId: actors.owner, action: "read" });
    const owner = await fixture.db.selectFrom("collaboration_members").selectAll()
      .where("scope_id", "=", context.membershipScopeId).where("actor_id", "=", actors.owner).executeTakeFirstOrThrow();
    await fixture.db.insertInto("collaboration_members").values({ ...owner, actor_id: actors.editor, role: "editor" }).execute();
    await expect(authority.authorize({ scopeId, actorId: actors.editor, action: "read" })).resolves.toMatchObject({ role: "editor" });
    await expect(service.erase(scopeId, actors.editor)).rejects.toBeDefined();
    organizationMember = false;
    await expect(service.erase(scopeId, actors.owner)).rejects.toBeDefined();
    organizationMember = true;
    await expect(service.publish(scopeId, actors.owner, { ...document, audienceScopeId: scopeId, expectedRevision: 1 })).rejects.toBeDefined();
    expect(await db.selectFrom("company_brain_documents").select("source_id").where("scope_id", "=", scopeId).execute()).toHaveLength(1);
    await expect(service.erase(scopeId, actors.owner)).resolves.toBeUndefined();
    expect(await db.selectFrom("company_brain_documents").select("source_id").where("scope_id", "=", scopeId).execute()).toEqual([]);
    expect(await db.selectFrom("company_brain_scopes").select("scope_id").where("scope_id", "=", scopeId).execute()).toEqual([]);
    expect(await fixture.db.selectFrom("collaboration_scopes").selectAll().where("id", "=", scopeId).executeTakeFirstOrThrow()).toEqual(scope);
    await expect(service.publish(scopeId, actors.owner, { ...document, audienceScopeId: scopeId })).rejects.toBeDefined();
  });
  it.each([false, true])("exports and erases the inherited Chat tombstone with deleted parent=%s", async deleteParent => {
    const parent = await inheritedTombstone(deleteParent);
    expect((await service.export(ids.scope, actors.owner)).documents).toEqual([expect.objectContaining({ text: document.text })]);
    expect(await exportAudits()).toEqual([expect.objectContaining({ scope_id: ids.scope, actor_id: actors.owner, action: "brain.exported" })]);
    await service.erase(ids.scope, actors.owner);
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toEqual([]);
    expect(await db.selectFrom("company_brain_scopes").select("scope_id").execute()).toEqual([]);
    expect(await fixture.db.selectFrom("collaboration_scopes").select("lifecycle").where("id", "=", parent).executeTakeFirstOrThrow())
      .toEqual({ lifecycle: deleteParent ? "deleted" : "shared" });
  });
  it.each(["owner", "organization", "runtime", "state", "epoch"] as const)("denies inherited tombstone cleanup after parent %s changes", async change => {
    const parent = await inheritedTombstone();
    if (change === "owner") await fixture.db.updateTable("collaboration_scopes").set({ owner_id: actors.editor }).where("id", "=", parent).execute();
    if (change === "organization") await fixture.db.updateTable("collaboration_scopes").set({ organization_id: "org_other" }).where("id", "=", parent).execute();
    if (change === "runtime") await fixture.db.updateTable("collaboration_scopes").set({ authority_generation: 2 }).where("id", "=", parent).execute();
    if (change === "state") await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "deleted", deleted_at: null }).where("id", "=", parent).execute();
    const original = authority.organizationPrecondition;
    const guarded = new CompanyBrainService({ db, ownerId: actors.owner, now: () => at, authority: {
      authorize: input => authority.authorize(input), organizationPrecondition: { ...original, require: async input => {
        const evidence = await original.require(input);
        if (change === "epoch") await fixture.db.updateTable("collaboration_scopes").set(expression => ({ auth_epoch: expression("auth_epoch", "+", 1) }))
          .where("id", "=", parent).execute();
        return evidence;
      } },
    } });
    await expect(guarded.export(ids.scope, actors.owner)).rejects.toBeDefined();
    await expect(guarded.erase(ids.scope, actors.owner)).rejects.toBeDefined();
    expect(await exportAudits()).toEqual([]);
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toHaveLength(1);
  });
  it("exports retained sources after actual canonical Chat deletion without reopening normal reads", async () => {
    await lifecycle();
    expect(await fixture.db.selectFrom("chats").select("id").where("id", "=", ids.chat).execute()).toEqual([]);
    expect((await service.export(ids.scope, actors.owner)).documents).toEqual([expect.objectContaining({ text: document.text })]);
    await expect(service.get(ids.scope, actors.owner, document.sourceId)).rejects.toMatchObject({ code: "not_found" });
    expect(await exportAudits()).toEqual([{ scope_id: ids.scope, actor_id: actors.owner, action: "brain.exported", outcome: "completed", revision: 2 }]);
  });
  it("erases only retained Brain data after canonical Chat deletion", async () => {
    await lifecycle();
    await service.erase(ids.scope, actors.owner);
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toEqual([]);
    expect(await db.selectFrom("company_brain_scopes").select("scope_id").execute()).toEqual([]);
    expect(await fixture.db.selectFrom("collaboration_scopes").select(["lifecycle", "deleted_at"]).where("id", "=", ids.scope).executeTakeFirstOrThrow())
      .toMatchObject({ lifecycle: "deleted", deleted_at: expect.anything() });
    expect(await exportAudits()).toEqual([]);
  });
  it("audits each successful live export with the actual actor and scope", async () => {
    expect((await service.export(ids.scope, actors.owner)).documents[0].text).toBe(document.text);
    expect(await exportAudits()).toEqual([{ scope_id: ids.scope, actor_id: actors.owner, action: "brain.exported", outcome: "completed", revision: 1 }]);
  });
  it("includes sources published during authority recheck in the audited snapshot", async () => {
    let calls = 0;
    const guarded = new CompanyBrainService({ db, ownerId: actors.owner, now: () => at,
      authority: { organizationPrecondition: authority.organizationPrecondition, authorize: async input => {
        const context = await authority.authorize(input);
        if (++calls === 2) await service.publish(ids.scope, actors.owner, { ...document, sourceId: "b".repeat(64), text: "New approved source" });
        return context;
      } } });
    expect((await guarded.export(ids.scope, actors.owner)).documents.map(row => row.text)).toEqual([document.text, "New approved source"]);
    expect(await exportAudits()).toHaveLength(1);
  });
  it("preserves archived owner exports and audits them", async () => {
    await lifecycle("archive");
    expect((await service.export(ids.scope, actors.owner)).documents[0].text).toBe(document.text);
    expect(await exportAudits()).toHaveLength(1);
  });
  it.each(["export", "erase"] as const)("denies participant and foreign-owner %s of deleted data", async (operation) => {
    await lifecycle();
    for (const actor of [actors.editor, "user_other_owner"]) await expect(service[operation](ids.scope, actor)).rejects.toBeDefined();
    const foreign = new CompanyBrainService({ db, authority, ownerId: "user_other_owner", now: () => at });
    await expect(foreign[operation](ids.scope, "user_other_owner")).rejects.toBeDefined();
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toHaveLength(1);
    expect(await exportAudits()).toEqual([]);
  });
  it.each(["organization", "member", "binding"])("denies deleted owner-data access after %s revocation", async (change) => {
    await lifecycle();
    if (change === "organization") organizationMember = false;
    if (change === "member") await db.updateTable("collaboration_members").set({ dispositioned_at: at }).where("scope_id", "=", ids.scope).execute();
    if (change === "binding") await db.updateTable("company_brain_scopes").set({ resource_id: "different_chat" }).where("scope_id", "=", ids.scope).execute();
    await expect(service.export(ids.scope, actors.owner)).rejects.toBeDefined();
    await expect(service.erase(ids.scope, actors.owner)).rejects.toBeDefined();
    expect(await exportAudits()).toEqual([]);
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toHaveLength(1);
  });
  it.each((["export", "erase"] as const).flatMap(operation =>
    ["epoch", "runtime", "state", "binding", "owner_member", "organization"].map(change => ({ operation, change }))))
  ("fences $operation after $change changes following tombstone authorization", async ({ operation, change }) => {
    await lifecycle();
    const original = authority.organizationPrecondition; let calls = 0;
    const organizationPrecondition = { ...original, require: async (input: Parameters<typeof original.require>[0]) => {
      const evidence = await original.require(input);
      if (++calls === 1) {
        if (change === "epoch") await db.updateTable("collaboration_scopes").set({ auth_epoch: 777 }).where("id", "=", ids.scope).execute();
        if (change === "runtime") await db.updateTable("collaboration_scopes").set({ authority_generation: 2 }).where("id", "=", ids.scope).execute();
        if (change === "state") await db.updateTable("collaboration_scopes").set({ lifecycle: "shared", deleted_at: null }).where("id", "=", ids.scope).execute();
        if (change === "binding") await db.updateTable("company_brain_scopes").set({ resource_id: "different_chat" }).where("scope_id", "=", ids.scope).execute();
        if (change === "owner_member") await db.updateTable("collaboration_members").set({ dispositioned_at: at }).where("scope_id", "=", ids.scope).execute();
        if (change === "organization") organizationMember = false;
      }
      return evidence;
    } };
    const guarded = new CompanyBrainService({ db, ownerId: actors.owner, now: () => at,
      authority: { organizationPrecondition, authorize: input => authority.authorize(input) } });
    await expect(guarded[operation](ids.scope, actors.owner)).rejects.toBeDefined();
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toHaveLength(1);
    expect(await exportAudits()).toEqual([]);
  });
  it("preserves another owner's Brain data while erasing the selected tombstone", async () => {
    const otherScope = "10000000-0000-4000-8000-000000000044";
    const other = { ...(await db.selectFrom("company_brain_documents").selectAll().executeTakeFirstOrThrow()), scope_id: otherScope };
    await db.insertInto("company_brain_scopes").values({ scope_id: otherScope, owner_id: actors.editor, organization_id: "org_other",
      resource_kind: "project", resource_id: "project_other", created_at: at }).execute();
    await db.insertInto("company_brain_documents").values(other).execute();
    await lifecycle(); await service.erase(ids.scope, actors.owner);
    expect(await db.selectFrom("company_brain_documents").selectAll().execute()).toEqual([other]);
    expect(await db.selectFrom("company_brain_scopes").select("scope_id").execute()).toEqual([{ scope_id: otherScope }]);
  });
  it("returns no dataset when its durable export audit cannot be committed", async () => {
    const plugin: KyselyPlugin = { transformQuery(args) {
      const value = JSON.stringify(args.node);
      if (value.includes('"kind":"InsertQueryNode"') && value.includes('"name":"collaboration_audit"')) throw new Error("Synthetic audit outage");
      return args.node;
    }, async transformResult(args) { return args.result; } };
    const guarded = new CompanyBrainService({ db: db.withPlugin(plugin), authority, ownerId: actors.owner, now: () => at });
    await expect(guarded.export(ids.scope, actors.owner)).rejects.toThrow("Synthetic audit outage");
    expect(await exportAudits()).toEqual([]);
  });
  it("does not audit a rejected oversized export", async () => {
    const source = await db.selectFrom("company_brain_documents").selectAll().executeTakeFirstOrThrow();
    await db.insertInto("company_brain_documents").values(Array.from({ length: 129 }, (_, i) => ({ ...source,
      source_id: String(i + 1).padStart(64, "0"), byte_count: 65_536 }))).execute();
    await expect(service.export(ids.scope, actors.owner)).rejects.toMatchObject({ code: "capacity" });
    expect(await exportAudits()).toEqual([]);
  });
});
