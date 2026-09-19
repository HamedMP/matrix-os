import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationChatScopeService } from "../../packages/gateway/src/collaboration/chat-scope.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  collaborationActors,
  collaborationIds,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const now = "2026-09-17T12:00:00.000Z";
const affectedScopeId = "6aed8d12-f6c8-4c10-90b2-1e51fcc738e3";
const eligibility = {
  profileId: "scope-runtime-chat-v1",
  profileVersion: 1,
  profileDigest: "b".repeat(64),
  adapterId: "claude-code" as const,
  harnessVersion: "2.1.240",
};

realDescribe("CollaborationChatScopeService PostgreSQL capability lifecycle", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("chats").values({
      id: collaborationIds.chat,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      create_request_id: "req_capability_race",
      project_id: null,
      title: "Capability race",
      lifecycle: "active",
      attention: "none",
      collaboration: null,
      user_state: null,
      shell_state: null,
      fork_provenance: null,
      last_message_preview: null,
      current_selection: null,
      bound_driver_kind: null,
      bound_instance_id: null,
      bound_at_turn_id: null,
      created_at: now,
      updated_at: now,
    }).execute();
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("does not strand a scope when activation races capability reconciliation and startup repeats it", async () => {
    const service = createService(fixture);
    const preflight = await service.preflight({
      ownerId: collaborationActors.owner,
      chatId: collaborationIds.chat,
    });

    await Promise.all([
      service.shareChat({
        ownerId: collaborationActors.owner,
        chatId: collaborationIds.chat,
        clientRequestId: "50000000-0000-4000-8000-000000000010",
        payloadHash: "a".repeat(64),
        expectedChatRevision: 0,
        confirmationToken: preflight.confirmationToken!,
      }),
      service.reconcileExecutionEligibility({ executionGeneration: 9, eligibility }),
    ]);

    const scope = await fixture.db.selectFrom("collaboration_scopes")
      .select(["execution_generation", "execution_eligibility"])
      .where("id", "=", affectedScopeId).executeTakeFirstOrThrow();
    expect({ ...scope, execution_generation: Number(scope.execution_generation) })
      .toMatchObject({ execution_generation: 9, execution_eligibility: eligibility });

    const restarted = createService(fixture);
    await expect(restarted.reconcileExecutionEligibility({ executionGeneration: 9, eligibility }))
      .resolves.toEqual({ updated: 0 });
  });
});

function createService(fixture: CollaborationTestDatabase): CollaborationChatScopeService {
  return new CollaborationChatScopeService(fixture.db, {
    runtimeId: collaborationIds.runtime,
    preflightSecret: "0123456789abcdef0123456789abcdef",
    now: () => new Date(now),
    createScopeId: () => affectedScopeId,
  });
}
