import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import type {
  CanonicalChatMessage,
  CanonicalChatRun,
  CanonicalChatRunActivity,
  CanonicalChatTurn,
} from "@matrix-os/contracts";
import {
  ChatBusyError,
  ChatConflictError,
  ChatNotFoundError,
  ChatRepository,
} from "../../packages/gateway/src/chat/repository.js";

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
      "chat_run_adapter_state",
      "chat_run_events",
      "chat_runs",
      "chat_turns",
      "chat_user_state",
      "chats",
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
    expect(snapshot?.activities).toEqual([activity]);
    expect(snapshot?.runs[0]).toMatchObject({ status: "completed", outcome: "completed" });
    expect(snapshot).not.toHaveProperty("adapterState");
    expect((await repository.get(owner, created.chat.id))?.activeRun).toBeUndefined();
    expect((await repository.replayOutbox(owner, { afterCursor: 0, limit: 10 })).at(-1)).toMatchObject({
      eventType: "run.completed",
    });
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
