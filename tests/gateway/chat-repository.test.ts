import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import type {
  CanonicalChatMessage,
  CanonicalChatRecord,
  CanonicalChatRun,
  CanonicalChatRunActivity,
  CanonicalChatTurn,
} from "@matrix-os/contracts";
import {
  ChatBusyError,
  ChatConflictError,
  ChatNotFoundError,
  ChatRepository,
  ChatRunNotActiveError,
} from "../../packages/gateway/src/chat/repository.js";
import type { ChatOutboxEvent, ChatOwner } from "../../packages/gateway/src/chat/records.js";

const owner = { type: "personal" as const, ownerId: "user_a" };
const otherOwner = { type: "personal" as const, ownerId: "user_b" };
const now = "2026-08-25T00:00:00.000Z";

function selection(instanceId = "codex_default") {
  return { instanceId, model: "gpt-5.6-sol" };
}

function message(chatId: string, seq = 1): CanonicalChatMessage {
  return {
    id: `msg_${chatId}_${seq}`,
    chatId,
    seq,
    role: "user",
    state: "committed",
    turnId: `cturn_${chatId}_${seq}`,
    parts: [{ type: "text", text: `message ${seq}` }],
    createdAt: now,
  };
}

function turn(chatId: string, input: CanonicalChatMessage, request = "req_turn_1"): CanonicalChatTurn {
  return {
    id: `cturn_${chatId}_${input.seq}`,
    chatId,
    clientRequestId: request,
    baseMessageSeq: input.seq - 1,
    inputMessageId: input.id,
    status: "accepted",
    createdAt: now,
    updatedAt: now,
  };
}

function run(chatId: string, inputTurn: CanonicalChatTurn, attempt = 1): CanonicalChatRun {
  return {
    id: `run_${chatId}_${attempt}`,
    chatId,
    turnId: inputTurn.id,
    attempt,
    driverKind: "codex",
    instanceId: "codex_default",
    selection: selection(),
    interactionMode: "default",
    permissionMode: "supervised",
    status: "accepted",
    historyBoundarySeq: inputTurn.baseMessageSeq,
    capabilitySnapshot: {
      revision: "catalog_1",
      rootChat: true,
      attachments: ["file"],
      resources: ["file", "folder", "project"],
      tools: ["read", "write"],
      approvals: true,
      userInput: true,
      resume: true,
      cancellation: true,
      steering: "same_run",
      worktrees: "optional",
      interactionModes: ["default"],
      permissionModes: ["supervised"],
    },
    createdAt: now,
    updatedAt: now,
  };
}

function activity(chatId: string, runId: string, index: number): CanonicalChatRunActivity {
  return {
    id: `activity_${index}`,
    chatId,
    runId,
    occurredAt: now,
    type: "run.status",
    status: "running",
  };
}

function terminalBinding(
  chatId: string,
  runId: string,
  id: string,
  terminalSessionId: string,
): CanonicalChatRunActivity {
  return {
    id,
    chatId,
    runId,
    occurredAt: now,
    type: "terminal.bound",
    terminalSessionId,
    terminalSessionCreatedAt: now,
  };
}

function createChat(repository: ChatRepository, suffix: string, creationOwner = owner) {
  return repository.create(creationOwner, {
    id: `chat_${suffix}`, clientRequestId: `req_${suffix}`, title: suffix,
  });
}

async function admitChat(repository: ChatRepository, suffix: string) {
  const created = await createChat(repository, suffix);
  const input = message(created.chat.id);
  const acceptedTurn = turn(created.chat.id, input, `req_turn_${suffix}`);
  const acceptedRun = run(created.chat.id, acceptedTurn);
  await repository.admitTurn(owner, {
    chatId: created.chat.id,
    baseRevision: created.chat.revision,
    message: input,
    turn: acceptedTurn,
    run: acceptedRun,
  });
  return { chatId: created.chat.id, runId: acceptedRun.id, turn: acceptedTurn, run: acceptedRun };
}

type AdmittedChat = Awaited<ReturnType<typeof admitChat>>;
type ActivityInput = CanonicalChatRunActivity extends infer Activity
  ? Activity extends CanonicalChatRunActivity
    ? Omit<Activity, "chatId" | "runId">
    : never
  : never;

function finishChat(
  repository: ChatRepository,
  admitted: Pick<AdmittedChat, "chatId" | "runId">,
  outcome: "completed" | "failed" | "aborted",
  completedAt: string,
) {
  return repository.finishRun(owner, { ...admitted, outcome, completedAt });
}

function appendActivity(
  repository: ChatRepository,
  admitted: Pick<AdmittedChat, "chatId" | "runId">,
  activity: ActivityInput,
) {
  return repository.appendRunActivities(owner, admitted.chatId, admitted.runId, [{
    ...activity,
    chatId: admitted.chatId,
    runId: admitted.runId,
  } as CanonicalChatRunActivity]);
}

async function retryAndFinish(
  repository: ChatRepository,
  admitted: AdmittedChat,
  suffix: string,
  completedAt: string,
) {
  const current = await repository.get(owner, admitted.chatId);
  expect(current).not.toBeNull();
  const retry = run(admitted.chatId, admitted.turn, 2);
  await repository.admitRetry(owner, {
    chatId: admitted.chatId,
    turnId: admitted.turn.id,
    clientRequestId: `req_retry_${suffix}`,
    baseRevision: current!.chat.revision,
    run: retry,
  });
  await finishChat(repository, { chatId: admitted.chatId, runId: retry.id }, "completed", completedAt);
  return retry;
}

