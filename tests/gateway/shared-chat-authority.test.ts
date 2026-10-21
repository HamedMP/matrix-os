import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import type { AuthorizedCollaborationContext } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { fenceSharedChatAuthority } from "../../packages/gateway/src/collaboration/shared-chat-authority.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const acceptedAt = "2026-09-07T12:00:00.000Z";
const expiresAt = "2026-09-07T12:05:00.000Z";

describe("shared Chat authority fence", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: collaborationIds.scope,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      kind: "chat",
      organization_id: "org_matrix_team",
      resource_id: collaborationIds.chat,
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      revision: 1,
      auth_epoch: 1,
      authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      deleted_at: null,
      created_at: acceptedAt,
      updated_at: acceptedAt,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: collaborationIds.scope,
      actor_id: collaborationActors.editor,
      role: "editor",
      status: "accepted",
      invitation_id: null,
      invited_by: collaborationActors.owner,
      accepted_at: acceptedAt,
      expires_at: expiresAt,
      revision: 1,
      joined_at: acceptedAt,
      updated_at: acceptedAt,
    }).execute();
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("reads the current clock inside the locked fence before accepting an expiring member", async () => {
    const scope = await fixture.db.selectFrom("collaboration_scopes").selectAll()
      .where("id", "=", collaborationIds.scope).executeTakeFirstOrThrow();
    const context: AuthorizedCollaborationContext = {
      actorId: collaborationActors.editor,
      ownerId: collaborationActors.owner,
      organizationId: "org_matrix_team",
      scopeId: collaborationIds.scope,
      membershipScopeId: collaborationIds.scope,
      resourceKind: "chat",
      resourceId: collaborationIds.chat,
      role: "editor",
      authEpoch: 1,
      resourceAuthEpoch: 1,
      membershipAuthEpoch: 1,
      authorityRuntimeId: collaborationIds.runtime,
      authorityGeneration: 1,
      capability: "discuss",
    };
    let clockReads = 0;

    await expect(fixture.db.transaction().execute((trx) => fenceSharedChatAuthority(
      trx,
      scope,
      context,
      collaborationActors.editor,
      "discuss",
      () => {
        clockReads += 1;
        return new Date("2026-09-07T12:06:00.000Z");
      },
    ))).rejects.toMatchObject({ code: "forbidden" });
    expect(clockReads).toBe(1);
  });
});
