import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotRoutineApprovals } from "../../../packages/gateway/src/bots/routine-approval.js";
import { routineApprovalDigest } from "../../../packages/gateway/src/bots/routine-authorization.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotApprovalsRepository } from "../../../packages/gateway/src/bots/repositories/approvals.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createRoutineCliCanonicalControl } from "../../../packages/gateway/src/bots/routine-cli-canonical-control.js";
import { requestFixture, insertRoutine, proposal, scope, TARGET_A } from "./routine-cli-request-support.js";
import { BOT, NOW, OWNER, at } from "./bot-state-support.js";
import { invocation } from "./routine-cli-source-support.js";
/** Actual canonical standing-approval/data/outbox/control; external owner-local peer snapshot and source
 * policy are explicit fixtures. No proposal admission, runtime binding or real account is fabricated. */
export async function canonicalFixture(db: Kysely<OwnerBotDatabase>) {
  const f = await requestFixture(db), id = await insertRoutine(db, 1, { status: "paused" });
  const authority = { accountId: "fixture-account", computerId: scope.computerId, grantRevision: 1,
    definitionRevision: (await f.agents.get({ type: "personal", ownerId: OWNER }, BOT))!.revision };
  const policy = { background: true, accountId: authority.accountId, computerId: authority.computerId, grantRevision: 1, definitionRevision: authority.definitionRevision };
  const approvals = createBotRoutineApprovals({ db, transact: f.transact, now: () => new Date(f.state.clock),
    definitionRevision: async (ownerId, botId) => {
      const definition = await f.agents.get({ type: "personal", ownerId }, botId);
      if (!definition?.recipeRef || definition.archived) throw new Error("Fixture definition unavailable");
      return policy.definitionRevision;
    }, source: { resolve: async () => {
      if (!policy.background) throw new Error("Fixture background source disabled");
      return { accessSourceId: "matrix_chatgpt_plan", route: { api: "openai-responses", modelId: proposal.selection.model,
        input: ["text"], contextWindow: 1000, maxOutputTokens: 100 }, subscription: { ...policy, peerId: invocation(900) } };
    } } });
  const tasks = createBotTasksRepository(db), task = await tasks.create({ ownerId: OWNER, ...TARGET_A, now: NOW });
  const { interaction } = await createBotInteractionsRepository(db).create({ ownerId: OWNER, ...TARGET_A, taskId: task.taskId,
    kind: "approval", payload: { kind: "approval", tool: "routine.activate" }, responderActorId: OWNER, blocking: true, expiresAt: at(86400000), now: NOW });
  const approvalId = interaction.interactionId, approvalRepo = createBotApprovalsRepository(db);
  const binding = { taskId: task.taskId, tool: "routine.activate", argsHash: routineApprovalDigest(proposal, authority),
    account: authority.accountId, audience: "direct", policyRevision: authority.grantRevision };
  const approval = await approvalRepo.create({ ownerId: OWNER, botId: BOT, approvalId, runId: "run_fixture_standing_approval", ...binding, expiresAt: at(86400000), now: NOW });
  await approvalRepo.decide({ ownerId: OWNER, approvalId, baseRevision: approval.revision, decision: "approved", now: NOW });
  await approvalRepo.claim({ ownerId: OWNER, approvalId, ...binding, now: NOW });
  await db.updateTable("bot_routines").set({ approved_source: authority, approval_id: approvalId }).where("routine_id", "=", id).execute();
  const execution = createBotRoutineExecution({ db, approvals, transact: f.transact, now: () => new Date(f.state.clock) });
  const adapter = createRoutineCliCanonicalControl({ control: execution });
  const operation = (op: "pause" | "resume" | "archive", baseRevision = 1, n = 100) => ({ operation: op, routineId: id, baseRevision, requestId: invocation(n) });
  return { ...f, id, authority, policy, approvals, execution, adapter, operation, repo: createBotRoutinesRepository(db),
    control: async (op: "pause" | "resume" | "archive", baseRevision = 1, n = 100) => f.execute(operation(op, baseRevision, n), adapter) };
}
/** Local DB fixture only: a canonical admitted run and its running fire/task, never a launched worker. */
export async function runningCanonicalFire(f: Awaited<ReturnType<typeof canonicalFixture>>) {
  await f.db.updateTable("bot_routines").set({ status: "active" }).where("routine_id", "=", f.id).execute();
  const fire = (await f.repo.claim({ ownerId: OWNER, routineId: f.id, scheduledFor: at(60000), nextFireAt: at(120000), now: at(60000) }))!;
  await f.repo.dispatch({ ownerId: OWNER, fireId: fire.fireId, now: at(60000) });
  const owner = { type: "personal" as const, ownerId: OWNER }, chatId = TARGET_A.chatId, record = (await f.chats.get(owner, chatId))!;
  const turnId = "cturn_control_fixture", runId = "run_control_fixture", messageId = "msg_control_fixture";
  await f.chats.admitTurn(owner, { chatId, baseRevision: record.chat.revision,
    message: { id: messageId, chatId, turnId, seq: record.chat.messageCount + 1, role: "user", state: "committed", parts: [{ type: "text", text: "Local control fixture" }], createdAt: NOW },
    turn: { id: turnId, chatId, clientRequestId: "req_routine_" + fire.fireId, baseMessageSeq: record.chat.messageCount,
      inputMessageId: messageId, status: "accepted", createdAt: NOW, updatedAt: NOW },
    run: { id: runId, chatId, turnId, attempt: 1, driverKind: "matrix_bot", instanceId: "matrix_bot_default",
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default", status: "accepted",
      historyBoundarySeq: record.chat.messageCount, createdAt: NOW, updatedAt: NOW,
      capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: true, userInput: true,
        resume: false, cancellation: true, worktrees: "none", interactionModes: ["default"], permissionModes: ["default"] } } });
  const tasks = createBotTasksRepository(f.db), task = (await tasks.get({ ownerId: OWNER, taskId: fire.taskId }))!;
  await tasks.transition({ ownerId: OWNER, taskId: fire.taskId, baseRevision: task.revision, to: "running", runId, now: NOW });
  return { fire, runId, tasks, revision: (await f.repo.get(OWNER, f.id))!.revision };
}
