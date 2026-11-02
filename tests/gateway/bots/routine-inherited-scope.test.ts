import { ChatConflictError } from "../../../packages/gateway/src/chat/errors.js";
/** Reproduces private routine authority crossing a real Project assignment. No models or accounts. */
import { beforeEach, expect, it } from "vitest";
import { bootstrapCollaborationDatabase, type OwnerCollaborationDatabase } from "../../../packages/gateway/src/collaboration/database.js";
import { createProjectChatAssignmentCoordinator } from "../../../packages/gateway/src/collaboration/project-chat-assignment.js";
import { createProjectInheritanceResolver } from "../../../packages/gateway/src/collaboration/project-inheritance.js";
import { reconcileProjectMembershipAtPublication } from "../../../packages/gateway/src/collaboration/project-membership-transition.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { CHAT, data, binding, proposal, setup, activated, admitFixture } from "./routine-authorization-support.js";
import { OWNER, NOW } from "./bot-state-support.js";
import type { Kysely } from "kysely";

const owner = { type: "personal" as const, ownerId: OWNER };
const projectId = "project_routine_scope_test";
const projectScopeId = "10000000-0000-4000-8000-000000000b93";
const collaborationDb = () => data.db as unknown as Kysely<OwnerCollaborationDatabase>;

beforeEach(async () => {
  await bootstrapCollaborationDatabase(collaborationDb());
  await collaborationDb().insertInto("collaboration_scopes").values({
    id: projectScopeId, owner_type: "personal", owner_id: OWNER, organization_id: "org_scope_test",
    kind: "project", resource_id: projectId, parent_scope_id: null, membership_mode: "direct",
    lifecycle: "shared", revision: 1, auth_epoch: 1, authority_runtime_id: "vps:routine_scope_test",
    authority_generation: 1, execution_generation: null, execution_eligibility: null,
    created_at: NOW, updated_at: NOW, deleted_at: null,
  }).execute();
});

async function shareThroughProject() {
  const repository = new ChatRepository(data.db as never);
  const current = await repository.get(owner, CHAT);
  return createProjectChatAssignmentCoordinator({ db: collaborationDb(), chatRepository: repository })
    .run(owner, tx => tx.update(owner, CHAT, { projectId, baseRevision: current!.chat.revision }));
}

async function enqueueRoutine(repository: ChatRepository, fireId: string, retainForeground = false) {
  const foreground = await admitFixture("foreground_scope", "req_foreground_scope", "_foreground");
  const queued = await repository.enqueueQueuedTurn(owner, {
    chatId: CHAT, baseRevision: (await repository.get(owner, CHAT))!.chat.revision,
    queuedTurnId: "qturn_inherited_scope", clientRequestId: `req_routine_${fireId}`,
    parts: [{ type: "text", text: "private scheduled input" }], driverKind: "matrix_bot",
    selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default", createdAt: NOW,
    capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: true,
      userInput: true, resume: false, cancellation: true, worktrees: "none", interactionModes: ["default"], permissionModes: ["default"] },
  });
  if (!retainForeground) await repository.finishRun(owner, { chatId: CHAT, runId: foreground.runId, outcome: "completed", completedAt: NOW });
  return { ...queued, foreground };
}

async function historicalSharedScope() {
  await collaborationDb().insertInto("collaboration_scopes").values({
    id: "20000000-0000-4000-8000-000000000b93", owner_type: "personal", owner_id: OWNER,
    kind: "chat", resource_id: CHAT, parent_scope_id: projectScopeId, membership_mode: "inherited",
    lifecycle: "shared", revision: 1, auth_epoch: 1, authority_runtime_id: "vps:routine_scope_test", authority_generation: 1,
    created_at: NOW, updated_at: NOW, deleted_at: null,
  }).execute();
}

it("terminalizes a legacy private queue before its prompt can enter a shared transcript", async () => {
  const { f } = await activated();
  const repository = new ChatRepository(data.db as never);
  await enqueueRoutine(repository, f.fireId);
  await historicalSharedScope();
  const before = await data.db.selectFrom("chat_messages").selectAll().where("chat_id", "=", CHAT).execute();
  await expect(repository.claimNextQueuedTurn(owner, { chatId: CHAT, runId: "run_scope_queue", turnId: "cturn_scope_queue",
    messageId: "msg_scope_queue", claimedAt: NOW })).resolves.toBeNull();
  expect((await data.db.selectFrom("chat_queued_turns").select("status").where("id", "=", "qturn_inherited_scope").executeTakeFirst())?.status).toBe("cancelled");
  expect(await data.db.selectFrom("chat_messages").selectAll().where("chat_id", "=", CHAT).execute()).toEqual(before);
  expect(await repository.listQueuedChatIds(owner)).toEqual([]);
});