describe("ChatRepository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.kysely.destroy();
  });

  it("bootstraps every canonical Chat table and index idempotently", async () => {
    await repository.bootstrap();
    const tables = await repository.kysely
      .selectFrom("information_schema.tables")
      .select("table_name")
      .where("table_schema", "=", "public")
      .where("table_name", "like", "chat%")
      .execute();

    expect(tables.map((row) => row.table_name).sort()).toEqual([
      "chat_attachments",
      "chat_deletions",
      "chat_legacy_imports",
      "chat_members",
      "chat_messages",
      "chat_migrations",
      "chat_outbox",
      "chat_queued_turns",
      "chat_run_adapter_state",
      "chat_run_events",
      "chat_run_steers",
      "chat_runs",
      "chat_terminal_bindings",
      "chat_turns",
      "chat_user_state",
      "chats",
    ]);
    const activityIndex = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_chat_run_events_run_occurred'
    `.execute(repository.kysely);
    expect(activityIndex.rows).toEqual([{ indexname: "idx_chat_run_events_run_occurred" }]);
    const sequenceIndex = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_chat_run_events_run_sequence'
    `.execute(repository.kysely);
    expect(sequenceIndex.rows).toEqual([
      expect.objectContaining({ indexdef: expect.stringMatching(/UNIQUE INDEX.*run_id.*run_seq/i) }),
    ]);
  });

  it("creates idempotently, isolates owners, and commits the outbox atomically", async () => {
    const first = await repository.create(owner, {
      id: "chat_owner_a",
      clientRequestId: "req_create_owner_a",
      title: "Canonical backend",
      projectId: "project_matrix",
      currentSelection: selection(),
    });
    const repeated = await repository.create(owner, {
      id: "chat_ignored_duplicate",
      clientRequestId: "req_create_owner_a",
      title: "Ignored duplicate",
    });

    expect(repeated.chat.id).toBe(first.chat.id);
    expect(await repository.get(otherOwner, first.chat.id)).toBeNull();
    expect((await repository.list(owner, { limit: 101 })).items).toHaveLength(1);
    await expect(repository.replayOutbox(otherOwner, { afterCursor: 0, limit: 10 })).resolves.toEqual([]);
    await expect(repository.replayOutbox(owner, { afterCursor: 0, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ chatId: first.chat.id, eventType: "chat.created", revision: 0 }),
    ]);

    await expect(repository.withTransaction(async (tx) => {
      await tx.create(owner, {
        id: "chat_rolled_back",
        clientRequestId: "req_create_rolled_back",
        title: "Rollback",
      });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await repository.get(owner, "chat_rolled_back")).toBeNull();
  });

  it("notifies the single bounded outbox sink only after commit and never after rollback", async () => {
    const delivered: Array<{ owner: ChatOwner; event: ChatOutboxEvent }> = [];
    const events = repository;
    const registration = events.registerOutboxSink((event) => delivered.push(event));

    await createChat(repository, "sink_committed");
    expect(delivered).toEqual([
      expect.objectContaining({
        owner,
        event: expect.objectContaining({
          chatId: "chat_sink_committed",
          eventType: "chat.created",
        }),
      }),
    ]);

    let deliveredBeforeOuterCommit = -1;
    await repository.withTransaction(async (transaction) => {
      await createChat(transaction, "sink_outer_transaction");
      deliveredBeforeOuterCommit = delivered.length;
    });
    expect(deliveredBeforeOuterCommit).toBe(1);
    expect(delivered.at(-1)).toEqual(expect.objectContaining({
      owner,
      event: expect.objectContaining({ chatId: "chat_sink_outer_transaction" }),
    }));

    await expect(repository.withTransaction(async (transaction) => {
      await createChat(transaction, "sink_rolled_back");
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");
    expect(delivered).toHaveLength(2);

    expect(() => events.registerOutboxSink(() => undefined))
      .toThrow(/sink|registered/i);
    registration.dispose();
    const replacement = events.registerOutboxSink(() => undefined);
    replacement.dispose();
  });

  it("drains the registered outbox sink before repository release", async () => {
    const events = repository;
    const delivered: ChatOutboxEvent[] = [];
    events.registerOutboxSink(({ event }) => delivered.push(event));

    await repository.release();
    await createChat(repository, "after_repository_release");

    expect(delivered).toEqual([]);
  });

  it("fails closed and rolls back when one transaction exceeds the pending outbox cap", async () => {
    const delivered: ChatOutboxEvent[] = [];
    repository.registerOutboxSink(({ event }) => delivered.push(event));

    await expect(repository.withTransaction(async (transaction) => {
      for (let index = 0; index <= 100; index += 1) {
        await createChat(transaction, `pending_cap_${index}`);
      }
    })).rejects.toThrow(/outbox limit/i);

    expect(delivered).toEqual([]);
    expect((await repository.list(owner, { limit: 100 })).items).toEqual([]);
  });

  it("replays an owner-isolated bounded monotonic window and reports a pruned cursor gap", async () => {
    const events = repository;
    await createChat(repository, "replay_first");
    await createChat(repository, "replay_other_owner", otherOwner);
    await createChat(repository, "replay_second");

    const firstWindow = await events.replayOutboxWindow(owner, { limit: 1 });
    expect(firstWindow).toMatchObject({ gap: false });
    expect(firstWindow.events).toHaveLength(1);
    expect(firstWindow.events[0]?.chatId).toBe("chat_replay_first");
    expect(firstWindow.nextCursor).toBe(firstWindow.events[0]?.cursor);

    const remaining = await events.replayOutboxWindow(owner, {
      afterCursor: firstWindow.nextCursor,
      limit: 1000,
    });
    expect(remaining.gap).toBe(false);
    expect(remaining.events.map((event) => event.chatId)).toEqual(["chat_replay_second"]);
    expect(remaining.events.map((event) => event.cursor))
      .toEqual([...remaining.events.map((event) => event.cursor)].sort((a, b) => a - b));
    expect(remaining.events).toHaveLength(1);

    await repository.pruneOutbox(owner, remaining.events[0]!.cursor + 1, 100);
    await createChat(repository, "replay_after_prune");
    const gap = await events.replayOutboxWindow(owner, {
      afterCursor: firstWindow.nextCursor,
      limit: 10,
    });
    expect(gap.gap).toBe(true);
    expect(gap.events).toEqual([]);
  });

  it("caps one replay window even when the caller requests an oversized page", async () => {
    const events = repository;
    await createChat(repository, "replay_cap");
    await repository.kysely.insertInto("chat_outbox").values(
      Array.from({ length: 105 }, (_, index) => ({
        owner_type: owner.type,
        owner_id: owner.ownerId,
        chat_id: "chat_replay_cap",
        revision: index + 1,
        event_type: "chat.updated" as const,
        payload: {},
      })),
    ).execute();

    const window = await events.replayOutboxWindow(owner, { limit: 10_000 });

    expect(window.gap).toBe(false);
    expect(window.events).toHaveLength(100);
    expect(window.nextCursor).toBe(window.events.at(-1)?.cursor);
  });

  it("hydrates and updates owner-local Chat pin state atomically", async () => {
    const created = await repository.create(owner, {
      id: "chat_pinned",
      clientRequestId: "req_create_pinned",
      title: "Pinned Chat",
    });

    expect(created.chat.userState).toEqual({ readThroughSeq: 0, pinned: false, muted: false });
    await expect(repository.updateUserState(otherOwner, created.chat.id, { pinned: true }))
      .rejects.toBeInstanceOf(ChatNotFoundError);

    const pinned = await repository.updateUserState(owner, created.chat.id, { pinned: true });
    expect(pinned.chat.userState).toEqual({ readThroughSeq: 0, pinned: true, muted: false });
    expect((await repository.list(owner, { limit: 10 })).items[0]?.chat.userState?.pinned).toBe(true);
    expect((await repository.get(owner, created.chat.id))?.chat.userState?.pinned).toBe(true);

    const preservedUpdatedAt = "2026-08-24T00:00:00.000Z";
    await sql`
      UPDATE chat_user_state SET updated_at = ${preservedUpdatedAt}
      WHERE chat_id = ${created.chat.id} AND principal_id = ${owner.ownerId}
    `.execute(repository.kysely);

    const repeated = await repository.updateUserState(owner, created.chat.id, { pinned: true });
    const stateAfterUnchangedRequest = await repository.kysely.selectFrom("chat_user_state")
      .select("updated_at")
      .where("chat_id", "=", created.chat.id)
      .where("principal_id", "=", owner.ownerId)
      .executeTakeFirstOrThrow();

    expect(repeated.chat.userState).toEqual({ readThroughSeq: 0, pinned: true, muted: false });
    expect(new Date(stateAfterUnchangedRequest.updated_at).toISOString()).toBe(preservedUpdatedAt);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 10 })).toEqual([
      expect.objectContaining({ eventType: "chat.created" }),
      expect.objectContaining({
        eventType: "chat.user_state_updated",
        payload: { pinned: true },
      }),
    ]);
  });

  it("projects accepted, running, approval, and input Run states in fresh list and detail snapshots", async () => {
    const accepted = await admitChat(repository, "rail_accepted");
    const running = await admitChat(repository, "rail_running");
    const approval = await admitChat(repository, "rail_approval");
    const inputRequired = await admitChat(repository, "rail_input");

    for (const state of [running, approval, inputRequired]) {
      await repository.markRunRunning(owner, {
        chatId: state.chatId,
        runId: state.runId,
        startedAt: "2026-08-25T00:00:30.000Z",
      });
    }
    await appendActivity(repository, approval, {
      id: "activity_rail_approval",
      occurredAt: "2026-08-25T00:00:40.000Z",
      type: "approval.requested",
      approvalId: "approval_rail_exact",
      title: "Allow the command",
      risk: "medium",
      allowedDecisions: ["approve", "approve_for_session", "decline"],
    });
    await appendActivity(repository, inputRequired, {
      id: "activity_rail_input",
      occurredAt: "2026-08-25T00:00:50.000Z",
      type: "input.requested",
      requestId: "input_rail_exact",
      title: "Choose an option",
    });

    const list = await repository.list(owner, { limit: 100 });
    const byId = new Map(list.items.map((record) => [record.chat.id, record]));
    for (const [state, attention, status] of [
      [accepted, "none", "accepted"],
      [running, "none", "running"],
      [approval, "approval_required", "waiting_for_approval"],
      [inputRequired, "input_required", "waiting_for_input"],
    ] as const) expect(byId.get(state.chatId)).toMatchObject({
      chat: { attention }, activeRun: { runId: state.runId, status },
    });

    for (const expected of [accepted, running, approval, inputRequired]) {
      const detail = await repository.getDetailPage(owner, expected.chatId, { limit: 200 });
      expect(detail?.record).toEqual(byId.get(expected.chatId));
    }
  });

  it("projects each newly persisted approval and input transition once with one refresh signal", async () => {
    const admitted = await admitChat(repository, "rail_activity_transitions");
    await repository.markRunRunning(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      startedAt: "2026-08-25T00:00:30.000Z",
    });
    const approvalRequested: ActivityInput = {
      id: "activity_rail_transition_approval_requested",
      occurredAt: "2026-08-25T00:00:40.000Z",
      type: "approval.requested",
      approvalId: "approval_rail_transition",
      title: "Allow the command",
      risk: "medium",
      allowedDecisions: ["approve", "approve_for_session", "decline"],
    };

    await expect(appendActivity(repository, admitted, approvalRequested)).resolves.toBe(1);
    const afterApproval = await repository.get(owner, admitted.chatId);
    expect(afterApproval).toMatchObject({
      chat: { attention: "approval_required", revision: 2 },
      activeRun: { status: "waiting_for_approval" },
    });
    const outboxAfterApproval = await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 });

    await expect(appendActivity(repository, admitted, approvalRequested)).resolves.toBe(0);
    expect(await repository.get(owner, admitted.chatId)).toEqual(afterApproval);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 }))
      .toEqual(outboxAfterApproval);

    const transitions: Array<[ActivityInput, string, string, number]> = [
      [{ id: "activity_rail_transition_approval_resolved", occurredAt: "2026-08-25T00:00:50.000Z", type: "approval.resolved", approvalId: "approval_rail_transition", decision: "approve" }, "none", "running", 3],
      [{ id: "activity_rail_transition_input_requested", occurredAt: "2026-08-25T00:01:00.000Z", type: "input.requested", requestId: "input_rail_transition", title: "Choose an option" }, "input_required", "waiting_for_input", 4],
      [{ id: "activity_rail_transition_input_resolved", occurredAt: "2026-08-25T00:01:10.000Z", type: "input.resolved", requestId: "input_rail_transition" }, "none", "running", 5],
    ];
    for (const [activity, attention, status, revision] of transitions) {
      await appendActivity(repository, admitted, activity);
      expect(await repository.get(owner, admitted.chatId)).toMatchObject({
        chat: { attention, revision }, activeRun: { status },
      });
    }
    const afterInput = await repository.get(owner, admitted.chatId);
    expect(afterInput).toMatchObject({ chat: { attention: "none", revision: 5 } });
    const transitionEvents = (await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 }))
      .filter((event) => event.eventType === "run.activity");
    expect(transitionEvents).toHaveLength(4);
    expect(transitionEvents.map((event) => event.revision)).toEqual([2, 3, 4, 5]);
  });

  it("projects failed and exact successful completion state without treating aborted or idle as complete", async () => {
    const failed = await admitChat(repository, "rail_terminal_failed");
    const unseen = await admitChat(repository, "rail_terminal_unseen");
    const acknowledged = await admitChat(repository, "rail_terminal_acknowledged");
    const aborted = await admitChat(repository, "rail_terminal_aborted");
    const idle = await createChat(repository, "rail_terminal_idle");
    const completedAt = "2026-08-25T00:01:00.000Z";

    await finishChat(repository, failed, "failed", completedAt);
    await finishChat(repository, unseen, "completed", completedAt);
    await repository.acknowledgeCompletion(owner, unseen.chatId, unseen.runId);
    const latestCompletedAt = "2026-08-25T00:02:00.000Z";
    const latestUnseenRun = await retryAndFinish(repository, unseen, "rail_terminal_unseen", latestCompletedAt);
    await finishChat(repository, acknowledged, "completed", completedAt);
    await repository.acknowledgeCompletion(owner, acknowledged.chatId, acknowledged.runId);
    await finishChat(repository, aborted, "aborted", completedAt);

    const list = await repository.list(owner, { limit: 100 });
    const byId = new Map(list.items.map((record) => [record.chat.id, record]));
    expect(byId.get(failed.chatId)).toMatchObject({ chat: { attention: "failed" } });
    expect(byId.get(unseen.chatId)).toMatchObject({
      chat: { attention: "none" },
      latestSuccessfulCompletion: {
        runId: latestUnseenRun.id,
        completedAt: latestCompletedAt,
        unacknowledged: true,
      },
    });
    expect(byId.get(acknowledged.chatId)).toMatchObject({
      chat: { attention: "none" },
      latestSuccessfulCompletion: {
        runId: acknowledged.runId,
        completedAt,
        unacknowledged: false,
      },
    });
    expect(byId.get(aborted.chatId)).not.toHaveProperty("latestSuccessfulCompletion");
    expect(byId.get(idle.chat.id)).not.toHaveProperty("latestSuccessfulCompletion");

    for (const expected of [failed, unseen, acknowledged, aborted, { chatId: idle.chat.id }]) {
      const detail = await repository.getDetailPage(owner, expected.chatId, { limit: 200 });
      expect(detail?.record).toEqual(byId.get(expected.chatId));
    }
  });

  it("acknowledges only an owned exact successful completed Run and rejects every other Run state", async () => {
    const completed = await admitChat(repository, "ack_validation_completed");
    const wrongChat = await createChat(repository, "ack_validation_wrong_chat");
    const active = await admitChat(repository, "ack_validation_active");
    const failed = await admitChat(repository, "ack_validation_failed");
    const aborted = await admitChat(repository, "ack_validation_aborted");
    const completedAt = "2026-08-25T00:03:00.000Z";
    await finishChat(repository, completed, "completed", completedAt);
    await finishChat(repository, failed, "failed", completedAt);
    await finishChat(repository, aborted, "aborted", completedAt);

    await expect(repository.acknowledgeCompletion(otherOwner, completed.chatId, completed.runId))
      .rejects.toBeInstanceOf(ChatNotFoundError);
    await expect(repository.acknowledgeCompletion(owner, wrongChat.chat.id, completed.runId))
      .rejects.toBeInstanceOf(ChatNotFoundError);
    for (const candidate of [active, failed, aborted]) {
      await expect(repository.acknowledgeCompletion(owner, candidate.chatId, candidate.runId))
        .rejects.toThrow();
    }

    await expect(repository.acknowledgeCompletion(owner, completed.chatId, completed.runId))
      .resolves.toMatchObject({
        latestSuccessfulCompletion: {
          runId: completed.runId,
          completedAt,
          unacknowledged: false,
        },
      });
  });

  it("stores exact completion time monotonically and emits one refresh only when acknowledgement advances", async () => {
    const admitted = await admitChat(repository, "ack_monotonic");
    const { chatId, run: firstRun } = admitted;
    const firstCompletedAt = "2026-08-25T00:01:00.000Z";
    await finishChat(repository, admitted, "completed", firstCompletedAt);

    await repository.acknowledgeCompletion(owner, chatId, firstRun.id);
    const afterFirstAck = await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 });
    await repository.acknowledgeCompletion(owner, chatId, firstRun.id);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 })).toEqual(afterFirstAck);

    const secondCompletedAt = "2026-08-25T00:02:00.000Z";
    const secondRun = await retryAndFinish(repository, admitted, "ack_monotonic", secondCompletedAt);
    await repository.acknowledgeCompletion(owner, chatId, secondRun.id);
    const afterSecondAck = await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 });
    await repository.acknowledgeCompletion(owner, chatId, firstRun.id);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 })).toEqual(afterSecondAck);

    const userState = await repository.kysely.selectFrom("chat_user_state")
      .select("attention_acknowledged_at")
      .where("chat_id", "=", chatId)
      .where("principal_id", "=", owner.ownerId)
      .executeTakeFirstOrThrow();
    expect(new Date(userState.attention_acknowledged_at!).toISOString()).toBe(secondCompletedAt);
    expect(afterSecondAck.filter((event) => (
      event.chatId === chatId && event.eventType === "chat.user_state_updated"
    ))).toEqual([
      expect.objectContaining({ payload: { runId: firstRun.id, completedAt: firstCompletedAt } }),
      expect.objectContaining({ payload: { runId: secondRun.id, completedAt: secondCompletedAt } }),
    ]);
  });

  it("keeps a newer successful completion unacknowledged across both old-ack interleavings", async () => {
    const exercise = async (suffix: string, acknowledgeOldBeforeNewCompletion: boolean) => {
      const admitted = await admitChat(repository, `ack_race_${suffix}`);
      const { chatId, run: firstRun } = admitted;
      await finishChat(repository, admitted, "completed", "2026-08-25T00:01:00.000Z");
      if (acknowledgeOldBeforeNewCompletion) {
        await repository.acknowledgeCompletion(owner, chatId, firstRun.id);
      }
      const latestCompletedAt = "2026-08-25T00:02:00.000Z";
      const secondRun = await retryAndFinish(repository, admitted, `ack_race_${suffix}`, latestCompletedAt);
      if (!acknowledgeOldBeforeNewCompletion) {
        await repository.acknowledgeCompletion(owner, chatId, firstRun.id);
      }
      expect(await repository.get(owner, chatId)).toMatchObject({
        latestSuccessfulCompletion: {
          runId: secondRun.id,
          completedAt: latestCompletedAt,
          unacknowledged: true,
        },
      });
    };

    await exercise("ack_then_complete", true);
    await exercise("complete_then_ack", false);
  });

  it("keeps legacy terminal events visible without treating them as attachable incarnations", async () => {
    const created = await repository.create(owner, {
      id: "chat_terminal_owner",
      clientRequestId: "req_terminal_owner",
      title: "Terminal owner",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input, "req_terminal_turn");
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: created.chat.revision,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
    });
    await repository.appendRunActivities(owner, created.chat.id, acceptedRun.id, [
      terminalBinding(created.chat.id, acceptedRun.id, "activity_terminal", "terminal_bound"),
    ]);
    await repository.kysely.insertInto("chat_run_events").values({
      id: "activity_terminal_decoy",
      chat_id: created.chat.id,
      run_id: acceptedRun.id,
      event: {
        id: "activity_terminal_decoy",
        chatId: created.chat.id,
        runId: acceptedRun.id,
        occurredAt: now,
        type: "run.status",
        status: "running",
        terminalSessionId: "terminal_decoy",
      },
      occurred_at: now,
    }).execute();
    await repository.kysely.deleteFrom("chat_terminal_bindings")
      .where("chat_id", "=", created.chat.id)
      .where("session_id", "=", "terminal_bound")
      .execute();

    await expect(repository.getTerminalBinding(owner, created.chat.id, "terminal_bound")).resolves.toBeNull();
    await expect(repository.getTerminalBinding(owner, created.chat.id, "terminal_decoy")).resolves.toBeNull();
    await expect(repository.getTerminalBinding(owner, created.chat.id, "terminal_wrong")).resolves.toBeNull();
    await expect(repository.getTerminalBinding(otherOwner, created.chat.id, "terminal_bound")).resolves.toBeNull();
    await expect(repository.getTerminalBinding(owner, "chat_missing", "terminal_bound")).resolves.toBeNull();
    await expect(repository.listBoundTerminalSessionIds(owner, ["terminal_bound", "terminal_decoy", "terminal_manual"]))
      .resolves.toEqual(["terminal_bound"]);
    await expect(repository.listBoundTerminalSessionIds(otherOwner, ["terminal_bound"]))
      .resolves.toEqual([]);
  });

  it("keeps a persisted pin in an updateProject response", async () => {
    const created = await repository.create(owner, {
      id: "chat_pinned_update_project",
      clientRequestId: "req_create_pinned_update_project",
      title: "Pinned Project",
    });
    await repository.updateUserState(owner, created.chat.id, { pinned: true });

    const updated = await repository.update(owner, created.chat.id, {
      baseRevision: created.chat.revision,
      projectId: "project_pinned",
    });

    expect(updated.chat.userState).toEqual({ readThroughSeq: 0, pinned: true, muted: false });
  });

  it("keeps a persisted pin in a Turn admission response", async () => {
    const created = await repository.create(owner, {
      id: "chat_pinned_admit_turn",
      clientRequestId: "req_create_pinned_admit_turn",
      title: "Pinned Turn",
    });
    await repository.updateUserState(owner, created.chat.id, { pinned: true });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);

    const admitted = await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: created.chat.revision,
      message: input,
      turn: acceptedTurn,
      run: run(created.chat.id, acceptedTurn),
    });

    expect(admitted.chat.chat.userState).toEqual({ readThroughSeq: 0, pinned: true, muted: false });
  });

  it("keeps a persisted pin in new and repeated retry admission responses", async () => {
    const created = await repository.create(owner, {
      id: "chat_pinned_admit_retry",
      clientRequestId: "req_create_pinned_admit_retry",
      title: "Pinned Retry",
    });
    await repository.updateUserState(owner, created.chat.id, { pinned: true });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const firstRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: created.chat.revision,
      message: input,
      turn: acceptedTurn,
      run: firstRun,
    });
    await repository.finishRun(owner, {
      chatId: created.chat.id,
      runId: firstRun.id,
      outcome: "failed",
      completedAt: "2026-08-25T00:01:00.000Z",
    });
    const beforeRetry = await repository.get(owner, created.chat.id);
    expect(beforeRetry).not.toBeNull();
    const retryRun = run(created.chat.id, acceptedTurn, 2);

    const admitted = await repository.admitRetry(owner, {
      chatId: created.chat.id,
      turnId: acceptedTurn.id,
      clientRequestId: "req_pinned_retry",
      baseRevision: beforeRetry!.chat.revision,
      run: retryRun,
    });
    const repeated = await repository.admitRetry(owner, {
      chatId: created.chat.id,
      turnId: acceptedTurn.id,
      clientRequestId: "req_pinned_retry",
      baseRevision: beforeRetry!.chat.revision,
      run: { ...retryRun, id: "run_pinned_retry_duplicate" },
    });

    expect(admitted.chat.chat.userState).toEqual({ readThroughSeq: 0, pinned: true, muted: false });
    expect(repeated.chat.chat.userState).toEqual({ readThroughSeq: 0, pinned: true, muted: false });
  });

  it("paginates equal microsecond timestamps with an opaque precision-safe cursor", async () => {
    for (const suffix of ["a", "b", "c"]) {
      await repository.create(owner, {
        id: `chat_page_${suffix}`,
        clientRequestId: `req_create_page_${suffix}`,
        title: `Page ${suffix}`,
      });
    }
    const tiedAt = "2026-08-25T00:10:00.123456Z";
    await sql`UPDATE chats SET updated_at = ${tiedAt}`.execute(repository.kysely);

    const firstPage = await repository.list(owner, { limit: 2 });
    expect(firstPage.nextCursor).toEqual({
      updatedAt: tiedAt,
      chatId: "chat_page_b",
    });
    const secondPage = await repository.list(owner, {
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    expect(firstPage.items.map((record) => record.chat.id)).toEqual(["chat_page_a", "chat_page_b"]);
    expect(secondPage.items.map((record) => record.chat.id)).toEqual(["chat_page_c"]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("enforces optimistic revisions and blocks Project mutation during an active Run", async () => {
    const created = await repository.create(owner, {
      id: "chat_revision",
      clientRequestId: "req_create_revision",
      title: "Revisioned",
      projectId: "project_a",
    });
    const updated = await repository.update(owner, created.chat.id, {
      baseRevision: 0,
      title: "Revision two",
      projectId: "project_b",
    });
    expect(updated.chat.revision).toBe(1);
    expect(updated.projectId).toBe("project_b");
    await expect(repository.update(owner, created.chat.id, {
      baseRevision: 0,
      title: "Stale",
    })).rejects.toBeInstanceOf(ChatConflictError);

    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 1,
      message: input,
      turn: acceptedTurn,
      run: run(created.chat.id, acceptedTurn),
      adapterState: { schemaVersion: 1, state: { session: "opaque" } },
    });
    await expect(repository.update(owner, created.chat.id, {
      baseRevision: 2,
      projectId: "project_c",
    })).rejects.toBeInstanceOf(ChatBusyError);
  });

  it("admits a Turn atomically, deduplicates requests, and permits only one active Run", async () => {
    const created = await repository.create(owner, {
      id: "chat_turns",
      clientRequestId: "req_create_turns",
      title: "Turns",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const acceptedRun = run(created.chat.id, acceptedTurn);

    const first = await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
      adapterState: { schemaVersion: 1, state: { session: "opaque" } },
    });
    const repeated = await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
      adapterState: { schemaVersion: 1, state: { session: "opaque" } },
    });

    expect(first.alreadyAccepted).toBe(false);
    expect(repeated).toEqual({ ...first, alreadyAccepted: true });
    expect((await repository.get(owner, created.chat.id))?.chat).toMatchObject({ revision: 1, messageCount: 1 });
    expect((await repository.get(owner, created.chat.id))?.activeRun).toEqual({
      runId: acceptedRun.id,
      turnId: acceptedTurn.id,
      status: "accepted",
    });
    expect(await repository.getMessages(owner, created.chat.id, { afterSeq: 0, limit: 200 })).toEqual([input]);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 10 })).toEqual([
      expect.objectContaining({ eventType: "chat.created" }),
      expect.objectContaining({ eventType: "turn.accepted", revision: 1 }),
    ]);

    const secondMessage = message(created.chat.id, 2);
    const secondTurn = turn(created.chat.id, secondMessage, "req_turn_2");
    await expect(repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 1,
      message: secondMessage,
      turn: secondTurn,
      run: run(created.chat.id, secondTurn, 2),
    })).rejects.toBeInstanceOf(ChatBusyError);
  });

  it("durably enqueues an idempotent ordered Turn while a Run is active", async () => {
    const admitted = await admitChat(repository, "queued_turn");
    const queuedInput = {
      chatId: admitted.chatId,
      baseRevision: 1,
      queuedTurnId: "qturn_queued_turn_1",
      clientRequestId: "req_queue_turn_1",
      parts: [{ type: "text" as const, text: "run this next" }],
      driverKind: "codex" as const,
      selection: selection(),
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: admitted.run.capabilitySnapshot,
      createdAt: "2026-08-25T00:00:10.000Z",
    };

    const first = await repository.enqueueQueuedTurn(owner, queuedInput);
    const repeated = await repository.enqueueQueuedTurn(owner, {
      ...queuedInput,
      baseRevision: 1,
      queuedTurnId: "qturn_should_not_be_inserted",
    });

    expect(first).toMatchObject({
      alreadyQueued: false,
      queueDepth: 1,
      queuedTurn: {
        id: "qturn_queued_turn_1",
        chatId: admitted.chatId,
        clientRequestId: "req_queue_turn_1",
        position: 1,
        parts: [{ type: "text", text: "run this next" }],
      },
    });
    expect(repeated).toEqual({ ...first, alreadyQueued: true });
    expect((await repository.get(owner, admitted.chatId))?.chat.revision).toBe(2);
    expect((await repository.getDetailPage(owner, admitted.chatId, { limit: 200 }))?.queuedTurns)
      .toEqual([first.queuedTurn]);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 10 }))
      .toContainEqual(expect.objectContaining({
        eventType: "queue.enqueued",
        revision: 2,
        payload: { queuedTurnId: "qturn_queued_turn_1", position: 1 },
      }));
    await expect(repository.enqueueQueuedTurn(otherOwner, {
      ...queuedInput,
      clientRequestId: "req_queue_other_owner",
      queuedTurnId: "qturn_other_owner",
      baseRevision: 2,
    })).rejects.toBeInstanceOf(ChatNotFoundError);
  });

  it("enqueues against the current locked Chat revision when Run activity advances after the client snapshot", async () => {
    const admitted = await admitChat(repository, "queue_activity_race");
    const observedRevision = 1;
    await repository.appendRunActivities(owner, admitted.chatId, admitted.runId, [
      activity(admitted.chatId, admitted.runId, 901),
    ]);

    await expect(repository.enqueueQueuedTurn(owner, {
      chatId: admitted.chatId,
      baseRevision: observedRevision,
      queuedTurnId: "qturn_queue_activity_race_1",
      clientRequestId: "req_queue_activity_race_1",
      parts: [{ type: "text", text: "queue despite fresh activity" }],
      driverKind: "codex",
      selection: selection(),
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: admitted.run.capabilitySnapshot,
      createdAt: "2026-08-25T00:00:10.000Z",
    })).resolves.toMatchObject({
      alreadyQueued: false,
      queuedTurn: { id: "qturn_queue_activity_race_1" },
    });
    expect((await repository.get(owner, admitted.chatId))?.chat.revision).toBe(3);
  });

  it("cancels one queued Turn idempotently and compacts the remaining order", async () => {
    const admitted = await admitChat(repository, "queue_cancel");
    let revision = 1;
    for (const index of [1, 2, 3]) {
      await repository.enqueueQueuedTurn(owner, {
        chatId: admitted.chatId,
        baseRevision: revision++,
        queuedTurnId: `qturn_queue_cancel_${index}`,
        clientRequestId: `req_queue_cancel_${index}`,
        parts: [{ type: "text", text: `queued ${index}` }],
        driverKind: "codex",
        selection: selection(),
        interactionMode: "default",
        permissionMode: "supervised",
        capabilitySnapshot: admitted.run.capabilitySnapshot,
        createdAt: `2026-08-25T00:00:1${index}.000Z`,
      });
    }

    const cancelled = await repository.cancelQueuedTurn(owner, {
      chatId: admitted.chatId,
      queuedTurnId: "qturn_queue_cancel_2",
      clientRequestId: "req_queue_cancel_command",
      baseRevision: 4,
      cancelledAt: "2026-08-25T00:00:20.000Z",
    });
    const duplicate = await repository.cancelQueuedTurn(owner, {
      chatId: admitted.chatId,
      queuedTurnId: "qturn_queue_cancel_2",
      clientRequestId: "req_queue_cancel_command",
      baseRevision: 4,
      cancelledAt: "2026-08-25T00:00:21.000Z",
    });

    expect(cancelled).toEqual({
      queuedTurnId: "qturn_queue_cancel_2",
      queueDepth: 2,
      cancellation: "cancelled",
    });
    expect(duplicate).toEqual({ ...cancelled, cancellation: "already_cancelled" });
    expect(await repository.listQueuedTurns(owner, admitted.chatId)).toEqual([
      expect.objectContaining({ id: "qturn_queue_cancel_1", position: 1 }),
      expect.objectContaining({ id: "qturn_queue_cancel_3", position: 2 }),
    ]);
    expect((await repository.get(owner, admitted.chatId))?.chat.revision).toBe(5);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 20 }))
      .toContainEqual(expect.objectContaining({
        eventType: "queue.cancelled",
        revision: 5,
        payload: { queuedTurnId: "qturn_queue_cancel_2", position: 2 },
      }));
  });

  it("reorders the complete queued set under one revision guard", async () => {
    const admitted = await admitChat(repository, "queue_reorder");
    let revision = 1;
    for (const index of [1, 2, 3]) {
      await repository.enqueueQueuedTurn(owner, {
        chatId: admitted.chatId,
        baseRevision: revision++,
        queuedTurnId: `qturn_queue_reorder_${index}`,
        clientRequestId: `req_queue_reorder_${index}`,
        parts: [{ type: "text", text: `queued ${index}` }],
        driverKind: "codex",
        selection: selection(),
        interactionMode: "default",
        permissionMode: "supervised",
        capabilitySnapshot: admitted.run.capabilitySnapshot,
        createdAt: `2026-08-25T00:00:1${index}.000Z`,
      });
    }
    const order = [
      "qturn_queue_reorder_3",
      "qturn_queue_reorder_1",
      "qturn_queue_reorder_2",
    ];

    const reordered = await repository.reorderQueuedTurns(owner, {
      chatId: admitted.chatId,
      clientRequestId: "req_queue_reorder_command",
      baseRevision: 4,
      queuedTurnIds: order,
      reorderedAt: "2026-08-25T00:00:20.000Z",
    });

    expect(reordered.queuedTurns.map((queuedTurn) => queuedTurn.id)).toEqual(order);
    expect(reordered.queuedTurns.map((queuedTurn) => queuedTurn.position)).toEqual([1, 2, 3]);
    await expect(repository.reorderQueuedTurns(owner, {
      chatId: admitted.chatId,
      clientRequestId: "req_queue_reorder_incomplete",
      baseRevision: 5,
      queuedTurnIds: order.slice(0, 2),
      reorderedAt: "2026-08-25T00:00:21.000Z",
    })).rejects.toBeInstanceOf(ChatConflictError);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 20 }))
      .toContainEqual(expect.objectContaining({
        eventType: "queue.reordered",
        revision: 5,
        payload: { queuedTurnIds: order },
      }));
  });

  it("edits one queued Turn in place under a revision guard", async () => {
    const admitted = await admitChat(repository, "queue_edit");
    for (const index of [1, 2]) {
      await repository.enqueueQueuedTurn(owner, {
        chatId: admitted.chatId,
        baseRevision: index,
        queuedTurnId: `qturn_queue_edit_${index}`,
        clientRequestId: `req_queue_edit_${index}`,
        parts: [{ type: "text", text: `queued ${index}` }],
        driverKind: "codex",
        selection: selection(),
        interactionMode: "default",
        permissionMode: "supervised",
        capabilitySnapshot: admitted.run.capabilitySnapshot,
        createdAt: `2026-08-25T00:00:1${index}.000Z`,
      });
    }

    const result = await repository.updateQueuedTurn(owner, {
      chatId: admitted.chatId,
      queuedTurnId: "qturn_queue_edit_1",
      clientRequestId: "req_queue_edit_save",
      baseRevision: 3,
      parts: [{ type: "text", text: "edited first" }],
      updatedAt: "2026-08-25T00:00:20.000Z",
    });

    expect(result.queuedTurn).toMatchObject({
      id: "qturn_queue_edit_1",
      position: 1,
      parts: [{ type: "text", text: "edited first" }],
    });
    await expect(repository.updateQueuedTurn(owner, {
      chatId: admitted.chatId,
      queuedTurnId: "qturn_queue_edit_1",
      clientRequestId: "req_queue_edit_save",
      baseRevision: 3,
      parts: [{ type: "text", text: "edited first" }],
      updatedAt: "2026-08-25T00:00:20.000Z",
    })).resolves.toEqual(result);
    expect(await repository.listQueuedTurns(owner, admitted.chatId)).toEqual([
      expect.objectContaining({ id: "qturn_queue_edit_1", position: 1 }),
      expect.objectContaining({ id: "qturn_queue_edit_2", position: 2 }),
    ]);
    expect((await repository.get(owner, admitted.chatId))?.chat.revision).toBe(4);
    await expect(repository.updateQueuedTurn(owner, {
      chatId: admitted.chatId,
      queuedTurnId: "qturn_queue_edit_1",
      clientRequestId: "req_queue_edit_stale",
      baseRevision: 3,
      parts: [{ type: "text", text: "stale overwrite" }],
      updatedAt: "2026-08-25T00:00:21.000Z",
    })).rejects.toBeInstanceOf(ChatConflictError);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 20 }))
      .toContainEqual(expect.objectContaining({
        eventType: "queue.updated",
        revision: 4,
        payload: { queuedTurnId: "qturn_queue_edit_1", position: 1 },
      }));
  });

  it("claims at most one queued Turn into canonical message, Turn, and Run records", async () => {
    const admitted = await admitChat(repository, "queue_claim");
    await repository.enqueueQueuedTurn(owner, {
      chatId: admitted.chatId,
      baseRevision: 1,
      queuedTurnId: "qturn_queue_claim_1",
      clientRequestId: "req_queue_claim_1",
      parts: [{ type: "text", text: "first queued" }],
      driverKind: "codex",
      selection: selection(),
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: admitted.run.capabilitySnapshot,
      createdAt: "2026-08-25T00:00:10.000Z",
    });
    await repository.enqueueQueuedTurn(owner, {
      chatId: admitted.chatId,
      baseRevision: 2,
      queuedTurnId: "qturn_queue_claim_2",
      clientRequestId: "req_queue_claim_2",
      parts: [{ type: "text", text: "second queued" }],
      driverKind: "codex",
      selection: selection(),
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: admitted.run.capabilitySnapshot,
      createdAt: "2026-08-25T00:00:11.000Z",
    });
    await repository.finishRun(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      outcome: "completed",
      completedAt: "2026-08-25T00:00:20.000Z",
    });

    const claims = await Promise.all([
      repository.claimNextQueuedTurn(owner, {
        chatId: admitted.chatId,
        turnId: "cturn_queue_claim_next_a",
        runId: "run_queue_claim_next_a",
        messageId: "msg_queue_claim_next_a",
        claimedAt: "2026-08-25T00:00:21.000Z",
      }),
      repository.claimNextQueuedTurn(owner, {
        chatId: admitted.chatId,
        turnId: "cturn_queue_claim_next_b",
        runId: "run_queue_claim_next_b",
        messageId: "msg_queue_claim_next_b",
        claimedAt: "2026-08-25T00:00:21.000Z",
      }),
    ]);
    const claimed = claims.find((claim) => claim !== null);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claimed).toMatchObject({
      queuedTurn: { id: "qturn_queue_claim_1", position: 1 },
      message: { role: "user", state: "committed", parts: [{ type: "text", text: "first queued" }] },
      turn: { status: "accepted", clientRequestId: "req_queue_claim_1" },
      run: { status: "accepted", driverKind: "codex", attempt: 1 },
    });
    expect((await repository.get(owner, admitted.chatId))?.activeRun)
      .toMatchObject({ runId: claimed!.run.id, turnId: claimed!.turn.id, status: "accepted" });
    expect(await repository.listQueuedTurns(owner, admitted.chatId)).toEqual([
      expect.objectContaining({ id: "qturn_queue_claim_2", position: 1 }),
    ]);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 30 }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "queue.claimed" }),
        expect.objectContaining({ eventType: "turn.accepted" }),
      ]));
  });

  it("persists one idempotent same-Run steering message and terminalizes it atomically", async () => {
    const admitted = await admitChat(repository, "steer_persistence");
    const input = {
      chatId: admitted.chatId,
      runId: admitted.runId,
      expectedTurnId: admitted.turn.id,
      steerId: "steer_persistence_1",
      messageId: "msg_steer_persistence_1",
      clientRequestId: "req_steer_persistence_1",
      parts: [{ type: "text" as const, text: "focus on the failing test" }],
      createdAt: "2026-08-25T00:00:10.000Z",
    };

    const begun = await repository.beginSteer(owner, input);
    const duplicate = await repository.beginSteer(owner, {
      ...input,
      steerId: "steer_should_not_exist",
      messageId: "msg_should_not_exist",
    });

    expect(begun).toMatchObject({
      alreadyRequested: false,
      status: "pending",
    });
    expect(duplicate).toEqual({ ...begun, alreadyRequested: true });
    await expect(repository.beginSteer(otherOwner, {
      ...input,
      steerId: "steer_other_owner",
      messageId: "msg_other_owner",
      clientRequestId: "req_steer_other_owner",
    })).rejects.toBeInstanceOf(ChatNotFoundError);

    const accepted = await repository.acceptSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      clientRequestId: input.clientRequestId,
      acceptedAt: "2026-08-25T00:00:11.000Z",
    });
    expect(accepted).toMatchObject({ id: input.messageId, state: "committed" });
    await expect(repository.acceptSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      clientRequestId: input.clientRequestId,
      acceptedAt: "2026-08-25T00:00:12.000Z",
    })).resolves.toEqual(accepted);
    expect((await repository.get(owner, admitted.chatId))?.chat).toMatchObject({
      revision: 3,
      messageCount: 2,
    });
    expect(await repository.getMessages(owner, admitted.chatId, { afterSeq: 0, limit: 200 }))
      .toEqual([expect.objectContaining({ role: "user", state: "committed" }), accepted]);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 20 }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "run.steer_requested", revision: 2 }),
        expect.objectContaining({ eventType: "run.steered", revision: 3 }),
      ]));
  });

  it("keeps a queued Turn retryable until same-Run steering is accepted", async () => {
    const admitted = await admitChat(repository, "queued_steer");
    await repository.enqueueQueuedTurn(owner, {
      chatId: admitted.chatId,
      baseRevision: 1,
      queuedTurnId: "qturn_queued_steer_1",
      clientRequestId: "req_queued_steer_input",
      parts: [{ type: "text", text: "steer this now" }],
      driverKind: "codex",
      selection: selection(),
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: admitted.run.capabilitySnapshot,
      createdAt: "2026-08-25T00:00:10.000Z",
    });

    const begun = await repository.beginQueuedTurnSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      expectedTurnId: admitted.turn.id,
      queuedTurnId: "qturn_queued_steer_1",
      steerId: "steer_queued_steer_1",
      messageId: "msg_queued_steer_1",
      clientRequestId: "req_queued_steer_1",
      baseRevision: 2,
      createdAt: "2026-08-25T00:00:11.000Z",
    });

    expect(begun).toMatchObject({
      status: "pending",
      alreadyRequested: false,
      parts: [{ type: "text", text: "steer this now" }],
    });
    expect(await repository.listQueuedTurns(owner, admitted.chatId))
      .toEqual([expect.objectContaining({ id: "qturn_queued_steer_1", position: 1 })]);

    await repository.failQueuedTurnSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      queuedTurnId: "qturn_queued_steer_1",
      clientRequestId: "req_queued_steer_1",
      acceptedAt: "2026-08-25T00:00:12.000Z",
    });
    expect(await repository.listQueuedTurns(owner, admitted.chatId))
      .toEqual([expect.objectContaining({ id: "qturn_queued_steer_1", position: 1 })]);

    const retry = await repository.beginQueuedTurnSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      expectedTurnId: admitted.turn.id,
      queuedTurnId: "qturn_queued_steer_1",
      steerId: "steer_queued_steer_retry",
      messageId: "msg_queued_steer_retry",
      clientRequestId: "req_queued_steer_retry",
      baseRevision: 4,
      createdAt: "2026-08-25T00:00:13.000Z",
    });
    expect(retry).toMatchObject({ status: "pending", parts: begun.parts });
    const accepted = await repository.acceptQueuedTurnSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      queuedTurnId: "qturn_queued_steer_1",
      clientRequestId: "req_queued_steer_retry",
      acceptedAt: "2026-08-25T00:00:14.000Z",
    });

    expect(accepted).toMatchObject({
      id: "msg_queued_steer_retry",
      runId: admitted.runId,
      parts: [{ type: "text", text: "steer this now" }],
    });
    expect(await repository.listQueuedTurns(owner, admitted.chatId)).toEqual([]);
    expect((await repository.get(owner, admitted.chatId))?.chat).toMatchObject({
      revision: 6,
      messageCount: 2,
    });
  });

  it("does not claim a queued Turn while its accepted Provider steer is pending finalization", async () => {
    const admitted = await admitChat(repository, "queued_steer_pending_finalize");
    await repository.enqueueQueuedTurn(owner, {
      chatId: admitted.chatId,
      baseRevision: 1,
      queuedTurnId: "qturn_queued_steer_pending_finalize",
      clientRequestId: "req_queued_steer_pending_finalize_input",
      parts: [{ type: "text", text: "steer remains pending" }],
      driverKind: "codex",
      selection: selection(),
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: admitted.run.capabilitySnapshot,
      createdAt: "2026-08-25T00:00:10.000Z",
    });
    await repository.beginQueuedTurnSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      expectedTurnId: admitted.turn.id,
      queuedTurnId: "qturn_queued_steer_pending_finalize",
      steerId: "steer_queued_steer_pending_finalize",
      messageId: "msg_queued_steer_pending_finalize",
      clientRequestId: "req_queued_steer_pending_finalize",
      baseRevision: 2,
      createdAt: "2026-08-25T00:00:11.000Z",
    });
    await repository.finishRun(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      outcome: "completed",
      completedAt: "2026-08-25T00:00:12.000Z",
    });

    await expect(repository.claimNextQueuedTurn(owner, {
      chatId: admitted.chatId,
      turnId: "cturn_pending_finalize_claim",
      runId: "run_pending_finalize_claim",
      messageId: "msg_pending_finalize_claim",
      claimedAt: "2026-08-25T00:00:13.000Z",
    })).resolves.toBeNull();
    expect(await repository.listQueuedTurns(owner, admitted.chatId)).toEqual([
      expect.objectContaining({ id: "qturn_queued_steer_pending_finalize", position: 1 }),
    ]);
    expect((await repository.get(owner, admitted.chatId))?.chat.messageCount).toBe(1);
  });

  it("begins queued steering when Run activity advances after the client snapshot", async () => {
    const admitted = await admitChat(repository, "queued_steer_activity_race");
    await repository.enqueueQueuedTurn(owner, {
      chatId: admitted.chatId,
      baseRevision: 1,
      queuedTurnId: "qturn_queued_steer_activity_race_1",
      clientRequestId: "req_queued_steer_activity_race_input",
      parts: [{ type: "text", text: "steer despite fresh activity" }],
      driverKind: "codex",
      selection: selection(),
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: admitted.run.capabilitySnapshot,
      createdAt: "2026-08-25T00:00:10.000Z",
    });
    const observedRevision = 2;
    await repository.appendRunActivities(owner, admitted.chatId, admitted.runId, [
      activity(admitted.chatId, admitted.runId, 902),
    ]);

    await expect(repository.beginQueuedTurnSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      expectedTurnId: admitted.turn.id,
      queuedTurnId: "qturn_queued_steer_activity_race_1",
      steerId: "steer_queued_steer_activity_race_1",
      messageId: "msg_queued_steer_activity_race_1",
      clientRequestId: "req_queued_steer_activity_race_1",
      baseRevision: observedRevision,
      createdAt: "2026-08-25T00:00:11.000Z",
    })).resolves.toMatchObject({
      status: "pending",
      parts: [{ type: "text", text: "steer despite fresh activity" }],
    });
    expect((await repository.get(owner, admitted.chatId))?.chat.revision).toBe(4);
  });

  it("rejects stale or terminal steering targets before adding a message", async () => {
    const admitted = await admitChat(repository, "steer_stale");
    const input = {
      chatId: admitted.chatId,
      runId: admitted.runId,
      expectedTurnId: "cturn_wrong_target",
      steerId: "steer_stale_1",
      messageId: "msg_steer_stale_1",
      clientRequestId: "req_steer_stale_1",
      parts: [{ type: "text" as const, text: "stale" }],
      createdAt: "2026-08-25T00:00:10.000Z",
    };
    await expect(repository.beginSteer(owner, input)).rejects.toBeInstanceOf(ChatRunNotActiveError);
    await repository.finishRun(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      outcome: "completed",
      completedAt: "2026-08-25T00:00:11.000Z",
    });
    await expect(repository.beginSteer(owner, {
      ...input,
      expectedTurnId: admitted.turn.id,
      clientRequestId: "req_steer_terminal",
    })).rejects.toBeInstanceOf(ChatRunNotActiveError);
    expect((await repository.get(owner, admitted.chatId))?.chat.messageCount).toBe(1);
  });

  it("does not append a steering message when cancellation wins before acceptance commits", async () => {
    const admitted = await admitChat(repository, "steer_cancel_race");
    await repository.beginSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      expectedTurnId: admitted.turn.id,
      steerId: "steer_cancel_race_1",
      messageId: "msg_steer_cancel_race_1",
      clientRequestId: "req_steer_cancel_race_1",
      parts: [{ type: "text", text: "race" }],
      createdAt: "2026-08-25T00:00:10.000Z",
    });
    await repository.finishRun(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      outcome: "aborted",
      completedAt: "2026-08-25T00:00:11.000Z",
    });

    await expect(repository.acceptSteer(owner, {
      chatId: admitted.chatId,
      runId: admitted.runId,
      clientRequestId: "req_steer_cancel_race_1",
      acceptedAt: "2026-08-25T00:00:12.000Z",
    })).rejects.toBeInstanceOf(ChatRunNotActiveError);
    expect((await repository.get(owner, admitted.chatId))?.chat.messageCount).toBe(1);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 20 }))
      .toContainEqual(expect.objectContaining({ eventType: "run.steer_failed" }));
  });

  it("admits an idempotent retry as a new Run attempt without duplicating the Turn input", async () => {
    const chatId = "chat_retry_attempt";
    await repository.create(owner, {
      id: chatId,
      clientRequestId: "req_create_retry_attempt",
      title: "Retry attempt",
    });
    const inputMessage = message(chatId);
    const inputTurn = turn(chatId, inputMessage, "req_retry_turn");
    const firstRun = run(chatId, inputTurn);
    await repository.admitTurn(owner, {
      chatId,
      baseRevision: 0,
      message: inputMessage,
      turn: inputTurn,
      run: firstRun,
    });
    await repository.finishRun(owner, {
      chatId,
      runId: firstRun.id,
      outcome: "failed",
      completedAt: now,
    });
    const beforeRetry = await repository.get(owner, chatId);
    expect(beforeRetry).not.toBeNull();

    const retryRun = run(chatId, inputTurn, 2);
    const admitted = await repository.admitRetry(owner, {
      chatId,
      turnId: inputTurn.id,
      clientRequestId: "req_retry_attempt_2",
      baseRevision: beforeRetry!.chat.revision,
      run: retryRun,
      adapterState: { schemaVersion: 1, state: { sessionId: "native_retry" } },
    });
    expect(admitted).toMatchObject({
      alreadyAccepted: false,
      run: { id: retryRun.id, attempt: 2, status: "accepted" },
      turn: { id: inputTurn.id, status: "accepted" },
      chat: { chat: { messageCount: 1 } },
    });

    const duplicate = await repository.admitRetry(owner, {
      chatId,
      turnId: inputTurn.id,
      clientRequestId: "req_retry_attempt_2",
      baseRevision: beforeRetry!.chat.revision,
      run: { ...retryRun, id: "run_retry_duplicate" },
    });
    expect(duplicate).toMatchObject({
      alreadyAccepted: true,
      run: { id: retryRun.id, attempt: 2 },
    });
    expect((await repository.exportChat(owner, chatId))?.messages).toHaveLength(1);
    expect(await repository.getAdapterState(owner, {
      runId: retryRun.id,
      driverKind: retryRun.driverKind,
      instanceId: retryRun.instanceId,
    })).toEqual({ schemaVersion: 1, state: { sessionId: "native_retry" } });
  });

  it("rejects new Turn and retry admissions after a Chat is archived", async () => {
    const chatId = "chat_archived_admission";
    await repository.create(owner, {
      id: chatId,
      clientRequestId: "req_create_archived_admission",
      title: "Archived admission",
    });
    const inputMessage = message(chatId);
    const inputTurn = turn(chatId, inputMessage, "req_archived_seed");
    const firstRun = run(chatId, inputTurn);
    await repository.admitTurn(owner, {
      chatId,
      baseRevision: 0,
      message: inputMessage,
      turn: inputTurn,
      run: firstRun,
    });
    await repository.finishRun(owner, {
      chatId,
      runId: firstRun.id,
      outcome: "failed",
      completedAt: now,
    });
    const beforeArchive = await repository.get(owner, chatId);
    expect(beforeArchive).not.toBeNull();
    const archived = await repository.update(owner, chatId, {
      baseRevision: beforeArchive!.chat.revision,
      lifecycle: "archived",
    });

    const nextMessage = message(chatId, 2);
    const nextTurn = turn(chatId, nextMessage, "req_archived_new_turn");
    await expect(repository.admitTurn(owner, {
      chatId,
      baseRevision: archived.chat.revision,
      message: nextMessage,
      turn: nextTurn,
      run: run(chatId, nextTurn, 1),
    })).rejects.toBeInstanceOf(ChatConflictError);
    await expect(repository.admitRetry(owner, {
      chatId,
      turnId: inputTurn.id,
      clientRequestId: "req_archived_retry",
      baseRevision: archived.chat.revision,
      run: run(chatId, inputTurn, 2),
    })).rejects.toBeInstanceOf(ChatConflictError);
  });

  it("rejects a Turn whose input message does not belong to that Turn", async () => {
    const created = await repository.create(owner, {
      id: "chat_invalid_turn_message",
      clientRequestId: "req_create_invalid_turn_message",
      title: "Invalid Turn message",
    });
    const input = { ...message(created.chat.id), turnId: "cturn_wrong" };
    const acceptedTurn = turn(created.chat.id, input);

    await expect(repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: run(created.chat.id, acceptedTurn),
    })).rejects.toBeInstanceOf(ChatConflictError);
    expect(await repository.getMessages(owner, created.chat.id, { afterSeq: 0, limit: 200 })).toEqual([]);
  });

  it("reports non-active-Run uniqueness failures as conflicts instead of busy", async () => {
    const first = await repository.create(owner, {
      id: "chat_unique_first",
      clientRequestId: "req_create_unique_first",
      title: "First unique Chat",
    });
    const firstMessage = message(first.chat.id);
    const firstTurn = turn(first.chat.id, firstMessage);
    await repository.admitTurn(owner, {
      chatId: first.chat.id,
      baseRevision: 0,
      message: firstMessage,
      turn: firstTurn,
      run: run(first.chat.id, firstTurn),
    });

    const second = await repository.create(owner, {
      id: "chat_unique_second",
      clientRequestId: "req_create_unique_second",
      title: "Second unique Chat",
    });
    const secondMessage = { ...message(second.chat.id), id: firstMessage.id };
    const secondTurn = turn(second.chat.id, secondMessage, "req_turn_unique_second");
    await expect(repository.admitTurn(owner, {
      chatId: second.chat.id,
      baseRevision: 0,
      message: secondMessage,
      turn: secondTurn,
      run: run(second.chat.id, secondTurn),
    })).rejects.toBeInstanceOf(ChatConflictError);
  });

  it("backs serialized Turn admission with a database-level active Run constraint", async () => {
    const created = await repository.create(owner, {
      id: "chat_admission_race",
      clientRequestId: "req_create_admission_race",
      title: "Admission race",
    });
    const firstMessage = message(created.chat.id, 1);
    const firstTurn = turn(created.chat.id, firstMessage, "req_race_first");
    const secondMessage = {
      ...message(created.chat.id, 2),
      id: "msg_race_second",
      turnId: "cturn_race_second",
    };
    const secondTurn = { ...turn(created.chat.id, secondMessage, "req_race_second"), id: "cturn_race_second" };
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: firstMessage,
      turn: firstTurn,
      run: run(created.chat.id, firstTurn, 1),
    });
    await expect(repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 1,
      message: secondMessage,
      turn: secondTurn,
      run: { ...run(created.chat.id, secondTurn, 1), id: "run_race_second" },
    })).rejects.toBeInstanceOf(ChatBusyError);

    const activeRunIndex = await sql<{ indexdef: string }>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_chat_runs_one_active'
    `.execute(repository.kysely);
    expect(activeRunIndex.rows).toEqual([
      expect.objectContaining({
        indexdef: expect.stringMatching(/UNIQUE INDEX.*chat_id.*status.*accepted.*running.*waiting_for_approval.*waiting_for_input/i),
      }),
    ]);
    expect(await repository.getMessages(owner, created.chat.id, { afterSeq: 0, limit: 200 })).toHaveLength(1);
    expect((await repository.exportChat(owner, created.chat.id))?.runs).toHaveLength(1);
    expect(await repository.replayOutbox(owner, { afterCursor: 0, limit: 10 })).toHaveLength(2);
  });

  it("stores only bounded normalized events and transitions a Run terminal with its outbox", async () => {
    const created = await repository.create(owner, {
      id: "chat_events",
      clientRequestId: "req_create_events",
      title: "Events",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
    });
    const activity: CanonicalChatRunActivity = {
      id: "activity_running",
      chatId: created.chat.id,
      runId: acceptedRun.id,
      occurredAt: now,
      type: "run.status",
      status: "running",
    };
    await repository.appendRunActivities(owner, created.chat.id, acceptedRun.id, [activity]);
    await repository.finishRun(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      outcome: "completed",
      completedAt: "2026-08-25T00:01:00.000Z",
    });

    const snapshot = await repository.exportChat(owner, created.chat.id);
    expect(snapshot?.activities).toEqual([{ ...activity, sequence: 1 }]);
    expect(snapshot?.runs[0]).toMatchObject({ status: "completed", outcome: "completed" });
    expect(snapshot).not.toHaveProperty("adapterState");
    expect((await repository.get(owner, created.chat.id))?.activeRun).toBeUndefined();
    expect((await repository.replayOutbox(owner, { afterCursor: 0, limit: 10 })).at(-1)).toMatchObject({
      eventType: "run.completed",
    });
  });

  it("assigns a stable run-local sequence when activities share a timestamp", async () => {
    const created = await repository.create(owner, {
      id: "chat_activity_sequence",
      clientRequestId: "req_create_activity_sequence",
      title: "Activity sequence",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
    });
    const activities = [
      { ...activity(created.chat.id, acceptedRun.id, 3), id: "activity_z" },
      { ...activity(created.chat.id, acceptedRun.id, 1), id: "activity_a" },
      { ...activity(created.chat.id, acceptedRun.id, 2), id: "activity_m" },
    ];

    await repository.appendRunActivities(owner, created.chat.id, acceptedRun.id, activities.slice(0, 2));
    await repository.appendRunActivities(owner, created.chat.id, acceptedRun.id, activities.slice(2));

    expect((await repository.exportChat(owner, created.chat.id))?.activities).toEqual([
      expect.objectContaining({ id: "activity_z", sequence: 1 }),
      expect.objectContaining({ id: "activity_a", sequence: 2 }),
      expect.objectContaining({ id: "activity_m", sequence: 3 }),
    ]);
  });

  it("updates a typed activity in place without changing its first receive sequence", async () => {
    const created = await repository.create(owner, {
      id: "chat_activity_lifecycle",
      clientRequestId: "req_create_activity_lifecycle",
      title: "Activity lifecycle",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
    });
    const running: CanonicalChatRunActivity = {
      id: "activity_command",
      chatId: created.chat.id,
      runId: acceptedRun.id,
      occurredAt: now,
      type: "agent.activity",
      activityId: "tool_command",
      kind: "command",
      label: "Run command",
      status: "running",
    };
    const failed: CanonicalChatRunActivity = {
      ...running,
      occurredAt: "2026-08-25T00:00:05.000Z",
      status: "failed",
      summary: "Command failed.",
    };

    await expect(repository.appendRunActivities(
      owner,
      created.chat.id,
      acceptedRun.id,
      [running],
    )).resolves.toBe(1);
    await expect(repository.appendRunActivities(
      owner,
      created.chat.id,
      acceptedRun.id,
      [failed],
    )).resolves.toBe(1);
    await repository.appendRunActivities(owner, created.chat.id, acceptedRun.id, [
      { ...activity(created.chat.id, acceptedRun.id, 2), id: "activity_after_command" },
    ]);

    expect((await repository.exportChat(owner, created.chat.id))?.activities).toEqual([
      { ...failed, occurredAt: now, sequence: 1 },
      expect.objectContaining({ id: "activity_after_command", sequence: 2 }),
    ]);
  });

  it("commits assistant output with the terminal transition and rejects late Provider events", async () => {
    const created = await repository.create(owner, {
      id: "chat_terminal_output",
      clientRequestId: "req_create_terminal_output",
      title: "Terminal output",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
      adapterState: { schemaVersion: 1, state: { sessionId: "native_1" } },
    });

    await repository.markRunRunning(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      startedAt: "2026-08-25T00:00:30.000Z",
    });
    await repository.updateAdapterState(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      driverKind: "codex",
      instanceId: "codex_default",
      schemaVersion: 1,
      state: { sessionId: "native_2" },
    });
    const assistant: CanonicalChatMessage = {
      id: "msg_terminal_output_assistant",
      chatId: created.chat.id,
      seq: 2,
      role: "assistant",
      state: "committed",
      turnId: acceptedTurn.id,
      runId: acceptedRun.id,
      parts: [{ type: "text", text: "done" }],
      createdAt: "2026-08-25T00:01:00.000Z",
    };
    await repository.finishRun(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      outcome: "completed",
      completedAt: assistant.createdAt,
      output: assistant,
    });

    const snapshot = await repository.exportChat(owner, created.chat.id);
    expect(snapshot?.messages).toEqual([input, assistant]);
    expect(snapshot?.turns[0]).toMatchObject({ status: "completed" });
    expect(snapshot?.runs[0]).toMatchObject({ status: "completed", outcome: "completed" });
    expect(snapshot?.chat.chat).toMatchObject({ messageCount: 2, lastMessagePreview: "done" });
    expect(await repository.getAdapterState(owner, {
      runId: acceptedRun.id,
      driverKind: "codex",
      instanceId: "codex_default",
    })).toEqual({ schemaVersion: 1, state: { sessionId: "native_2" } });

    await expect(repository.appendRunActivities(owner, created.chat.id, acceptedRun.id, [
      activity(created.chat.id, acceptedRun.id, 99),
    ])).rejects.toMatchObject({ name: "ChatRunNotActiveError" });
  });

  it("persists an idempotent terminal binding for a completed Chat run", async () => {
    const created = await repository.create(owner, {
      id: "chat_manual_terminal",
      clientRequestId: "req_manual_terminal",
      title: "Manual terminal",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
    });
    await repository.finishRun(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      outcome: "completed",
      completedAt: "2026-08-25T00:01:00.000Z",
    });

    await expect(repository.bindTerminalSession(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      sessionId: "chat-calm-otter",
      sessionCreatedAt: "2026-08-28T10:00:00.000Z",
    })).resolves.toBe(true);
    await expect(repository.bindTerminalSession(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      sessionId: "chat-calm-otter",
      sessionCreatedAt: "2026-08-28T10:00:00.000Z",
    })).resolves.toBe(false);
    await expect(repository.bindTerminalSession(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      sessionId: "chat-calm-otter",
      sessionCreatedAt: "2026-08-28T10:10:00.000Z",
    })).resolves.toBe(true);
    await expect(repository.getTerminalBinding(owner, created.chat.id, "chat-calm-otter")).resolves.toEqual({
      sessionCreatedAt: "2026-08-28T10:10:00.000Z",
    });
  });

  it("persists a terminal binding before the Chat has its first Run", async () => {
    const created = await repository.create(owner, {
      id: "chat_draft_terminal",
      clientRequestId: "req_draft_terminal",
      title: "New chat",
      projectId: "project_stable",
    });

    await expect(repository.getChatForTerminalBinding(owner, created.chat.id)).resolves.toEqual({
      projectId: "project_stable",
    });
    await expect(repository.bindTerminalSession(owner, {
      chatId: created.chat.id,
      sessionId: "chat-draft-terminal",
      sessionCreatedAt: "2026-08-28T10:05:00.000Z",
    })).resolves.toBe(true);
    await expect(repository.bindTerminalSession(owner, {
      chatId: created.chat.id,
      sessionId: "chat-draft-terminal",
      sessionCreatedAt: "2026-08-28T10:05:00.000Z",
    })).resolves.toBe(false);
    await expect(repository.getTerminalBinding(owner, created.chat.id, "chat-draft-terminal")).resolves.toEqual({
      sessionCreatedAt: "2026-08-28T10:05:00.000Z",
    });
    await expect(repository.listBoundTerminalSessionIds(owner, ["chat-draft-terminal", "manual-shell"]))
      .resolves.toEqual(["chat-draft-terminal"]);

    const detail = await repository.getDetailPage(owner, created.chat.id, { limit: 50 });
    expect(detail?.terminalSessionIds).toEqual(["chat-draft-terminal"]);
  });

  it("charges the Run event limit only for unseen activity IDs", async () => {
    const created = await repository.create(owner, {
      id: "chat_activity_retry_capacity",
      clientRequestId: "req_create_activity_retry_capacity",
      title: "Activity retry capacity",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
    });
    const persisted = Array.from({ length: 499 }, (_, index) => activity(created.chat.id, acceptedRun.id, index));
    await repository.kysely.insertInto("chat_run_events").values(persisted.map((event) => ({
      id: event.id,
      chat_id: created.chat.id,
      run_id: acceptedRun.id,
      event: sql`${JSON.stringify(event)}::jsonb`,
      occurred_at: event.occurredAt,
    }))).execute();

    await expect(repository.appendRunActivities(owner, created.chat.id, acceptedRun.id, [
      persisted[0]!,
      activity(created.chat.id, acceptedRun.id, 499),
    ])).resolves.toBe(1);
    const count = await repository.kysely.selectFrom("chat_run_events")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("run_id", "=", acceptedRun.id)
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(500);
  });

  it("keeps adapter state behind the exact Driver and Instance boundary", async () => {
    const created = await repository.create(owner, {
      id: "chat_adapter_state",
      clientRequestId: "req_create_adapter_state",
      title: "Adapter state",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
      adapterState: { schemaVersion: 3, state: { nativeSession: "opaque" } },
    });

    await expect(repository.getAdapterState(owner, {
      runId: acceptedRun.id,
      driverKind: "codex",
      instanceId: "codex_default",
    })).resolves.toEqual({ schemaVersion: 3, state: { nativeSession: "opaque" } });
    await expect(repository.getAdapterState(owner, {
      runId: acceptedRun.id,
      driverKind: "pi",
      instanceId: "codex_default",
    })).resolves.toBeNull();
    await expect(repository.getAdapterState(otherOwner, {
      runId: acceptedRun.id,
      driverKind: "codex",
      instanceId: "codex_default",
    })).resolves.toBeNull();
  });

  it("serializes delete and finalize without resurrecting Chat content", async () => {
    const created = await repository.create(owner, {
      id: "chat_delete_finish_race",
      clientRequestId: "req_create_delete_finish_race",
      title: "Delete finalize race",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
    });

    await expect(repository.hardDelete(owner, {
      chatId: created.chat.id,
      clientRequestId: "req_delete_while_active",
    })).rejects.toBeInstanceOf(ChatBusyError);
    await repository.finishRun(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      outcome: "completed",
      completedAt: "2026-08-25T00:02:00.000Z",
    });
    await repository.hardDelete(owner, {
      chatId: created.chat.id,
      clientRequestId: "req_delete_after_finish",
    });

    expect(await repository.get(owner, created.chat.id)).toBeNull();
    expect(await repository.exportChat(owner, created.chat.id)).toBeNull();
    await expect(repository.finishRun(owner, {
      chatId: created.chat.id,
      runId: acceptedRun.id,
      outcome: "completed",
      completedAt: "2026-08-25T00:03:00.000Z",
    })).rejects.toBeInstanceOf(ChatNotFoundError);
    expect(await repository.get(owner, created.chat.id)).toBeNull();
  });

  it("searches only committed owner-local canonical message text with a bounded result", async () => {
    const created = await repository.create(owner, {
      id: "chat_search",
      clientRequestId: "req_create_search",
      title: "Search",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: 0,
      message: input,
      turn: acceptedTurn,
      run: run(created.chat.id, acceptedTurn),
    });

    await expect(repository.search(owner, "message", 200)).resolves.toEqual([
      expect.objectContaining({ chat: expect.objectContaining({ id: created.chat.id }) }),
    ]);
    await expect(repository.search(otherOwner, "message", 200)).resolves.toEqual([]);

    const projectChat = await repository.create(owner, {
      id: "chat_search_project",
      clientRequestId: "req_create_search_project",
      title: "Project search",
      projectId: "project_search",
    });
    const projectInput = message(projectChat.chat.id);
    const projectTurn = turn(projectChat.chat.id, projectInput);
    await repository.admitTurn(owner, {
      chatId: projectChat.chat.id,
      baseRevision: 0,
      message: projectInput,
      turn: projectTurn,
      run: run(projectChat.chat.id, projectTurn),
    });

    await expect(repository.search(owner, "message", 20, null)).resolves.toEqual([
      expect.objectContaining({ chat: expect.objectContaining({ id: created.chat.id }) }),
    ]);
    await expect(repository.search(owner, "message", 20, "project_search")).resolves.toEqual([
      expect.objectContaining({ chat: expect.objectContaining({ id: projectChat.chat.id }) }),
    ]);
  });

  it("returns the latest bounded detail page with an owner-isolated older-message cursor", async () => {
    const created = await repository.create(owner, {
      id: "chat_detail_page",
      clientRequestId: "req_create_detail_page",
      title: "Detail page",
    });
    await repository.kysely.insertInto("chat_messages").values(
      [1, 2, 3].map((seq) => ({
        id: `msg_detail_${seq}`,
        chat_id: created.chat.id,
        seq,
        role: "assistant" as const,
        state: "committed" as const,
        turn_id: null,
        run_id: null,
        parts: sql`${JSON.stringify([{ type: "text", text: `detail ${seq}` }])}::jsonb`,
        byte_count: 32,
        search_text: `detail ${seq}`,
        created_at: now,
      })),
    ).execute();

    const latest = await repository.getDetailPage(owner, created.chat.id, { limit: 2 });
    expect(latest?.messages.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(latest?.nextBeforeSeq).toBe(2);
    const older = await repository.getDetailPage(owner, created.chat.id, {
      limit: 2,
      beforeSeq: latest?.nextBeforeSeq,
    });
    expect(older?.messages.map((entry) => entry.seq)).toEqual([1]);
    expect(older?.nextBeforeSeq).toBeUndefined();
    await expect(repository.getDetailPage(otherOwner, created.chat.id, { limit: 2 }))
      .resolves.toBeNull();
  });

  it("loads legacy Chat detail while omitting an unverifiable terminal binding activity", async () => {
    const created = await repository.create(owner, {
      id: "chat_legacy_terminal_activity",
      clientRequestId: "req_create_legacy_terminal_activity",
      title: "Legacy terminal activity",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input, "req_legacy_terminal_turn");
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: created.chat.revision,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
    });
    await repository.kysely.insertInto("chat_run_events").values({
      id: "activity_legacy_terminal_without_incarnation",
      chat_id: created.chat.id,
      run_id: acceptedRun.id,
      event: {
        id: "activity_legacy_terminal_without_incarnation",
        chatId: created.chat.id,
        runId: acceptedRun.id,
        occurredAt: now,
        type: "terminal.bound",
        terminalSessionId: "terminal_legacy",
      },
      occurred_at: now,
    }).execute();

    const detail = await repository.getDetailPage(owner, created.chat.id, { limit: 200 });
    const exported = await repository.exportChat(owner, created.chat.id);

    expect(detail).not.toBeNull();
    expect(detail?.activities).toEqual([]);
    expect(exported?.activities).toEqual([]);
  });

  it("rejects malformed terminal binding activity instead of weakening incarnation checks", async () => {
    const created = await repository.create(owner, {
      id: "chat_malformed_terminal_activity",
      clientRequestId: "req_create_malformed_terminal_activity",
      title: "Malformed terminal activity",
    });
    const input = message(created.chat.id);
    const acceptedTurn = turn(created.chat.id, input, "req_malformed_terminal_turn");
    const acceptedRun = run(created.chat.id, acceptedTurn);
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: created.chat.revision,
      message: input,
      turn: acceptedTurn,
      run: acceptedRun,
    });
    await repository.kysely.insertInto("chat_run_events").values({
      id: "activity_terminal_with_invalid_incarnation",
      chat_id: created.chat.id,
      run_id: acceptedRun.id,
      event: {
        id: "activity_terminal_with_invalid_incarnation",
        chatId: created.chat.id,
        runId: acceptedRun.id,
        occurredAt: now,
        type: "terminal.bound",
        terminalSessionId: "terminal_invalid",
        terminalSessionCreatedAt: "not-an-iso-timestamp",
      },
      occurred_at: now,
    }).execute();

    await expect(repository.getDetailPage(owner, created.chat.id, { limit: 200 }))
      .rejects.toThrow("Invalid ISO datetime");
  });

  it("hard-deletes all content once and preserves only a content-free tombstone", async () => {
    const created = await repository.create(owner, {
      id: "chat_delete",
      clientRequestId: "req_create_delete",
      title: "Delete me",
    });
    const first = await repository.hardDelete(owner, {
      chatId: created.chat.id,
      clientRequestId: "req_delete_once",
    });
    const repeated = await repository.hardDelete(owner, {
      chatId: created.chat.id,
      clientRequestId: "req_delete_once",
    });
    const repeatedWithNewRequest = await repository.hardDelete(owner, {
      chatId: created.chat.id,
      clientRequestId: "req_delete_again",
    });

    expect(repeated).toEqual(first);
    expect(repeatedWithNewRequest).toEqual(first);
    expect(await repository.get(owner, created.chat.id)).toBeNull();
    expect(await repository.exportChat(owner, created.chat.id)).toBeNull();
    await expect(repository.hardDelete(otherOwner, {
      chatId: created.chat.id,
      clientRequestId: "req_delete_other",
    })).rejects.toBeInstanceOf(ChatNotFoundError);
    const tombstones = await repository.kysely.selectFrom("chat_deletions").selectAll().execute();
    expect(tombstones).toEqual([
      expect.objectContaining({ chat_id: created.chat.id, owner_id: owner.ownerId, request_id: "req_delete_once" }),
    ]);
    expect(JSON.stringify(tombstones)).not.toContain("Delete me");
  });

  it("rejects owner-wide deletion request reuse for another Chat as a typed conflict", async () => {
    const first = await repository.create(owner, {
      id: "chat_delete_request_first",
      clientRequestId: "req_create_delete_request_first",
      title: "First deletion target",
    });
    const second = await repository.create(owner, {
      id: "chat_delete_request_second",
      clientRequestId: "req_create_delete_request_second",
      title: "Second deletion target",
    });
    const requestId = "req_delete_owner_wide";
    await repository.hardDelete(owner, { chatId: first.chat.id, clientRequestId: requestId });

    await expect(repository.hardDelete(owner, {
      chatId: second.chat.id,
      clientRequestId: requestId,
    })).rejects.toBeInstanceOf(ChatConflictError);
    expect(await repository.get(owner, second.chat.id)).not.toBeNull();
  });

  it("rechecks the deletion tombstone after a concurrent delete wins the Chat row lock", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/gateway/src/chat/repository.ts"),
      "utf8",
    );
    const hardDelete = source.slice(
      source.indexOf("  async hardDelete("),
      source.indexOf("  async upsertLegacyImport("),
    );
    const lockedChat = hardDelete.indexOf("selectOwnedChat(trx, owner, input.chatId, true)");
    const tombstoneRecheck = hardDelete.indexOf("selectFrom(\"chat_deletions\")", lockedChat);
    const notFound = hardDelete.indexOf("throw new ChatNotFoundError", lockedChat);

    expect(lockedChat).toBeGreaterThan(-1);
    expect(tombstoneRecheck).toBeGreaterThan(lockedChat);
    expect(notFound).toBeGreaterThan(tombstoneRecheck);
  });

  it("handles concurrent owner-wide deletion request conflicts at the insert boundary", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/gateway/src/chat/repository.ts"),
      "utf8",
    );
    const hardDelete = source.slice(
      source.indexOf("  async hardDelete("),
      source.indexOf("  async upsertLegacyImport("),
    );

    expect(hardDelete).toContain(
      '.onConflict((oc) => oc.columns(["owner_type", "owner_id", "request_id"]).doNothing())',
    );
    expect(hardDelete).toMatch(/if \(!deletion\)[\s\S]*request_id[\s\S]*ChatConflictError/);
  });

  it("records legacy import and migration checkpoints idempotently", async () => {
    await repository.upsertLegacyImport(owner, {
      sourceKind: "hermes",
      sourceId: "legacy_1",
      chatId: "chat_imported",
      sourceHash: "sha256:first",
      importVersion: 1,
      verificationStatus: "verified",
    });
    await repository.upsertLegacyImport(owner, {
      sourceKind: "hermes",
      sourceId: "legacy_1",
      chatId: "chat_imported",
      sourceHash: "sha256:second",
      importVersion: 2,
      verificationStatus: "verified",
    });
    expect(await repository.getLegacyImport(owner, "hermes", "legacy_1")).toMatchObject({
      sourceHash: "sha256:second",
      importVersion: 2,
    });

    await repository.recordMigration(owner, {
      migrationId: "canonical_chat_v1",
      phase: "verified",
      sourceFingerprint: "sha256:sources",
      importedCount: 1,
      errorCount: 0,
    });
    expect(await repository.getMigration(owner, "canonical_chat_v1")).toMatchObject({
      phase: "verified",
      importedCount: 1,
    });
  });

  it("never destroys the shared Gateway Kysely instance", async () => {
    await repository.release();
    await expect(repository.list(owner, { limit: 1 })).resolves.toEqual({ items: [] });
  });

  it("wires Chat bootstrap and release around the Gateway-owned Kysely lifecycle", () => {
    const source = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");
    const construct = source.indexOf("chatRepository = new ChatRepository(kysely");
    const bootstrap = source.indexOf("await chatRepository.bootstrap()", construct);
    const release = source.indexOf("await chatRepository?.release()");
    const ownerDestroy = source.indexOf("await appDb?.destroy()", release);

    expect(construct).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(construct);
    expect(release).toBeGreaterThan(bootstrap);
    expect(ownerDestroy).toBeGreaterThan(release);
  });
});
