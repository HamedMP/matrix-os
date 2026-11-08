import { expect } from "vitest";
import { OWNER } from "./bot-state-support.js";
import type { proposalFixture } from "./routine-cli-proposal-support.js";
import { createRoutineChatOriginService } from "../../../packages/gateway/src/bots/routine-chat-origin.js";
import type { VerifiedRoutineOriginApproval } from "../../../packages/gateway/src/bots/routine-origin-platform-client.js";
import { createHash } from "node:crypto";
import { scope } from "./routine-cli-request-support.js";
export async function admitFixtureRun(f: Pick<Awaited<ReturnType<typeof proposalFixture>>, "chats"> & { state: { clock: string } }, chatId = "chat_source", runId = "run_source") {
  const owner = { type: "personal" as const, ownerId: OWNER };
  let record = await f.chats.get(owner, chatId);
  if (!record) { await f.chats.create(owner, { id: chatId, clientRequestId: "req_create_" + chatId, title: "Fixture" }); record = (await f.chats.get(owner, chatId))!; }
  const at = f.state.clock, turnId = "cturn_" + runId;
  const selection = record.chat.currentSelection ?? { instanceId: "claude_code_default", model: "fixture-model" };
  const driverKind = record.providerBinding?.driverKind ?? "claude_code";
  const admitted = await f.chats.admitTurn(owner, { chatId, baseRevision: record.chat.revision,
    message: { id: "msg_" + runId, chatId, turnId, seq: record.chat.messageCount + 1, role: "user", state: "committed", parts: [{ type: "text", text: "Fixture input" }], createdAt: at },
    turn: { id: turnId, chatId, clientRequestId: "req_" + runId, baseMessageSeq: record.chat.messageCount, inputMessageId: "msg_" + runId, status: "accepted", createdAt: at, updatedAt: at },
    run: { id: runId, chatId, turnId, attempt: 1, driverKind, instanceId: selection.instanceId, selection, interactionMode: "default", permissionMode: "full_access", status: "accepted", historyBoundarySeq: record.chat.messageCount, createdAt: at, updatedAt: at,
      capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: true, userInput: true, resume: false, cancellation: true, worktrees: "none", interactionModes: ["default"], permissionModes: ["full_access"] } } });
  return admitted;
}
export const machine = { machineId: "fixture-machine", handle: "computer-one", runtimeSlot: "primary" };
export function originService(f: Awaited<ReturnType<typeof proposalFixture>>) {
  return createRoutineChatOriginService({ db: f.db, transact: f.transact, chats: f.chats, interactions: f.interactions,
    computerId: scope.computerId, expectedMachine: machine, now: () => new Date(f.state.clock), intervalMs: 100 });
}
/** Fixture of the nominal post-verification value. Actual Platform/Hono proof lane is separate. */
export function decisionProof(f: { state: { clock: string } }, interactionId: string, request = { kind: "approval" as const, baseRevision: 1, decision: "approve" as const }) {
  const at = Date.parse(f.state.clock);
  return { ...machine, ownerId: OWNER, purpose: "routine_origin_approval", sourceChatId: "chat_source", interactionId,
    method: "POST", path: `/api/chats/chat_source/routine-origin/${interactionId}/resolve`, ...request,
    bodyDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"), version: 1,
    sessionId: "fixture-session", nonce: "a".repeat(32), issuedAt: at, expiresAt: at + 60_000 } as VerifiedRoutineOriginApproval;
}
export async function terminalFixtureFire(f: Awaited<ReturnType<typeof proposalFixture>>, status: "completed" | "cancelled" | "uncertain" = "completed") {
  await admitFixtureRun(f); await f.submit(); await f.canonical.drain();
  const interaction = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  await f.interactions.resolve(OWNER, interaction.chat_id, interaction.interaction_id, { kind: "approval", decision: "approve", baseRevision: 1 });
  const routine = await f.db.selectFrom("bot_routines").selectAll().executeTakeFirstOrThrow();
  const run = await admitFixtureRun(f, interaction.chat_id, "run_fire");
  const { createBotTasksRepository } = await import("../../../packages/gateway/src/bots/repositories/tasks.js");
  const tasks = createBotTasksRepository(f.db), task = await tasks.create({ ownerId: OWNER, botId: routine.bot_id, chatId: routine.chat_id, now: f.state.clock });
  await tasks.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: 1, to: "running", runId: run.run.id, now: f.state.clock });
  const fireId = "fire_" + "c".repeat(24);
  await f.db.insertInto("bot_routine_fires").values({ fire_id: fireId, owner_id: OWNER, routine_id: routine.routine_id, task_id: task.taskId,
    scheduled_for: f.state.clock, status, attempts: 1, retry_after: null, lease_expires_at: null, failure_code: null, created_at: f.state.clock, updated_at: f.state.clock }).execute();
  const finish = async (parts: { type: "text"; text: string }[] = [{ type: "text", text: "Committed scheduled output" }]) => {
    const detail = (await f.chats.get({ type: "personal", ownerId: OWNER }, routine.chat_id))!;
    await f.chats.finishRun({ type: "personal", ownerId: OWNER }, { chatId: routine.chat_id, runId: run.run.id, outcome: "completed", completedAt: f.state.clock,
      output: { id: "msg_fire_output", chatId: routine.chat_id, seq: detail.chat.messageCount + 1, runId: run.run.id, turnId: run.turn.id,
        role: "assistant", state: "committed", parts, createdAt: f.state.clock } });
  };
  return { routine, fireId, finish, run, task };
}


