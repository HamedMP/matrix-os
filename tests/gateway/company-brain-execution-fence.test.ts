import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationChatScopeService } from "../../packages/gateway/src/collaboration/chat-scope.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { bootstrapCompanyBrainDatabase, type CompanyBrainDatabase } from "../../packages/gateway/src/company-brain/database.js";
import { CompanyBrainService } from "../../packages/gateway/src/company-brain/service.js";
import { allowAllOrganizationPrecondition, collaborationActors as actors, collaborationExecutionEligibility, collaborationIds as ids,
  createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const projectScope = "10000000-0000-4000-8000-000000000020";
const childScope = "10000000-0000-4000-8000-000000000021";
const at = new Date("2026-09-30T10:00:00Z");
const eligibility = collaborationExecutionEligibility();

describe("Company Brain capture execution fence", () => {
  let fixture: CollaborationTestDatabase;
  let db: Kysely<CompanyBrainDatabase>;
  let authority: CollaborationAuthority;
  let runtime: CollaborationChatScopeService;
  beforeEach(async () => {
    fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealCollaborationTestDatabase() : createCollaborationTestDatabase());
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    db = fixture.db as unknown as Kysely<CompanyBrainDatabase>;
    await bootstrapCompanyBrainDatabase(db);
    await new ChatRepository(fixture.db).create({ type: "personal", ownerId: actors.owner }, {
      id: "chat_brain_execution", clientRequestId: "req_brain_execution", title: "Company discussion",
    });
    const scopes = new CollaborationRepository(fixture.db, { now: () => at });
    await scopes.createDirectScope({ scopeId: projectScope, organizationId: "org_team", ownerId: actors.owner,
      kind: "project", resourceId: "project_brain_execution", authorityRuntimeId: ids.runtime });
    await scopes.createDirectScope({ scopeId: childScope, organizationId: "org_team", ownerId: actors.owner,
      kind: "chat", resourceId: "chat_brain_execution", authorityRuntimeId: ids.runtime });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", projectScope).execute();
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", membership_mode: "inherited",
      parent_scope_id: projectScope, execution_generation: 1, execution_eligibility: JSON.stringify(eligibility) }).where("id", "=", childScope).execute();
    authority = new CollaborationAuthority(scopes, { now: () => at, organizationPrecondition: allowAllOrganizationPrecondition });
    runtime = new CollaborationChatScopeService(fixture.db, { runtimeId: ids.runtime,
      preflightSecret: "0123456789abcdef0123456789abcdef", now: () => at });
  });
  afterEach(async () => { await fixture.destroy(); });

  it.each(["disabled", "missing_generation", "missing_eligibility"] as const)("rejects %s execution committed after authorization before source persistence", async (state) => {
    const before = await fixture.db.selectFrom("collaboration_scopes").select("auth_epoch").where("id", "=", childScope).executeTakeFirstOrThrow();
    let disabled = false;
    const service = new CompanyBrainService({ db, ownerId: actors.owner, now: () => at, authority: {
      organizationPrecondition: authority.organizationPrecondition,
      authorize: async (input) => {
        const context = await authority.authorize(input);
        if (input.scopeId === childScope && !disabled) {
          disabled = true;
          expect(await runtime.reconcileExecutionEligibility({ executionGeneration: null, eligibility: null })).toEqual({ updated: 1 });
          // Independently require each persisted execution field, including partially cleared state.
          if (state === "missing_generation") await fixture.db.updateTable("collaboration_scopes")
            .set({ execution_eligibility: JSON.stringify(eligibility) }).where("id", "=", childScope).execute();
          if (state === "missing_eligibility") await fixture.db.updateTable("collaboration_scopes")
            .set({ execution_generation: 1 }).where("id", "=", childScope).execute();
        }
        return context;
      },
    } });
    await expect(service.captureSlackMention(projectScope, childScope, actors.owner, {
      approval: { ownerId: actors.owner, organizationId: "org_team", scopeId: projectScope },
      appId: "A123", teamId: "T123", channelId: "C123", eventId: "Ev123", ts: "1790766000.000001", text: "Approved public decision",
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(disabled).toBe(true);
    expect(await fixture.db.selectFrom("collaboration_scopes").select("auth_epoch").where("id", "=", childScope).executeTakeFirstOrThrow()).toEqual(before);
    await expect(authority.authorize({ scopeId: childScope, actorId: actors.owner, action: "request_ai" })).rejects.toMatchObject({ code: "unavailable" });
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toEqual([]);
    expect(await db.selectFrom("company_brain_scopes").select("scope_id").execute()).toEqual([]);
  });
});
