import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createProjectChatAssignmentCoordinator } from "../../packages/gateway/src/collaboration/project-chat-assignment.js";
import type { OwnerCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createPrivateSlackThreadContext } from "../../packages/gateway/src/slack/private-thread-context.js";
import { createSlackMentionSummaries, SUMMARY_INSTRUCTION } from "../../packages/gateway/src/slack/mention-summary.js";
import { ChatConflictError } from "../../packages/gateway/src/chat/errors.js";
import { admitCanonicalRetry } from "../../packages/gateway/src/chat/retry-admission.js";
import { createBotStateDatabase, createRealBotStateDatabase, insertChat, NOW, OWNER } from "./bots/bot-state-support.js";

const owner = { type: "personal" as const, ownerId: OWNER };
const chatId = "chat_summary_boundary";
let requestId: string;
let summaries: Awaited<ReturnType<typeof createSlackMentionSummaries>>;
const selection = { instanceId: "matrix_bot_default", model: "auto" };
const snapshot = { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: false,
  userInput: false, resume: false, cancellation: true, steering: "same_run" as const, worktrees: "none" as const,
  interactionModes: ["default"], permissionModes: ["default"] };
let fixture: Awaited<ReturnType<typeof createBotStateDatabase>>;
let repository: ChatRepository;

beforeEach(async () => {
  fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase());
  repository = new ChatRepository(fixture.db);
  await insertChat(fixture.db, chatId);
  const botId = "bot_0123456789abcdef", runtimeId = "preview_boundary";
  await fixture.db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: botId, chat_id: chatId,
    kind: "direct", created_at: NOW, removed_at: null }).execute();
  summaries = await createSlackMentionSummaries({ db: fixture.db, ownerId: OWNER, runtimeId,
    authorize: async () => true, readThread: async () => null });
  const context = await createPrivateSlackThreadContext({ db: fixture.db, ownerId: OWNER, runtimeId,
    authorize: async () => true, onReceive: summaries.receive });
  // Use real source/job admission, rather than inventing a privileged request ID with no durable authority.
  expect(await context.receive({ ownerId: OWNER, chatId, botId, runtimeId, grantId: "a".repeat(64),
    summary: { ruleId: "owner-mentions", version: 1, proof: "b".repeat(64) },
    event: { appId: "A123", teamId: "T123", channelId: "C123", threadTs: "1795000000.000001",
      ts: "1795000001.000001", eventId: "EvBoundary", userId: "U456", text: "<@U123> review this change" },
  })).toBe(true);
  const jobs = await sql<{ request_id: string; policy: unknown; state: string }>`SELECT request_id,policy,state FROM slack_mention_summary_jobs`.execute(fixture.db);
  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0]).toMatchObject({ policy: null, state: "pending" });
  requestId = jobs.rows[0]!.request_id;
  // Seed the worker claim that precedes canonical admission; pending jobs cannot authorize publication.
  await sql`UPDATE slack_mention_summary_jobs SET state='processing',attempts=1,lease='boundary_fixture',
    lease_until=now()+interval '30 seconds' WHERE request_id=${requestId}`.execute(fixture.db);
});
afterEach(async () => { await summaries?.close(); await fixture.destroy(); });

async function admit(clientRequestId = "req_foreground") {
  const current = (await repository.get(owner, chatId))!.chat;
  await repository.admitTurn(owner, {
    chatId, baseRevision: current.revision,
    message: { id: "msg_boundary", chatId, turnId: "cturn_boundary", seq: current.messageCount + 1, role: "user",
      state: "committed", actorId: OWNER, parts: [{ type: "text", text: clientRequestId === requestId ? SUMMARY_INSTRUCTION : "Fixture request" }], createdAt: NOW },
    turn: { id: "cturn_boundary", chatId, clientRequestId, baseMessageSeq: current.messageCount, inputMessageId: "msg_boundary",
      status: "accepted", createdAt: NOW, updatedAt: NOW },
    run: { id: "run_boundary", chatId, turnId: "cturn_boundary", attempt: 1, driverKind: "matrix_bot",
      instanceId: selection.instanceId, selection, interactionMode: "default", permissionMode: "default", status: "accepted",
      historyBoundarySeq: current.messageCount, capabilitySnapshot: snapshot, createdAt: NOW, updatedAt: NOW },
  });
}

async function enqueue() {
  await admit();
  return repository.enqueueQueuedTurn(owner, {
    chatId, baseRevision: (await repository.get(owner, chatId))!.chat.revision,
    queuedTurnId: "qturn_summary_boundary", clientRequestId: requestId,
    parts: [{ type: "text", text: SUMMARY_INSTRUCTION }], driverKind: "matrix_bot", selection,
    interactionMode: "default", permissionMode: "default", createdAt: NOW, capabilitySnapshot: snapshot,
  });
}

