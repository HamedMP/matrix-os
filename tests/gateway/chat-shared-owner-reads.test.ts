import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const CHAT_ID = "chat_11111111222243338444555555555555";
const SCOPE_ID = "11111111-2222-4333-8444-555555555555";
const OWNER_ID = "user_shared_chat_owner";
const createdAt = "2026-09-17T00:00:00.000Z";
const owner = { type: "personal" as const, ownerId: OWNER_ID };
const expectedCollaboration = {
  mode: "shared" as const,
  membership: { role: "owner" as const, memberCount: 2 },
};

describe("shared Chat owner list and detail reads", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    repository = new ChatRepository(fixture.db);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it.each(["discussion_only", "shared_ai"] as const)(
    "projects an internal %s binding through the owner's normal list and detail APIs",
    async (mode) => {
      await repository.create(owner, {
        id: CHAT_ID,
        clientRequestId: `req_create_${mode}`,
        title: "Shared production Chat",
      });
      await fixture.db.updateTable("chats").set({
        collaboration: {
          mode,
          scopeId: SCOPE_ID,
          executionFenced: true,
          authorityGeneration: 1,
        },
      }).where("id", "=", CHAT_ID).execute();
      await fixture.db.insertInto("collaboration_scopes").values({
        id: SCOPE_ID,
        owner_type: "personal",
        owner_id: OWNER_ID,
        kind: "chat",
        resource_id: CHAT_ID,
        parent_scope_id: null,
        membership_mode: "direct",
        lifecycle: "shared",
        authority_runtime_id: "runtime_shared_chat_owner",
        execution_generation: mode === "shared_ai" ? 1 : null,
        execution_eligibility: null,
        created_at: "2026-09-17T00:00:00.000Z",
        updated_at: "2026-09-17T00:00:00.000Z",
        deleted_at: null,
      }).execute();
      await fixture.db.insertInto("collaboration_members").values([
        {
          scope_id: SCOPE_ID,
          actor_id: OWNER_ID,
          role: "owner",
          status: "accepted",
          invitation_id: null,
          invited_by: OWNER_ID,
          accepted_at: "2026-09-17T00:00:00.000Z",
          expires_at: null,
          joined_at: "2026-09-17T00:00:00.000Z",
          updated_at: "2026-09-17T00:00:00.000Z",
        },
        {
          scope_id: SCOPE_ID,
          actor_id: "user_shared_chat_editor",
          role: "editor",
          status: "accepted",
          invitation_id: null,
          invited_by: OWNER_ID,
          accepted_at: "2026-09-17T00:00:00.000Z",
          expires_at: null,
          joined_at: "2026-09-17T00:00:00.000Z",
          updated_at: "2026-09-17T00:00:00.000Z",
        },
        {
          scope_id: SCOPE_ID,
          actor_id: "user_shared_chat_revoked",
          role: "viewer",
          status: "revoked",
          invitation_id: null,
          invited_by: OWNER_ID,
          accepted_at: null,
          expires_at: null,
          joined_at: null,
          updated_at: "2026-09-17T00:00:00.000Z",
        },
        {
          scope_id: SCOPE_ID,
          actor_id: "user_shared_chat_expired",
          role: "viewer",
          status: "accepted",
          invitation_id: null,
          invited_by: OWNER_ID,
          accepted_at: "2025-09-17T00:00:00.000Z",
          expires_at: "2025-09-18T00:00:00.000Z",
          joined_at: "2025-09-17T00:00:00.000Z",
          updated_at: "2025-09-18T00:00:00.000Z",
        },
      ]).execute();

      const repositoryList = await repository.list(owner, { limit: 25 });
      expect(repositoryList.items[0]?.chat.collaboration).toEqual(expectedCollaboration);
      const repositoryDetail = await repository.getDetailPage(owner, CHAT_ID, { limit: 100 });
      expect(repositoryDetail?.record.chat.collaboration).toEqual(expectedCollaboration);

      const service = createCanonicalChatService(repository);
      const serviceList = await service.list(owner, { limit: 25 });
      expect(serviceList.items[0]?.chat.collaboration).toEqual(expectedCollaboration);
      const serviceDetail = await service.getDetail(owner, CHAT_ID, { limit: 100 });
      expect(serviceDetail?.record.chat.collaboration).toEqual(expectedCollaboration);
      const app = new Hono().route("/", createCanonicalChatRoutes({
        service,
        getPrincipal: () => ({ userId: OWNER_ID, source: "jwt" }),
      }));

      const listResponse = await app.request("/api/chats");
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as { items: Array<{ chat: { collaboration?: unknown } }> };
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.chat.collaboration).toEqual(expectedCollaboration);

      const detailResponse = await app.request(`/api/chats/${CHAT_ID}`);
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json() as { record: { chat: { collaboration?: unknown } } };
      expect(detail.record.chat.collaboration).toEqual(expectedCollaboration);

      for (const projection of [list.items[0]?.chat.collaboration, detail.record.chat.collaboration]) {
        expect(projection).not.toHaveProperty("scopeId");
        expect(projection).not.toHaveProperty("executionFenced");
        expect(projection).not.toHaveProperty("authorityGeneration");
      }
    },
  );

  it("counts effective members from an inherited Project scope", async () => {
    const parentScopeId = "6aed8d12-f6c8-4c10-90b2-1e51fcc738e4";
    await repository.create(owner, {
      id: CHAT_ID,
      clientRequestId: "req_create_inherited",
      title: "Inherited shared Chat",
    });
    await fixture.db.updateTable("chats").set({
      collaboration: {
        mode: "discussion_only",
        scopeId: SCOPE_ID,
        executionFenced: true,
        authorityGeneration: 1,
      },
    }).where("id", "=", CHAT_ID).execute();
    await fixture.db.insertInto("collaboration_scopes").values([
      {
        id: parentScopeId,
        owner_type: "personal",
        owner_id: OWNER_ID,
        kind: "project",
        organization_id: "org_matrix_team",
        resource_id: "project_shared_owner_reads",
        parent_scope_id: null,
        membership_mode: "direct",
        lifecycle: "shared",
        authority_runtime_id: "runtime_shared_chat_owner",
        execution_generation: null,
        execution_eligibility: null,
        created_at: "2026-09-17T00:00:00.000Z",
        updated_at: "2026-09-17T00:00:00.000Z",
        deleted_at: null,
      },
      {
        id: SCOPE_ID,
        owner_type: "personal",
        owner_id: OWNER_ID,
        kind: "chat",
        resource_id: CHAT_ID,
        parent_scope_id: parentScopeId,
        membership_mode: "inherited",
        lifecycle: "shared",
        authority_runtime_id: "runtime_shared_chat_owner",
        execution_generation: null,
        execution_eligibility: null,
        created_at: "2026-09-17T00:00:00.000Z",
        updated_at: "2026-09-17T00:00:00.000Z",
        deleted_at: null,
      },
    ]).execute();
    await fixture.db.insertInto("collaboration_members").values([
      {
        scope_id: parentScopeId,
        actor_id: OWNER_ID,
        role: "owner",
        status: "accepted",
        invitation_id: null,
        invited_by: OWNER_ID,
        accepted_at: createdAt,
        expires_at: null,
        joined_at: createdAt,
        updated_at: createdAt,
      },
      {
        scope_id: parentScopeId,
        actor_id: "user_project_editor",
        role: "editor",
        status: "accepted",
        invitation_id: null,
        invited_by: OWNER_ID,
        accepted_at: createdAt,
        expires_at: null,
        joined_at: createdAt,
        updated_at: createdAt,
      },
      {
        scope_id: parentScopeId,
        actor_id: "user_project_expired",
        role: "viewer",
        status: "accepted",
        invitation_id: null,
        invited_by: OWNER_ID,
        accepted_at: "2025-09-17T00:00:00.000Z",
        expires_at: "2025-09-18T00:00:00.000Z",
        joined_at: "2025-09-17T00:00:00.000Z",
        updated_at: "2025-09-18T00:00:00.000Z",
      },
    ]).execute();

    expect((await repository.list(owner, { limit: 25 })).items[0]?.chat.collaboration)
      .toEqual(expectedCollaboration);
    expect((await repository.getDetailPage(owner, CHAT_ID, { limit: 100 }))?.record.chat.collaboration)
      .toEqual(expectedCollaboration);
  });

  it("fails closed when an internal binding points at another owner's scope", async () => {
    await repository.create(owner, {
      id: CHAT_ID,
      clientRequestId: "req_create_mismatched_owner",
      title: "Mismatched shared Chat",
    });
    await fixture.db.updateTable("chats").set({
      collaboration: {
        mode: "discussion_only",
        scopeId: SCOPE_ID,
        executionFenced: true,
        authorityGeneration: 1,
      },
    }).where("id", "=", CHAT_ID).execute();
    await fixture.db.insertInto("collaboration_scopes").values({
      id: SCOPE_ID,
      owner_type: "personal",
      owner_id: "user_other_scope_owner",
      kind: "chat",
      resource_id: CHAT_ID,
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      authority_runtime_id: "runtime_other_scope_owner",
      execution_generation: null,
      execution_eligibility: null,
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: SCOPE_ID,
      actor_id: "user_other_scope_owner",
      role: "owner",
      status: "accepted",
      invitation_id: null,
      invited_by: "user_other_scope_owner",
      accepted_at: createdAt,
      expires_at: null,
      joined_at: createdAt,
      updated_at: createdAt,
    }).execute();

    await expect(repository.list(owner, { limit: 25 })).rejects.toBeDefined();
    await expect(repository.getDetailPage(owner, CHAT_ID, { limit: 100 })).rejects.toBeDefined();
  });
});
