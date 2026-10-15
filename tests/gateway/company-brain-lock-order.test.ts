import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { bootstrapCompanyBrainDatabase, type CompanyBrainDatabase } from "../../packages/gateway/src/company-brain/database.js";
import { CompanyBrainService } from "../../packages/gateway/src/company-brain/service.js";
import { allowAllOrganizationPrecondition, collaborationActors as actors, collaborationIds as ids, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const projectScope = "10000000-0000-4000-8000-000000000020";
const childScope = "10000000-0000-4000-8000-000000000021";
const at = new Date("2026-09-30T10:00:00Z");

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("Company Brain Project/Chat row lock ordering on PostgreSQL", () => {
  let fixture: CollaborationTestDatabase;
  let db: Kysely<CompanyBrainDatabase>;
  let service: CompanyBrainService;
  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    db = fixture.db as unknown as Kysely<CompanyBrainDatabase>;
    await bootstrapCompanyBrainDatabase(db);
    const repository = new CollaborationRepository(fixture.db, { now: () => at });
    await repository.createDirectScope({ scopeId: projectScope, organizationId: "org_team", ownerId: actors.owner, kind: "project", resourceId: "company_capture", authorityRuntimeId: ids.runtime });
    await repository.createDirectScope({ scopeId: childScope, organizationId: "org_team", ownerId: actors.owner, kind: "chat", resourceId: "company_capture_chat", authorityRuntimeId: ids.runtime });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", projectScope).execute();
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", membership_mode: "inherited", parent_scope_id: projectScope, execution_generation: 1, execution_eligibility: {} }).where("id", "=", childScope).execute();
    const authority = new CollaborationAuthority(repository, { now: () => at, organizationPrecondition: allowAllOrganizationPrecondition });
    service = new CompanyBrainService({ db, authority, ownerId: actors.owner, now: () => at });
  });
  afterEach(async () => { await fixture.destroy(); });

  it.each(["capture", "publication"] as const)("allows %s to overlap Project-before-Chat assignment locking without deadlock", async (operation) => {
    let projectLocked!: (pid: number) => void;
    const held = new Promise<number>((resolve) => { projectLocked = resolve; });
    let continueAssignment!: () => void;
    const proceed = new Promise<void>((resolve) => { continueAssignment = resolve; });
    // Match project-chat-assignment's targetProject -> currentBinding lock order.
    const assignment = fixture.db.transaction().execute(async (trx) => {
      const { rows: [backend] } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      if (!backend) throw new Error("PostgreSQL backend unavailable");
      await trx.selectFrom("collaboration_scopes").select("id").where("id", "=", projectScope).forUpdate().executeTakeFirstOrThrow();
      projectLocked(backend.pid);
      await proceed;
      await trx.selectFrom("collaboration_scopes").select("id").where("id", "=", childScope).forUpdate().executeTakeFirstOrThrow();
    });
    const pid = await held;
    const mutation = operation === "capture"
      ? service.captureSlackMention(projectScope, childScope, actors.owner, { approval: { ownerId: actors.owner, organizationId: "org_team", scopeId: projectScope }, appId: "A123", teamId: "T123", channelId: "C123", eventId: "Ev123", ts: "1790766000.000001", text: "Approved launch decision" })
      : service.publish(childScope, actors.owner, { sourceId: "a".repeat(64), audienceScopeId: childScope, title: "Decision", text: "Approved launch decision", permalink: "https://example.com/decision", sourceUpdatedAt: at.toISOString(), expectedRevision: 0 });
    const settled = Promise.allSettled([assignment, mutation]);
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const result = await sql<{ blocked: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`.execute(db);
        blocked = result.rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { continueAssignment(); }
    const results = await settled;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toHaveLength(1);
  }, 10_000);
});
