import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "user_artifact_owner" };
const now = "2026-09-22T12:00:00.000Z";

describe("canonical Chat artifacts", () => {
  let database: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;

  beforeEach(async () => {
    database = await KyselyPGlite.create();
    repository = new ChatRepository(database.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.kysely.destroy();
  });

  async function admit() {
    const created = await repository.create(owner, {
      id: "chat_artifact_1",
      clientRequestId: "req_create_artifact_1",
      title: "Artifact fixture",
    });
    const message: CanonicalChatMessage = {
      id: "msg_artifact_input",
      chatId: created.chat.id,
      seq: 1,
      role: "user",
      state: "committed",
      purpose: "ai_request",
      turnId: "cturn_artifact_1",
      parts: [{ type: "text", text: "Generate an image" }],
      createdAt: now,
    };
    const turn: CanonicalChatTurn = {
      id: "cturn_artifact_1",
      chatId: created.chat.id,
      clientRequestId: "req_turn_artifact_1",
      baseMessageSeq: 0,
      inputMessageId: message.id,
      status: "accepted",
      createdAt: now,
      updatedAt: now,
    };
    const run: CanonicalChatRun = {
      id: "run_artifact_1",
      chatId: created.chat.id,
      turnId: turn.id,
      attempt: 1,
      driverKind: "codex",
      instanceId: "codex_default",
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      status: "accepted",
      historyBoundarySeq: 0,
      capabilitySnapshot: {
        revision: "catalog_artifacts",
        rootChat: true,
        attachments: ["file"],
        resources: ["file"],
        tools: ["read"],
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
    await repository.admitTurn(owner, {
      chatId: created.chat.id,
      baseRevision: created.chat.revision,
      message,
      turn,
      run,
    });
    return { chatId: created.chat.id, runId: run.id };
  }

  it("keeps one captured artifact across replay and reload", async () => {
    const admitted = await admit();
    const artifactPath = `data/chat-artifacts/codex/sha256/${"a".repeat(64)}.png`;
    const input = {
      ...admitted,
      messageId: "msg_artifact_1_assistant",
      attachment: {
        id: "attachment_codex_fixture",
        kind: "image" as const,
        label: "whale.png",
        path: artifactPath,
        mimeType: "image/png",
        sizeBytes: 12,
      },
      createdAt: now,
    };

    const first = await repository.appendAssistantAttachment(owner, input);
    const revisionAfterFirst = (await repository.get(owner, admitted.chatId)).chat.revision;
    await repository.kysely.deleteFrom("chat_attachments")
      .where("id", "=", input.attachment.id).execute();
    const replay = await repository.appendAssistantAttachment(owner, input);

    expect(replay).toEqual(first);
    expect((await repository.get(owner, admitted.chatId)).chat.revision).toBe(revisionAfterFirst);
    expect(first.parts).toEqual([expect.objectContaining({
      type: "attachment_reference",
      attachmentId: "attachment_codex_fixture",
      resource: {
        kind: "home",
        path: artifactPath,
      },
    })]);
    await expect(repository.ownsAttachmentPath(owner, artifactPath)).resolves.toBe(true);
    await expect(repository.ownsAttachmentPath(
      { type: "personal", ownerId: "user_other" },
      artifactPath,
    )).resolves.toBe(false);
    await expect(repository.ownsAttachmentPath(owner, "projects/private.txt")).resolves.toBe(false);
    const rows = await repository.kysely.selectFrom("chat_attachments").selectAll().execute();
    expect(rows).toHaveLength(1);

    await repository.finishRun(owner, { ...admitted, outcome: "completed", completedAt: now });
    const messages = await repository.getMessages(owner, admitted.chatId, { afterSeq: 0, limit: 20 });
    expect(messages.find((message) => message.id === input.messageId)).toMatchObject({
      state: "committed",
      parts: [expect.objectContaining({ attachmentId: "attachment_codex_fixture" })],
    });
  });

  it("keeps the first eight attachments and ignores later ones without failing the run", async () => {
    const admitted = await admit();
    const messageId = "msg_artifact_1_assistant";
    for (let index = 0; index < 8; index += 1) {
      await repository.appendAssistantAttachment(owner, {
        ...admitted,
        messageId,
        attachment: {
          id: `attachment_codex_${index}`,
          kind: "image",
          label: `${index}.png`,
          path: `data/chat-artifacts/codex/sha256/${String(index).repeat(64)}.png`,
        },
        createdAt: now,
      });
    }
    const revision = (await repository.get(owner, admitted.chatId)).chat.revision;
    const capped = await repository.appendAssistantAttachment(owner, {
      ...admitted,
      messageId,
      attachment: {
        id: "attachment_codex_ninth",
        kind: "image",
        label: "ninth.png",
        path: `data/chat-artifacts/codex/sha256/${"f".repeat(64)}.png`,
      },
      createdAt: now,
    });
    expect(capped.parts.filter((part) => part.type === "attachment_reference")).toHaveLength(8);
    expect((await repository.get(owner, admitted.chatId)).chat.revision).toBe(revision);
    expect(await repository.kysely.selectFrom("chat_attachments").selectAll().execute()).toHaveLength(8);
    await expect(repository.finishRun(owner, { ...admitted, outcome: "completed", completedAt: now })).resolves.toBeDefined();
  });
});