it("allows sharing after a claimed routine has completed, without treating its retained queue row as active", async () => {
  const { f } = await activated();
  const repository = new ChatRepository(data.db as never);
  await enqueueRoutine(repository, f.fireId);
  const admitted = await repository.claimNextQueuedTurn(owner, { chatId: CHAT, runId: "run_scope_queue", turnId: "cturn_scope_queue",
    messageId: "msg_scope_queue", claimedAt: NOW });
  expect(admitted).not.toBeNull();
  await repository.finishRun(owner, { chatId: CHAT, runId: "run_scope_queue", outcome: "completed", completedAt: NOW });
  await expect(shareThroughProject()).resolves.toBeDefined();
});

it("rejects pending owner approval after its Bot Chat inherits a shared Project", async () => {
  const { service, interactions, repo } = setup();
  const pending = await service.propose(binding, proposal);
  await shareThroughProject();
  // The actual producer leaves this legacy field null: checking only it is the fault.
  expect((await data.db.selectFrom("chats").select("collaboration").where("id", "=", CHAT).executeTakeFirst())?.collaboration).toBeNull();
  const interaction = await createBotInteractionsRepository(data.db).get({ ownerId: OWNER, interactionId: pending.interactionId });
  await expect(interactions.resolve(OWNER, CHAT, pending.interactionId, {
    kind: "approval", decision: "approve", baseRevision: interaction!.revision,
  })).rejects.toThrow();
  expect(await repo.list(OWNER)).toEqual([]);
});

it("revokes execution eligibility of an approved routine after real Project assignment", async () => {
  const { service, r } = await activated({ dispatch: false });
  expect(await service.authorize(r)).toBe(true);
  await shareThroughProject();
  expect(await service.authorize(r)).toBe(false);
});

it("does not publish a Project assignment while a canonical routine run is active", async () => {
  const { f } = await activated();
  await admitFixture(f.fireId);
  await expect(shareThroughProject()).rejects.toThrow();
  expect((await data.db.selectFrom("chats").select("project_id").where("id", "=", CHAT).executeTakeFirst())?.project_id).toBeNull();
  expect(await collaborationDb().selectFrom("collaboration_scopes").select("id")
    .where("kind", "=", "chat").where("resource_id", "=", CHAT).where("lifecycle", "=", "shared").execute()).toEqual([]);
});

it("rejects whole-Project publication while a previously private routine is running", async () => {
  const { f } = await activated();
  await collaborationDb().updateTable("collaboration_scopes").set({ lifecycle: "preparing" }).where("id", "=", projectScopeId).execute();
  await createProjectInheritanceResolver({ db: collaborationDb() }).bindOwnedResource({
    projectScopeId, ownerId: OWNER, kind: "chat", resourceId: CHAT,
    authorityRuntimeId: "vps:routine_scope_test", authorityGeneration: 1, revision: 1, readiness: "ready",
  });
  await admitFixture(f.fireId);
  await expect(collaborationDb().transaction().execute(tx => reconcileProjectMembershipAtPublication(tx, {
    projectScopeId, ownerType: "personal", ownerId: OWNER, requestedBy: OWNER,
    destinationAuthorityRuntimeId: "vps:routine_scope_test", destinationAuthorityGeneration: 1,
    now: new Date(NOW), createEventId: () => "60000000-0000-4000-8000-000000000b93",
  }))).rejects.toThrow();
  expect((await collaborationDb().selectFrom("collaboration_scopes").select("lifecycle")
    .where("kind", "=", "chat").where("resource_id", "=", CHAT).executeTakeFirst())?.lifecycle).toBe("preparing");
});

it("rejects canonical admission after sharing instead of writing the private routine prompt", async () => {
  const { f } = await activated();
  await shareThroughProject();
  await expect(admitFixture(f.fireId)).rejects.toThrow();
  expect(await data.db.selectFrom("chat_messages").select("id").where("chat_id", "=", CHAT).execute()).toEqual([]);
});

it.each(["shared", "archived", "deleted", "recovering"] as const)("blocks late private output into a historical %s scope, including a retried run", async lifecycle => {
  const { f } = await activated();
  const { repository, runId } = await admitFixture(f.fireId);
  // A historical in-flight run from before this fix. Its original persisted
  // turn remains a routine even when a retry replaces the run request ID.
  await data.db.updateTable("chat_runs").set({ client_request_id: "req_retry_scope_test" }).where("id", "=", runId).execute();
  await collaborationDb().insertInto("collaboration_scopes").values({
    id: "20000000-0000-4000-8000-000000000b93", owner_type: "personal", owner_id: OWNER,
    kind: "chat", resource_id: CHAT, parent_scope_id: projectScopeId, membership_mode: "inherited",
    lifecycle, revision: 1, auth_epoch: 1, authority_runtime_id: "vps:routine_scope_test", authority_generation: 1,
    created_at: NOW, updated_at: NOW, deleted_at: lifecycle === "deleted" ? NOW : null,
  }).execute();
  await expect(repository.appendAssistantDelta(owner, { chatId: CHAT, runId, messageId: "msg_scope_output", delta: "private output", createdAt: NOW })).rejects.toThrow();
  expect(await data.db.selectFrom("chat_messages").select("id").where("role", "=", "assistant").execute()).toEqual([]);
  // Safe terminal settlement remains available without new private output.
  await expect(repository.finishRun(owner, { chatId: CHAT, runId, outcome: "failed", completedAt: NOW })).resolves.toMatchObject({ transitioned: true });
});


