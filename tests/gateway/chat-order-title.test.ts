import { bootstrapChatMetadata } from "../../packages/gateway/src/chat/metadata-schema.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { KyselyPGlite } from "kysely-pglite";
import type {
  CanonicalChatMessage,
  CanonicalChatRun,
  CanonicalChatRunActivity,
  CanonicalChatTurn,
} from "@matrix-os/contracts";
import {
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
    purpose: "ai_request",
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

function createChat(repository: ChatRepository, suffix: string, creationOwner = owner) {
  return repository.create(creationOwner, {
    id: `chat_${suffix}`, clientRequestId: `req_${suffix}`, title: suffix, projectId: "project_stable",
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

describe("Chat ordering and title versions", () => {
  let repository: ChatRepository;
  let schema: string | undefined;
  let admin: Pool | undefined;
  beforeEach(async () => {
    if (process.env.CHAT_TEST_DATABASE_URL) {
      admin = new Pool({ connectionString: process.env.CHAT_TEST_DATABASE_URL });
      schema = `chat_test_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      repository = new ChatRepository(new PostgresDialect({ pool: new Pool({
        connectionString: process.env.CHAT_TEST_DATABASE_URL, options: `-c search_path=${schema},public`,
      }) }));
    } else {
      const pg = await KyselyPGlite.create();
      repository = new ChatRepository(pg.dialect);
    }
    await repository.bootstrap();
  });
  afterEach(async () => {
    await repository.kysely.destroy();
    if (admin && schema) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });

  it("keeps concurrent runs, navigation and renames stable across precision-safe pages", async () => {
    const a = await admitChat(repository, "a");
    const b = await admitChat(repository, "b");
    const tiedAt = "2026-08-25T00:10:00.123456Z";
    await sql`UPDATE chats SET activity_at = ${tiedAt}`.execute(repository.kysely);
    const first = await repository.list(owner, { limit: 1 });
    expect(first.items[0].chat.id).toBe(a.chatId);
    expect(first.nextCursor).toEqual({ activityAt: tiedAt, chatId: a.chatId });
    for (let index = 0; index < 3; index++) {
      await appendActivity(repository, a, { id: `activity_a_${index}`, occurredAt: now, type: "run.status", status: "running" });
      await appendActivity(repository, b, { id: `activity_b_${index}`, occurredAt: now, type: "run.status", status: "running" });
      await repository.updateUserState(owner, a.chatId, { pinned: false });
      expect((await repository.list(owner, { limit: 10 })).items.map(r => r.chat.id)).toEqual([a.chatId, b.chatId]);
    }
    await repository.rename(owner, a.chatId, { expectedTitleVersion: 0, title: "Manual" });
    const second = await repository.list(owner, { limit: 1, cursor: first.nextCursor });
    expect(second.items.map(r => r.chat.id)).toEqual([b.chatId]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("moves a chat only on a newly accepted user submission, not its replay or rejected submit", async () => {
    const a = await createChat(repository, "older");
    const b = await createChat(repository, "newer");
    await sql`UPDATE chats SET activity_at = '2020-01-01' WHERE id = ${a.chat.id}`.execute(repository.kysely);
    expect((await repository.list(owner, { limit: 10 })).items[0].chat.id).toBe(b.chat.id);
    const input = message(a.chat.id);
    const acceptedTurn = turn(a.chat.id, input);
    const submission = { chatId: a.chat.id, baseRevision: 0, message: input, turn: acceptedTurn, run: run(a.chat.id, acceptedTurn) };
    const accepted = await repository.admitTurn(owner, submission);
    expect((await repository.list(owner, { limit: 10 })).items[0].chat.id).toBe(a.chat.id);
    await repository.admitTurn(owner, submission);
    expect((await repository.get(owner, a.chat.id))!.chat.activityAt).toBe(accepted.chat.chat.activityAt);
    await expect(repository.admitTurn(owner, { ...submission, turn: { ...acceptedTurn, id: "cturn_rejected", clientRequestId: "req_rejected" } })).rejects.toBeDefined();
    expect((await repository.get(owner, a.chat.id))!.chat.activityAt).toBe(accepted.chat.chat.activityAt);
  });

  it("renames during streaming, rejects competing renames, protects manual titles and persists on reload", async () => {
    const admitted = await admitChat(repository, "rename");
    await appendActivity(repository, admitted, { id: "activity_stream", occurredAt: now, type: "run.status", status: "running" });
    const rename = (title: string) => repository.rename(owner, admitted.chatId, { expectedTitleVersion: 0, title });
    // PGlite uses one connection; only real Postgres supports overlapping transactions.
    const results = process.env.CHAT_TEST_DATABASE_URL
      ? await Promise.allSettled([rename("First"), rename("Second")])
      : [...await Promise.allSettled([rename("First")]), ...await Promise.allSettled([rename("Second")])];
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: expect.any(ChatConflictError) });
    const saved = (await repository.get(owner, admitted.chatId))!;
    expect(saved.chat.titleVersion).toBe(1);
    await repository.updateGeneratedTitle(owner, admitted.chatId, { expectedTitleVersion: 1, title: "Automatic" });
    await appendActivity(repository, admitted, { id: "activity_later", occurredAt: now, type: "run.status", status: "running" });
    const reloaded = new ChatRepository(repository.kysely);
    await reloaded.bootstrap();
    expect((await reloaded.get(owner, admitted.chatId))!.chat).toMatchObject({ title: saved.chat.title, titleVersion: 1, activityAt: saved.chat.activityAt });
    await expect(repository.rename(otherOwner, admitted.chatId, { expectedTitleVersion: 1, title: "Foreign" })).rejects.toBeInstanceOf(ChatNotFoundError);
  });

  it("versions automatic titles and ignores delayed automatic responses", async () => {
    const chat = await createChat(repository, "auto");
    await repository.updateGeneratedTitle(owner, chat.chat.id, { expectedTitleVersion: 0, title: "Generated" });
    expect((await repository.get(owner, chat.chat.id))!.chat).toMatchObject({ title: "Generated", titleVersion: 1 });
    await repository.updateGeneratedTitle(owner, chat.chat.id, { expectedTitleVersion: 0, title: "Stale" });
    expect((await repository.get(owner, chat.chat.id))!.chat.title).toBe("Generated");
  });
  it("migrates existing input timestamps once and preserves legacy titles", async () => {
    const a = await admitChat(repository, "legacy");
    await sql`UPDATE chats SET created_at = '2020-01-01', updated_at = '2030-01-01'`.execute(repository.kysely);
    await sql`ALTER TABLE chats DROP COLUMN activity_at, DROP COLUMN title_version, DROP COLUMN title_manual`.execute(repository.kysely);
    await sql`DROP TABLE chat_schema_migrations`.execute(repository.kysely);
    await repository.bootstrap();
    const migrated = (await repository.get(owner, a.chatId))!;
    expect(migrated.chat.activityAt).toBe(now);
    await repository.updateGeneratedTitle(owner, a.chatId, { expectedTitleVersion: 0, title: "Do not replace" });
    expect((await repository.get(owner, a.chatId))!.chat.title).toBe("legacy");
    await repository.bootstrap();
    expect((await repository.get(owner, a.chatId))!.chat.activityAt).toBe(now);
  });

  it("moves queued submissions once but not replay or run completion", async () => {
    const a = await admitChat(repository, "queued");
    await createChat(repository, "newest");
    await sql`UPDATE chats SET activity_at = '2020-01-01' WHERE id = ${a.chatId}`.execute(repository.kysely);
    const request = {
      chatId: a.chatId, baseRevision: 1, queuedTurnId: "qturn_order", clientRequestId: "req_order_queue",
      parts: [{ type: "text" as const, text: "Next message" }], driverKind: "codex" as const,
      selection: selection(), interactionMode: "default", permissionMode: "supervised",
      capabilitySnapshot: a.run.capabilitySnapshot, createdAt: now,
    };
    await repository.enqueueQueuedTurn(owner, request);
    expect((await repository.list(owner, { limit: 10 })).items[0].chat.id).toBe(a.chatId);
    const activityAt = (await repository.get(owner, a.chatId))!.chat.activityAt;
    await repository.enqueueQueuedTurn(owner, request);
    await finishChat(repository, a, "completed", "2030-01-01T00:00:00.000Z");
    expect((await repository.get(owner, a.chatId))!.chat.activityAt).toBe(activityAt);
  });

  it("records the metadata migration and skips it on subsequent bootstrap", async () => {
    const marker = await sql<{ version: number }>`SELECT version FROM chat_schema_migrations WHERE version = 1`.execute(repository.kysely);
    expect(marker.rows).toEqual([{ version: 1 }]);
    await repository.bootstrap();
    expect(Number((await sql<{ count: string }>`SELECT count(*) FROM chat_schema_migrations`.execute(repository.kysely)).rows[0].count)).toBe(2);
  });

  it("serializes overlapping metadata migrations", async () => {
    await sql`DELETE FROM chat_schema_migrations WHERE version = 1`.execute(repository.kysely);
    if (process.env.CHAT_TEST_DATABASE_URL) {
      await Promise.all([bootstrapChatMetadata(repository.kysely), bootstrapChatMetadata(repository.kysely)]);
    } else {
      await bootstrapChatMetadata(repository.kysely);
      await bootstrapChatMetadata(repository.kysely);
    }
    expect(Number((await sql<{ count: string }>`SELECT count(*) FROM chat_schema_migrations`.execute(repository.kysely)).rows[0].count)).toBe(2);
  });

});
