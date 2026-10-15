import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type KyselyPlugin } from "kysely";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { bootstrapCompanyBrainDatabase, type CompanyBrainDatabase } from "../../packages/gateway/src/company-brain/database.js";
import { CompanyBrainService } from "../../packages/gateway/src/company-brain/service.js";
import { collaborationExecutionEligibility, allowAllOrganizationPrecondition, collaborationActors as actors, collaborationIds as ids, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const projectScope = "10000000-0000-4000-8000-000000000020";
const childScope = "10000000-0000-4000-8000-000000000021";
const at = new Date("2026-09-30T10:00:00Z");

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("Company Brain Project/Chat row lock ordering on PostgreSQL", () => {
  let fixture: CollaborationTestDatabase;
  let db: Kysely<CompanyBrainDatabase>;
  let service: CompanyBrainService;
  let authority: CollaborationAuthority;
  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    db = fixture.db as unknown as Kysely<CompanyBrainDatabase>;
    await bootstrapCompanyBrainDatabase(db);
    const repository = new CollaborationRepository(fixture.db, { now: () => at });
    await repository.createDirectScope({ scopeId: projectScope, organizationId: "org_team", ownerId: actors.owner, kind: "project", resourceId: "project_company_capture", authorityRuntimeId: ids.runtime });
    await repository.createDirectScope({ scopeId: childScope, organizationId: "org_team", ownerId: actors.owner, kind: "chat", resourceId: "chat_company_capture", authorityRuntimeId: ids.runtime });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", auth_epoch: 1 }).where("id", "=", projectScope).execute();
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", auth_epoch: 1, membership_mode: "inherited", parent_scope_id: projectScope, execution_generation: 1, execution_eligibility: JSON.stringify(collaborationExecutionEligibility()) }).where("id", "=", childScope).execute();
    authority = new CollaborationAuthority(repository, { now: () => at, organizationPrecondition: allowAllOrganizationPrecondition });
    service = new CompanyBrainService({ db, authority, ownerId: actors.owner, now: () => at });
  });
  async function seedQueueChat() {
    await fixture.db.insertInto("chats").values({ id: "chat_company_capture", owner_type: "personal", owner_id: actors.owner,
      create_request_id: "req_brain_queue", project_id: "project_company_capture", title: "Company queue", lifecycle: "active", attention: "none",
      revision: 1, message_count: 0, collaboration: JSON.stringify({ scopeId: childScope, mode: "shared_ai", executionFenced: true }),
      user_state: null, shell_state: null, fork_provenance: null, last_message_preview: null,
      current_selection: JSON.stringify({ instanceId: "claude_code_default", model: "opus" }), bound_driver_kind: "claude_code",
      bound_instance_id: "claude_code_default", bound_at_turn_id: "cturn_original", created_at: at.toISOString(), updated_at: at.toISOString() }).execute();
  }
  function queueRequest() {
    return { chatId: "chat_company_capture", scopeId: childScope, queuedTurnId: "qturn_brain_overlap",
      clientRequestId: "75000000-0000-4000-8000-000000000001", requestingActorId: actors.owner, acceptedAuthEpoch: 1,
      payloadHash: "b".repeat(64), expectedRevision: 1, parts: [{ type: "text" as const, text: "Use approved context" }],
      interactionMode: "default", permissionMode: "supervised", acceptedAt: at.toISOString(),
      capabilitySnapshot: { revision: "brain-overlap", rootChat: true, attachments: [], resources: [], tools: [], approvals: true,
        userInput: false, resume: true, cancellation: true, steering: "none" as const, worktrees: "none" as const,
        interactionModes: ["default"], permissionModes: ["supervised"] } };
  }
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
  it.each([
    ["enqueue", "capture"], ["enqueue", "publication"], ["claim", "capture"], ["claim", "publication"],
  ] as const)("allows real queue %s to overlap Brain %s without reversing Project/Chat locks", async (queueOperation, brainOperation) => {
    await seedQueueChat();
    const owner = { type: "personal" as const, ownerId: actors.owner };
    let paused!: () => void;
    const held = new Promise<void>(resolve => { paused = resolve; });
    let release!: () => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    let armed = false;
    let intercepted = false;
    let queryId: object | undefined;
    // Pause only after the real queue has acquired its Chat scope row lock.
    const plugin: KyselyPlugin = {
      transformQuery(args) {
        const node = JSON.stringify(args.node);
        if (armed && !intercepted && node.includes('"modifier":"ForUpdate"')
          && node.includes('"name":"collaboration_scopes"') && node.includes(childScope)) {
          queryId = args.queryId; intercepted = true;
        }
        return args.node;
      },
      async transformResult(args) {
        if (args.queryId === queryId) { queryId = undefined; paused(); await proceed; }
        return args.result;
      },
    };
    const repository = new ChatRepository(fixture.db.withPlugin(plugin));
    repository.setSharedAuthorizer((scopeId, actorId, action) => authority.authorize({ scopeId, actorId, action }));
    if (queueOperation === "claim") await repository.enqueueSharedQueuedTurn(owner, queueRequest());
    armed = true;
    const queue = queueOperation === "enqueue" ? repository.enqueueSharedQueuedTurn(owner, queueRequest())
      : repository.claimNextQueuedTurn(owner, { chatId: "chat_company_capture", turnId: "cturn_brain_overlap",
        runId: "run_brain_overlap", messageId: "msg_brain_overlap", claimedAt: at.toISOString() });
    let brain: Promise<unknown> | undefined;
    try {
      await Promise.race([held, queue.then(() => { throw new Error("Queue did not reach its Chat lock"); })]);
      const active = await sql<{ pid: number }>`SELECT DISTINCT activity.pid FROM pg_stat_activity activity
        JOIN pg_locks held ON held.pid=activity.pid
        WHERE held.relation='collaboration_scopes'::regclass AND held.granted
        AND activity.state='idle in transaction' AND activity.query LIKE '%collaboration_scopes%'`.execute(db);
      expect(active.rows).toHaveLength(1);
      const pid = active.rows[0]!.pid;
      brain = brainOperation === "capture"
        ? service.captureSlackMention(projectScope, childScope, actors.owner, { approval: { ownerId: actors.owner,
          organizationId: "org_team", scopeId: projectScope }, appId: "A123", teamId: "T123", channelId: "C123",
          eventId: "Ev123", ts: "1790766000.000001", text: "Approved launch decision" })
        : service.publish(childScope, actors.owner, { sourceId: "a".repeat(64), audienceScopeId: childScope, title: "Decision",
          text: "Approved launch decision", permalink: "https://example.com/decision", sourceUpdatedAt: at.toISOString(), expectedRevision: 0 });
      const settled = Promise.allSettled([queue, brain]);
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          const result = await sql<{ blocked: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`.execute(db);
          blocked = result.rows[0]?.blocked === true;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      } finally { release(); }
      const results = await settled;
      for (const result of results) if (result.status === "rejected") throw result.reason;
      expect(results[0]).toMatchObject({ status: "fulfilled", value: expect.anything() });
      expect(await db.selectFrom("company_brain_documents").select("source_id").execute()).toHaveLength(1);
    } finally { release(); await Promise.allSettled(brain ? [queue, brain] : [queue]); }
  }, 10_000);

  it("rejects a reparented queue context before locking a different Project after its Chat", async () => {
    await seedQueueChat();
    const stale = await authority.authorize({ scopeId: childScope, actorId: actors.owner, action: "request_ai" });
    const nextParent = "10000000-0000-4000-8000-000000000022";
    const scopes = new CollaborationRepository(fixture.db, { now: () => at });
    await scopes.createDirectScope({ scopeId: nextParent, organizationId: "org_team", ownerId: actors.owner,
      kind: "project", resourceId: "project_reparented", authorityRuntimeId: ids.runtime });
    await fixture.db.updateTable("collaboration_scopes").set({ parent_scope_id: nextParent }).where("id", "=", childScope).execute();
    let lockedNewParent = false;
    const plugin: KyselyPlugin = {
      transformQuery(args) {
        const query = JSON.stringify(args.node);
        if (query.includes('"modifier":"ForUpdate"') && query.includes(nextParent)) lockedNewParent = true;
        return args.node;
      },
      async transformResult(args) { return args.result; },
    };
    const queue = new ChatRepository(fixture.db.withPlugin(plugin));
    queue.setSharedAuthorizer(async () => stale);
    await expect(queue.enqueueSharedQueuedTurn({ type: "personal", ownerId: actors.owner }, queueRequest()))
      .rejects.toMatchObject({ code: expect.stringMatching(/^(forbidden|unavailable)$/) });
    expect(lockedNewParent).toBe(false);
    expect(await fixture.db.selectFrom("chat_queued_turns").select("id").execute()).toHaveLength(0);
  });

});