async function beginRoutineSteering(fireId: string) {
  const repository = new ChatRepository(data.db as never);
  const queued = await enqueueRoutine(repository, fireId, true);
  const run = await data.db.selectFrom("chat_runs").select("capability_snapshot").where("id", "=", queued.foreground.runId).executeTakeFirstOrThrow();
  const capability = typeof run.capability_snapshot === "string" ? JSON.parse(run.capability_snapshot) : run.capability_snapshot;
  await data.db.updateTable("chat_runs").set({ capability_snapshot: JSON.stringify({ ...capability, steering: "same_run" }) }).where("id", "=", queued.foreground.runId).execute();
  const input = { chatId: CHAT, runId: queued.foreground.runId, queuedTurnId: queued.queuedTurn.id,
    expectedTurnId: "cturn_routine_fixture_foreground", clientRequestId: "req_scope_steer", steerId: "steer_scope_test", messageId: "msg_scope_steer",
    baseRevision: (await repository.get(owner, CHAT))!.chat.revision, createdAt: NOW };
  return { repository, input };
}

it("does not expose a historical shared routine queue to the steering adapter", async () => {
  const { f } = await activated();
  const { repository, input } = await beginRoutineSteering(f.fireId);
  await historicalSharedScope();
  await expect(repository.beginQueuedTurnSteer(owner, input)).rejects.toThrow();
  expect(await data.db.selectFrom("chat_run_steers").select("id").execute()).toEqual([]);
});

it("rechecks a pending steering replay and ACK before writing private queued input", async () => {
  const { f } = await activated();
  const { repository, input } = await beginRoutineSteering(f.fireId);
  await seedLegacyPendingSteer(input);
  await historicalSharedScope();
  await expect(repository.beginQueuedTurnSteer(owner, input)).rejects.toThrow();
  await expect(repository.acceptQueuedTurnSteer(owner, { ...input, acceptedAt: NOW })).rejects.toThrow();
  expect(await data.db.selectFrom("chat_messages").select("id").where("search_text", "=", "private scheduled input").execute()).toEqual([]);
});

it("blocks late output of a foreground run that consumed a private routine through steering", async () => {
  const { f } = await activated();
  const { repository, input } = await beginRoutineSteering(f.fireId);
  await seedLegacyConsumedRoutine(input);
  await historicalSharedScope();
  await expect(repository.appendAssistantDelta(owner, { chatId: CHAT, runId: input.runId, messageId: "msg_steered_scope",
    delta: "private routine result", createdAt: NOW })).rejects.toThrow();
});

async function steeredForegroundRetry() {
  const { f } = await activated();
  const { repository, input } = await beginRoutineSteering(f.fireId);
  await seedLegacyConsumedRoutine(input);
  await repository.finishRun(owner, { chatId: CHAT, runId: input.runId, outcome: "failed", completedAt: NOW });
  const exported = (await repository.exportChat(owner, CHAT))!;
  const { outcome: _outcome, completedAt: _completedAt, startedAt: _startedAt, ...first } = exported.runs[0];
  const retry = () => repository.admitRetry(owner, { chatId: CHAT, turnId: first.turnId,
    clientRequestId: "req_scope_foreground_retry", baseRevision: exported.chat.chat.revision,
    run: { ...first, id: "run_scope_foreground_retry", attempt: 2, status: "accepted" } });
  return { repository, retry };
}

it("does not lose private routine origin when a steered foreground turn is retried", async () => {
  const { retry } = await steeredForegroundRetry();
  await historicalSharedScope();
  await expect(retry()).rejects.toBeInstanceOf(ChatConflictError);
  expect(await data.db.selectFrom("chat_runs").select("id").where("id", "=", "run_scope_foreground_retry").execute()).toEqual([]);
});

it("blocks late output of a retry whose original foreground turn consumed private routine input", async () => {
  const { repository, retry } = await steeredForegroundRetry();
  await retry(); await historicalSharedScope();
  await expect(repository.appendAssistantDelta(owner, { chatId: CHAT, runId: "run_scope_foreground_retry",
    messageId: "msg_scope_retry_output", delta: "private retry result", createdAt: NOW })).rejects.toThrow();
});