/** Exercise project publication, which leaves the Chat's own collaboration field unset. */
export async function publishRoutineFixtureChatThroughProject(
  ownerDb: import("kysely").Kysely<import("../../../packages/gateway/src/bots/database.js").OwnerBotDatabase>,
  chatId: string,
  now: string,
) {
  const { createProjectInheritanceResolver } = await import("../../../packages/gateway/src/collaboration/project-inheritance.js");
  const { reconcileProjectMembershipAtPublication } = await import("../../../packages/gateway/src/collaboration/project-membership-transition.js");
  type CollaborationDb = import("../../../packages/gateway/src/collaboration/database.js").OwnerCollaborationDatabase;
  const db = ownerDb as unknown as import("kysely").Kysely<CollaborationDb>;
  const projectScopeId = "10000000-0000-4000-8000-000000000b93", runtimeId = "vps:routine_origin_test";
  await db.insertInto("collaboration_scopes").values({
    id: projectScopeId, owner_type: "personal", owner_id: OWNER, organization_id: "org_scope_test",
    kind: "project", resource_id: "project_scope_test", parent_scope_id: null, membership_mode: "direct",
    lifecycle: "preparing", revision: 1, auth_epoch: 1, authority_runtime_id: runtimeId, authority_generation: 1,
    created_at: now, updated_at: now, deleted_at: null,
  }).execute();
  await createProjectInheritanceResolver({ db }).bindOwnedResource({
    projectScopeId, ownerId: OWNER, kind: "chat", resourceId: chatId, authorityRuntimeId: runtimeId,
    authorityGeneration: 1, revision: 1, readiness: "ready",
  });
  await db.transaction().execute(async tx => {
    await tx.selectFrom("collaboration_scopes").select("id").where("id", "=", projectScopeId).forUpdate().executeTakeFirstOrThrow();
    await reconcileProjectMembershipAtPublication(tx, { projectScopeId, ownerType: "personal", ownerId: OWNER,
      requestedBy: OWNER, destinationAuthorityRuntimeId: runtimeId, destinationAuthorityGeneration: 1, now: new Date(now),
      createEventId: () => "60000000-0000-4000-8000-000000000b93" });
    await tx.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", projectScopeId).execute();
  });
  expect(await db.selectFrom("chats").select("collaboration").where("id", "=", chatId).executeTakeFirstOrThrow()).toEqual({ collaboration: null });
  expect(await db.selectFrom("collaboration_scopes").select("lifecycle").where("kind", "=", "chat").where("resource_id", "=", chatId).executeTakeFirstOrThrow()).toEqual({ lifecycle: "shared" });

}