async function steeringInput() {
  await enqueue();
  return { chatId, runId: "run_boundary", expectedTurnId: "cturn_boundary", queuedTurnId: "qturn_summary_boundary",
    clientRequestId: "req_steer_summary", steerId: "steer_summary_boundary", messageId: "msg_steered_summary",
    baseRevision: (await repository.get(owner, chatId))!.chat.revision, createdAt: NOW };
}

it("denies a public retry before catalog or provider work using the original summary Turn identity", async () => {
  await admit(requestId);
  await repository.finishRun(owner, { chatId, runId: "run_boundary", outcome: "failed", completedAt: NOW });
  // Legacy retry rows can already have a new request ID while retaining the original source Turn.
  await fixture.db.updateTable("chat_runs").set({ client_request_id: "req_legacy_retry" }).where("id", "=", "run_boundary").execute();
  const getCatalog = vi.fn(async () => { throw new Error("Unexpected provider catalog access"); });
  const getTurnRunContext = repository.getTurnRunContext.bind(repository);
  await expect(admitCanonicalRetry({ repository: { findRetryAdmission: async () => null, getTurnRunContext },
    assertOpen() {}, assertPersonalExecutionAllowed: async () => {}, reconcileActiveRuns: async () => {},
    hasStoppingExecution: () => false, catalog: { getCatalog },
  } as unknown as Parameters<typeof admitCanonicalRetry>[0], { userId: OWNER, source: "jwt" }, owner, chatId, "cturn_boundary", {
    clientRequestId: "req_new_public_retry", baseRevision: (await repository.get(owner, chatId))!.chat.revision,
  })).rejects.toMatchObject({ status: 409 });
  expect(getCatalog).not.toHaveBeenCalled();
  expect(await fixture.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(1);
});

it("keeps an automatic summary queued instead of steering it into an ordinary tool-enabled Run", async () => {
  const input = await steeringInput();
  await expect(repository.beginQueuedTurnSteer(owner, input)).rejects.toBeInstanceOf(ChatConflictError);
  expect(await fixture.db.selectFrom("chat_run_steers").select("id").execute()).toHaveLength(0);
  expect((await fixture.db.selectFrom("chat_queued_turns").select("status").executeTakeFirstOrThrow()).status).toBe("queued");
});

it("refuses a historical summary steer acknowledgement while preserving failure cleanup", async () => {
  const input = await steeringInput();
  await fixture.db.insertInto("chat_run_steers").values({ id: input.steerId, chat_id: chatId, run_id: input.runId,
    turn_id: input.expectedTurnId, client_request_id: input.clientRequestId, message_id: input.messageId,
    queued_turn_id: input.queuedTurnId, parts: JSON.stringify([{ type: "text", text: SUMMARY_INSTRUCTION }]),
    status: "pending", created_at: NOW, updated_at: NOW }).execute();
  await expect(repository.beginQueuedTurnSteer(owner, input)).rejects.toBeInstanceOf(ChatConflictError);
  await expect(repository.acceptQueuedTurnSteer(owner, { ...input, acceptedAt: NOW })).rejects.toBeInstanceOf(ChatConflictError);
  await repository.failQueuedTurnSteer(owner, { ...input, acceptedAt: NOW });
  expect((await fixture.db.selectFrom("chat_queued_turns").select("status").executeTakeFirstOrThrow()).status).toBe("queued");
  expect(await fixture.db.selectFrom("chat_messages").select("id").where("id", "=", input.messageId).execute()).toHaveLength(0);
});

it("denies replacing the fixed queued summary instruction", async () => {
  await enqueue();
  await expect(repository.updateQueuedTurn(owner, { chatId, queuedTurnId: "qturn_summary_boundary", clientRequestId: "req_edit_summary",
    baseRevision: (await repository.get(owner, chatId))!.chat.revision,
    parts: [{ type: "text", text: "Run a different task" }], updatedAt: NOW,
  })).rejects.toBeInstanceOf(ChatConflictError);
  expect((await fixture.db.selectFrom("chat_queued_turns").select("parts").executeTakeFirstOrThrow()).parts)
    .toEqual([{ type: "text", text: SUMMARY_INSTRUCTION }]);
});

it("cancels a summary queue after historical publication before committing its input", async () => {
  await enqueue();
  await repository.finishRun(owner, { chatId, runId: "run_boundary", outcome: "completed", completedAt: NOW });
  await sql`INSERT INTO collaboration_scopes
    (id,owner_type,owner_id,kind,resource_id,membership_mode,lifecycle,revision,auth_epoch,authority_runtime_id,authority_generation,created_at,updated_at)
    VALUES ('20000000-0000-4000-8000-000000000b93','personal',${OWNER},'chat',${chatId},'direct','shared',1,1,'vps:boundary',1,${NOW},${NOW})`.execute(fixture.db);
  const before = await fixture.db.selectFrom("chat_messages").select("id").execute();
  await expect(repository.claimNextQueuedTurn(owner, { chatId, runId: "run_queued_summary", turnId: "cturn_queued_summary",
    messageId: "msg_queued_summary", claimedAt: NOW })).resolves.toBeNull();
  expect((await fixture.db.selectFrom("chat_queued_turns").select("status").executeTakeFirstOrThrow()).status).toBe("cancelled");
  expect(await fixture.db.selectFrom("chat_messages").select("id").execute()).toEqual(before);
});

async function historicalScope(lifecycle: string) {
  await sql`INSERT INTO collaboration_scopes
    (id,owner_type,owner_id,kind,resource_id,membership_mode,lifecycle,revision,auth_epoch,authority_runtime_id,authority_generation,created_at,updated_at)
    VALUES ('20000000-0000-4000-8000-000000000b93','personal',${OWNER},'chat',${chatId},'direct',${lifecycle},1,1,'vps:boundary',1,${NOW},${NOW})`.execute(fixture.db);
}

it.each(["shared", "archived", "deleted", "recovering"])("blocks late summary output after historical %s publication under the canonical Chat lock", async lifecycle => {
  await admit(requestId);
  // Turn identity survives a historical retry that replaced the Run request ID.
  await fixture.db.updateTable("chat_runs").set({ client_request_id: "req_legacy_retry" }).where("id", "=", "run_boundary").execute();
  await historicalScope(lifecycle);
  await expect(repository.appendAssistantDelta(owner, { chatId, runId: "run_boundary", messageId: "msg_private_summary",
    delta: "Private Slack summary", createdAt: NOW })).rejects.toBeInstanceOf(ChatConflictError);
  expect(await fixture.db.selectFrom("chat_messages").select("id").where("role", "=", "assistant").execute()).toHaveLength(0);
  await expect(repository.finishRun(owner, { chatId, runId: "run_boundary", outcome: "failed", completedAt: NOW }))
    .resolves.toMatchObject({ transitioned: true });
});

it("denies original summary admission into a previously published Chat", async () => {
  await historicalScope("shared");
  await expect(admit(requestId)).rejects.toBeInstanceOf(ChatConflictError);
  expect(await fixture.db.selectFrom("chat_messages").select("id").execute()).toHaveLength(0);
});

it("retains ordinary manual output behavior in a historical shared Chat", async () => {
  await admit();
  await historicalScope("shared");
  await expect(repository.appendAssistantDelta(owner, { chatId, runId: "run_boundary", messageId: "msg_ordinary_output",
    delta: "Ordinary manual output", createdAt: NOW })).resolves.toMatchObject({ id: "msg_ordinary_output" });
});

async function shareThroughProject() {
  const projectId = "project_summary_scope";
  await sql`INSERT INTO collaboration_scopes
    (id,owner_type,owner_id,organization_id,kind,resource_id,membership_mode,lifecycle,revision,auth_epoch,authority_runtime_id,authority_generation,created_at,updated_at)
    VALUES ('10000000-0000-4000-8000-000000000b93','personal',${OWNER},'org_scope_test','project',${projectId},'direct','shared',1,1,'vps:boundary',1,${NOW},${NOW})`.execute(fixture.db);
  const baseRevision = (await repository.get(owner, chatId))!.chat.revision;
  return createProjectChatAssignmentCoordinator({ db: fixture.db as unknown as Kysely<OwnerCollaborationDatabase>, chatRepository: repository })
    .run(owner, tx => tx.update(owner, chatId, { projectId, baseRevision }));
}
it.each(["running", "queued"])("denies real Project publication while a private summary is %s", async mode => {
  if (mode === "running") await admit(requestId);
  else {
    await enqueue();
    await repository.finishRun(owner, { chatId, runId: "run_boundary", outcome: "completed", completedAt: NOW });
  }
  await expect(shareThroughProject()).rejects.toThrow();
  expect((await fixture.db.selectFrom("chats").select("project_id").where("id", "=", chatId).executeTakeFirstOrThrow()).project_id).toBeNull();
  expect(await fixture.db.selectFrom("collaboration_scopes").select("id").where("kind", "=", "chat").where("resource_id", "=", chatId).execute()).toHaveLength(0);
});
