import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  CollaborationAuthority,
  CollaborationAuthorizationError,
} from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = "2026-09-07T12:00:00.000Z";

describe("CollaborationAuthority", () => {
  let fixture: CollaborationTestDatabase;
  let authority: CollaborationAuthority;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    const repository = new CollaborationRepository(fixture.db, { now: () => new Date(now) });
    await repository.createDirectScope({
      scopeId: collaborationIds.scope,
      ownerId: collaborationActors.owner,
      kind: "chat",
      resourceId: collaborationIds.chat,
      authorityRuntimeId: collaborationIds.runtime,
    });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" })
      .where("id", "=", collaborationIds.scope).execute();
    await fixture.db.insertInto("collaboration_members").values([
      member(collaborationActors.editor, "editor", "accepted"),
      member(collaborationActors.viewer, "viewer", "accepted"),
      member("user_pending", "editor", "pending", "2026-09-14T12:00:00.000Z"),
      member("user_expired", "editor", "pending", "2026-09-07T11:59:59.000Z"),
      member("user_revoked", "editor", "revoked"),
    ]).execute();
    authority = new CollaborationAuthority(repository, { now: () => new Date(now) });
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("returns actor-preserving contexts for the exact permitted role matrix", async () => {
    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      action: "manage_members",
    })).resolves.toMatchObject({
      actorId: collaborationActors.owner,
      ownerId: collaborationActors.owner,
      role: "owner",
      scopeId: collaborationIds.scope,
      capability: "manage_members",
    });
    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    })).resolves.toMatchObject({ role: "editor", capability: "discuss" });
    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.viewer,
      action: "read",
    })).resolves.toMatchObject({ role: "viewer", capability: "read" });

    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.viewer,
      action: "discuss",
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "manage_members",
    })).rejects.toMatchObject({ code: "forbidden" });
  });

  it.each(["user_pending", "user_expired", "user_revoked", collaborationActors.outsider])(
    "rejects non-current actor %s without owner fallback",
    async (actorId) => {
      await expect(authority.authorize({
        scopeId: collaborationIds.scope,
        actorId,
        action: "read",
      })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    },
  );

  it("hard-disables AI execution for every M1 role including the owner", async () => {
    for (const actorId of [collaborationActors.owner, collaborationActors.editor]) {
      await expect(authority.authorize({
        scopeId: collaborationIds.scope,
        actorId,
        action: "request_ai",
      })).rejects.toMatchObject({ code: "unavailable" });
    }
  });

  it("enables M2 requests only for an eligible scope, enabled cohort, and writable role", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({
      execution_generation: 1,
      execution_eligibility: JSON.stringify({ profileId: "scope-runtime-chat-v1" }),
    }).where("id", "=", collaborationIds.scope).execute();
    const repository = new CollaborationRepository(fixture.db, { now: () => new Date(now) });
    const m2 = new CollaborationAuthority(repository, { now: () => new Date(now) });
    const executionPolicy = {
      milestone: "m2" as const,
      revision: "1",
      mode: "internal" as const,
      cohort: [collaborationActors.owner, collaborationActors.editor],
      issuedAt: "2026-09-07T11:59:50.000Z",
      expiresAt: "2026-09-07T12:00:20.000Z",
    };

    await expect(m2.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "request_ai",
      executionPolicy,
    })).resolves.toMatchObject({ capability: "request_ai", role: "editor" });
    await expect(m2.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.viewer,
      action: "request_ai",
      executionPolicy,
    })).rejects.toMatchObject({ code: "unavailable" });

    await expect(m2.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      action: "control_execution",
      executionPolicy: { ...executionPolicy, mode: "read_only" },
    })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("requires the resource-specific milestone for terminal control", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({
      kind: "terminal",
      resource_id: "terminal_shared",
      execution_generation: 2,
      execution_eligibility: JSON.stringify({ profileId: "scope-runtime-terminal-v1" }),
    }).where("id", "=", collaborationIds.scope).execute();
    const policy = {
      milestone: "m3" as const,
      revision: "1",
      mode: "internal" as const,
      cohort: [collaborationActors.owner, collaborationActors.editor],
      issuedAt: "2026-09-07T11:59:50.000Z",
      expiresAt: "2026-09-07T12:00:20.000Z",
    };

    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "control_execution",
      executionPolicy: { ...policy, milestone: "m2" },
    })).rejects.toMatchObject({ code: "unavailable" });
    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "control_execution",
      executionPolicy: policy,
    })).resolves.toMatchObject({
      resourceKind: "terminal",
      resourceId: "terminal_shared",
      capability: "control_execution",
    });
    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.viewer,
      action: "control_execution",
      executionPolicy: policy,
    })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("resolves inherited membership only through an active project parent", async () => {
    const projectId = "10000000-0000-4000-8000-000000000010";
    const childId = "10000000-0000-4000-8000-000000000011";
    await fixture.db.insertInto("collaboration_scopes").values({
      id: projectId,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      kind: "project",
      resource_id: "project_shared",
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      authority_runtime_id: collaborationIds.runtime,
      execution_generation: null,
      execution_eligibility: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values(member(
      collaborationActors.editor,
      "editor",
      "accepted",
      undefined,
      projectId,
    )).execute();
    await fixture.db.insertInto("collaboration_scopes").values({
      id: childId,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      kind: "chat",
      resource_id: "chat_inherited",
      parent_scope_id: projectId,
      membership_mode: "inherited",
      lifecycle: "shared",
      authority_runtime_id: collaborationIds.runtime,
      execution_generation: null,
      execution_eligibility: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }).execute();

    await expect(authority.authorize({
      scopeId: childId,
      actorId: collaborationActors.editor,
      action: "discuss",
    })).resolves.toMatchObject({ scopeId: childId, membershipScopeId: projectId });

    await fixture.db.updateTable("collaboration_scopes").set({ kind: "chat" })
      .where("id", "=", projectId).execute();
    await expect(authority.authorize({
      scopeId: childId,
      actorId: collaborationActors.editor,
      action: "read",
    })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("blocks shared mutations outside the shared lifecycle", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "archived" })
      .where("id", "=", collaborationIds.scope).execute();
    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      action: "discuss",
    })).rejects.toMatchObject({ code: "unavailable" });
    await expect(authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      action: "read",
    })).resolves.toMatchObject({ role: "owner" });
  });
});

function member(
  actorId: string,
  role: "owner" | "editor" | "viewer",
  status: "pending" | "accepted" | "revoked" | "expired",
  expiresAt?: string,
  scopeId = collaborationIds.scope,
) {
  const accepted = status === "accepted";
  return {
    scope_id: scopeId,
    actor_id: actorId,
    role,
    status,
    invitation_id: status === "pending" ? crypto.randomUUID() : null,
    invited_by: collaborationActors.owner,
    accepted_at: accepted ? now : null,
    expires_at: expiresAt ?? null,
    revision: 1,
    joined_at: accepted ? now : null,
    updated_at: now,
  } as const;
}
