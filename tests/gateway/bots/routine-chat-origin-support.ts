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
