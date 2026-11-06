import { sql } from "kysely";
import { ownedProfileFixture } from "./owned-profile-fixture.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationChatScopeService } from "../../packages/gateway/src/collaboration/chat-scope.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  collaborationActors,
  collaborationExecutionEligibility,
  collaborationIds,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const now = "2026-09-17T12:00:00.000Z";
const affectedScopeId = "6aed8d12-f6c8-4c10-90b2-1e51fcc738e3";
const eligibility = collaborationExecutionEligibility();

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

  it.each(["legacy", "foreign", "malformed"])("reconciles %s historical eligibility and managed Pi changes once per revision under the lock", async stored => {
    const legacy = createService(fixture);
    await legacy.reconcileExecutionEligibility({ executionGeneration: 9, eligibility });
    const input = { ownerId: collaborationActors.owner, organizationId: "org_matrix_team", chatId: collaborationIds.chat };
    const preflight = await legacy.preflight(input);
    await legacy.shareChat({ ...input, clientRequestId: "50000000-0000-4000-8000-000000000011",
      payloadHash: "a".repeat(64), expectedChatRevision: 0, confirmationToken: preflight.confirmationToken! });
    const { policy } = ownedProfileFixture();
    if (stored !== "legacy") await fixture.db.updateTable("collaboration_scopes").set({
      execution_eligibility: sql`${JSON.stringify(stored === "foreign" ? ownedProfileFixture("profile-b").policy.sharedEligibility : { bad: true })}::jsonb`,
    }).where("id", "=", affectedScopeId).execute();
    const service = createService(fixture, policy);
    const withBot = { ...policy.sharedEligibility, matrixBot: policy.matrixBotEligibility };
    for (const record of [policy.sharedEligibility, withBot, policy.sharedEligibility, null]) {
      const transition = { executionGeneration: record ? 9 : null, eligibility: record };
      // Invalid current proof clears the cached capability and persisted authorization.
      const proof = record ? transition : { executionGeneration: 9, eligibility: ownedProfileFixture("profile-b").policy.sharedEligibility };
      await expect(service.reconcileExecutionEligibility(proof)).resolves.toEqual({ updated: 1 });
      await expect(service.reconcileExecutionEligibility(transition)).resolves.toEqual({ updated: 0 });
      const row = await fixture.db.selectFrom("collaboration_scopes").select("execution_eligibility").executeTakeFirstOrThrow();
      expect(row.execution_eligibility).toEqual(record);
      expect(service.matchesCurrentExecutionCapability({ executionGeneration: transition.executionGeneration, executionEligibility: record })).toBe(record !== null);
    }
    const events = await fixture.db.selectFrom("collaboration_events").selectAll()
      .where("event_type", "=", "scope.execution_eligibility_changed").orderBy("revision").execute();
    expect(events).toHaveLength(4);
    expect(events.map(event => Number(event.revision))).toEqual([2, 3, 4, 5]);
  });
  it("does not strand a scope when activation races capability reconciliation and startup repeats it", async () => {
    const { policy } = ownedProfileFixture();
    const eligibility = policy.sharedEligibility;
    const service = createService(fixture, policy);
    const preflight = await service.preflight({
      ownerId: collaborationActors.owner,
      organizationId: "org_matrix_team",
      chatId: collaborationIds.chat,
    });

    await Promise.all([
      service.shareChat({
        ownerId: collaborationActors.owner,
        organizationId: "org_matrix_team",
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

    const restarted = createService(fixture, policy);
    await expect(restarted.reconcileExecutionEligibility({ executionGeneration: 9, eligibility }))
      .resolves.toEqual({ updated: 0 });
    const next = { ...eligibility, matrixBot: policy.matrixBotEligibility };
    await expect(Promise.all([
      restarted.reconcileExecutionEligibility({ executionGeneration: 10, eligibility: next }),
      restarted.reconcileExecutionEligibility({ executionGeneration: 10, eligibility }),
    ])).resolves.toEqual([{ updated: 1 }, { updated: 1 }]);
    const latest = await fixture.db.selectFrom("collaboration_scopes").selectAll().where("id", "=", affectedScopeId).executeTakeFirstOrThrow();
    expect(Number(latest.execution_generation)).toBe(10);
    expect(latest.execution_eligibility).toEqual(eligibility);
    expect(restarted.matchesCurrentExecutionCapability({ executionGeneration: 10, executionEligibility: latest.execution_eligibility })).toBe(true);
  });
});

function createService(fixture: CollaborationTestDatabase, profilePolicy?: ReturnType<typeof ownedProfileFixture>["policy"]): CollaborationChatScopeService {
  return new CollaborationChatScopeService(fixture.db, {
    profilePolicy,
    runtimeId: collaborationIds.runtime,
    preflightSecret: "0123456789abcdef0123456789abcdef",
    now: () => new Date(now),
    createScopeId: () => affectedScopeId,
  });
}