it("keeps a steered turn private through Retry and releases the publication fence when it finishes", async () => {
  const { repository, retry } = await steeredForegroundRetry();
  await collaborationDb().updateTable("collaboration_scopes").set({ lifecycle: "preparing" }).where("id", "=", projectScopeId).execute();
  await createProjectInheritanceResolver({ db: collaborationDb() }).bindOwnedResource({
    projectScopeId, ownerId: OWNER, kind: "chat", resourceId: CHAT,
    authorityRuntimeId: "vps:routine_scope_test", authorityGeneration: 1, revision: 1, readiness: "ready",
  });
  await retry();
  const publish = () => collaborationDb().transaction().execute(tx => reconcileProjectMembershipAtPublication(tx, {
    projectScopeId, ownerType: "personal", ownerId: OWNER, requestedBy: OWNER,
    destinationAuthorityRuntimeId: "vps:routine_scope_test", destinationAuthorityGeneration: 1,
    now: new Date(NOW), createEventId: () => "60000000-0000-4000-8000-000000000b93",
  }));
  await expect(publish()).rejects.toThrow();
  await repository.finishRun(owner, { chatId: CHAT, runId: "run_scope_foreground_retry", outcome: "completed", completedAt: NOW });
  await expect(publish()).resolves.toBeDefined();
});

it("keeps a private routine queued for its own canonical run instead of steering into an ordinary task", async () => {
  const { f } = await activated();
  const { repository, input } = await beginRoutineSteering(f.fireId);
  await expect(repository.beginQueuedTurnSteer(owner, input)).rejects.toBeInstanceOf(ChatConflictError);
  expect(await data.db.selectFrom("chat_run_steers").select("id").execute()).toEqual([]);
  expect(await data.db.selectFrom("chat_queued_turns").select("status").where("id", "=", input.queuedTurnId).executeTakeFirst()).toMatchObject({ status: "queued" });
  await repository.finishRun(owner, { chatId: CHAT, runId: input.runId, outcome: "completed", completedAt: NOW });
  const admitted = await repository.claimNextQueuedTurn(owner, { chatId: CHAT, runId: "run_own_routine",
    turnId: "cturn_own_routine", messageId: "msg_own_routine", claimedAt: NOW });
  expect(admitted?.turn.clientRequestId).toBe(`req_routine_${f.fireId}`);
});

it("rejects replay of a historical pending routine steer before returning adapter input", async () => {
  const { f } = await activated();
  const { repository, input } = await beginRoutineSteering(f.fireId);
  await seedLegacyPendingSteer(input);
  await expect(repository.beginQueuedTurnSteer(owner, input)).rejects.toBeInstanceOf(ChatConflictError);
});

it("rejects a historical routine steering ACK while allowing failure cleanup and retaining its queue", async () => {
  const { f } = await activated();
  const { repository, input } = await beginRoutineSteering(f.fireId);
  await seedLegacyPendingSteer(input);
  await expect(repository.acceptQueuedTurnSteer(owner, { ...input, acceptedAt: NOW })).rejects.toBeInstanceOf(ChatConflictError);
  expect(await data.db.selectFrom("chat_messages").select("id").where("search_text", "=", "private scheduled input").execute()).toEqual([]);
  await repository.failQueuedTurnSteer(owner, { ...input, acceptedAt: NOW });
  expect(await data.db.selectFrom("chat_queued_turns").select("status").where("id", "=", input.queuedTurnId).executeTakeFirst()).toMatchObject({ status: "queued" });
});

async function seedLegacyPendingSteer(input: Awaited<ReturnType<typeof beginRoutineSteering>>["input"]) {
  const queued = await data.db.selectFrom("chat_queued_turns").select("parts").where("id", "=", input.queuedTurnId).executeTakeFirstOrThrow();
  await data.db.insertInto("chat_run_steers").values({ id: input.steerId, chat_id: CHAT, run_id: input.runId,
    turn_id: input.expectedTurnId, client_request_id: input.clientRequestId, message_id: input.messageId,
    queued_turn_id: input.queuedTurnId, parts: typeof queued.parts === "string" ? queued.parts : JSON.stringify(queued.parts),
    status: "pending", created_at: NOW, updated_at: NOW }).execute();
}

/** Legacy versions could consume a routine into a foreground Turn. Preserve its persisted origin for recovery tests. */
async function seedLegacyConsumedRoutine(input: Awaited<ReturnType<typeof beginRoutineSteering>>["input"]) {
  await data.db.updateTable("chat_queued_turns").set({ status: "claimed", claimed_turn_id: input.expectedTurnId,
    claimed_run_id: input.runId, updated_at: NOW }).where("id", "=", input.queuedTurnId).execute();
}
