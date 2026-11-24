import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KyselyPGlite } from "kysely-pglite";
import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

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

describe("ChatRepository archive and search", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;

  beforeEach(async () => {
    pglite = await createTestPGlite();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.kysely.destroy();
  });

  it("finds archived and active chats by title, with an owner-scoped lifecycle filter", async () => {
    const archived = await repository.create(owner, {
      id: "chat_search_archived_title",
      clientRequestId: "req_search_archived_title",
      title: "Constellation notes",
    });
    await repository.update(owner, archived.chat.id, { baseRevision: archived.chat.revision, lifecycle: "archived" });
    const active = await repository.create(owner, {
      id: "chat_search_active_title",
      clientRequestId: "req_search_active_title",
      title: "Constellation draft",
    });
    await repository.create(otherOwner, {
      id: "chat_search_foreign_title",
      clientRequestId: "req_search_foreign_title",
      title: "Constellation private",
    });

    expect((await repository.search(owner, "Constellation", 20, undefined, "active")).map(item => item.chat.id))
      .toEqual([active.chat.id]);
    expect((await repository.search(owner, "Constellation", 20, undefined, "archived")).map(item => item.chat.id))
      .toEqual([archived.chat.id]);
  });

  it("pages matching chats in stable update-time and ID order", async () => {
    const first = await repository.create(owner, {
      id: "chat_search_page_a", clientRequestId: "req_search_page_a", title: "Nebula one",
    });
    const second = await repository.create(owner, {
      id: "chat_search_page_b", clientRequestId: "req_search_page_b", title: "Nebula two",
    });
    const firstPage = await repository.search(owner, "Nebula", 1);
    expect(firstPage).toHaveLength(1);
    const cursor = { updatedAt: firstPage[0]!.chat.updatedAt, chatId: firstPage[0]!.chat.id };
    const secondPage = await repository.search(owner, "Nebula", 1, undefined, "active", cursor);
    expect(secondPage).toHaveLength(1);
    expect(new Set([firstPage[0]!.chat.id, secondPage[0]!.chat.id]))
      .toEqual(new Set([first.chat.id, second.chat.id]));
  });

  it("archives all idle project chats atomically and reports running chats for Undo", async () => {
    const idle = await repository.create(owner, {
      id: "chat_project_archive_idle", clientRequestId: "req_project_archive_idle",
      title: "Idle", projectId: "project_archive",
    });
    const running = await repository.create(owner, {
      id: "chat_project_archive_running", clientRequestId: "req_project_archive_running",
      title: "Running", projectId: "project_archive",
    });
    const input = message(running.chat.id);
    const acceptedTurn = turn(running.chat.id, input);
    await repository.admitTurn(owner, {
      chatId: running.chat.id, baseRevision: 0, message: input,
      turn: acceptedTurn, run: run(running.chat.id, acceptedTurn),
    });
    const result = await repository.archiveProjectChats(owner, "project_archive");
    expect(result).toEqual({ archivedIds: [idle.chat.id], archived: [{ chatId: idle.chat.id, revision: idle.chat.revision + 1 }], skippedIds: [running.chat.id], archivedCount: 1, skippedCount: 1 });
    expect((await repository.get(owner, idle.chat.id))?.chat.lifecycle).toBe("archived");
    expect((await repository.get(owner, idle.chat.id))?.chat.archivedAt).toBeTruthy();
    expect((await repository.get(owner, running.chat.id))?.chat.lifecycle).toBe("active");
  });

});
