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
    expect(await repository.list(owner, { limit: 101 })).toHaveLength(1);
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

    expect(repeated).toEqual(first);
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

    expect(repeated).toEqual(first);
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
    await expect(repository.list(owner, { limit: 1 })).resolves.toEqual([]);
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
