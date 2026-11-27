import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KyselyPGlite } from "kysely-pglite";
import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { backfillCodexGeneratedImages } from "../../packages/gateway/src/chat/codex-image-backfill.js";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";

// A Codex Chat made before ENG-594: the image is on disk under Codex's home,
// but the run never captured it, so the reply shows no picture.
const owner = { type: "personal" as const, ownerId: "user_backfill_owner" };
const chatId = "chat_backfill_1";
const runId = "run_backfill_1";
const conversation = "36f2e995-4658-4d21-b4a9-dc07530d9dbb";
const nativeThread = "01a219db-acf0-7cf3-9f4f-89db54fffe46";
const started = new Date("2026-11-26T21:55:55.000Z");
const finished = new Date("2026-11-26T21:57:02.000Z");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

describe("recovering Codex images that earlier runs did not keep", () => {
  let database: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;
  let homePath: string;
  let codexHome: string;
  let imageDirectory: string;

  beforeEach(async () => {
    database = await KyselyPGlite.create();
    repository = new ChatRepository(database.dialect);
    await repository.bootstrap();
    homePath = await mkdtemp(join(tmpdir(), "codex-backfill-"));
    codexHome = join(homePath, ".codex");
    imageDirectory = join(codexHome, "generated_images", nativeThread);
    await mkdir(imageDirectory, { recursive: true });
    await finishedCodexRun();
    const journal = codexProviderEventPath(homePath, `sess_${conversation}`);
    await mkdir(join(journal, ".."), { recursive: true });
    await writeFile(journal, [
      JSON.stringify({ type: "thread.started", thread_id: nativeThread }),
      JSON.stringify({ type: "matrix.codex.assistant.completed", messageId: "codex_item_1" }),
    ].join("\n"));
  });

  afterEach(async () => {
    await repository.kysely.destroy();
    await rm(homePath, { recursive: true, force: true });
  });

  async function finishedCodexRun(input: { n?: number; from?: Date; to?: Date } = {}) {
    const n = input.n ?? 1;
    const from = input.from ?? started;
    const to = input.to ?? finished;
    const id = n === 1 ? runId : `run_backfill_${n}`;
    const turnId = `cturn_backfill_${n}`;
    const existing = n === 1 ? null : await repository.get(owner, chatId);
    const created = existing ?? (await repository.create(owner, { id: chatId, clientRequestId: "req_create_backfill", title: "Speaker concepts" }));
    const seq = existing ? (await repository.getMessages(owner, chatId, { afterSeq: 0, limit: 50 })).length + 1 : 1;
    const message: CanonicalChatMessage = {
      id: `msg_backfill_input_${n}`, chatId, seq, role: "user", state: "committed", purpose: "ai_request",
      turnId, parts: [{ type: "text", text: "Generate an image" }], createdAt: from.toISOString(),
    };
    const turn: CanonicalChatTurn = {
      id: turnId, chatId, clientRequestId: `req_turn_backfill_${n}`, baseMessageSeq: seq - 1,
      inputMessageId: message.id, status: "accepted", createdAt: from.toISOString(), updatedAt: from.toISOString(),
    };
    const run: CanonicalChatRun = {
      id, chatId, turnId: turn.id, attempt: 1, driverKind: "codex", instanceId: "codex_default",
      selection: { instanceId: "codex_default", model: "gpt-6.2-sol" }, interactionMode: "default",
      permissionMode: "supervised", status: "accepted", historyBoundarySeq: seq - 1,
      capabilitySnapshot: {
        revision: "catalog_backfill", rootChat: true, attachments: ["file"], resources: ["file"], tools: ["read"],
        approvals: true, userInput: true, resume: true, cancellation: true, steering: "same_run",
        worktrees: "optional", interactionModes: ["default"], permissionModes: ["supervised"],
      },
      createdAt: from.toISOString(), updatedAt: from.toISOString(),
    };
    await repository.admitTurn(owner, { chatId, baseRevision: created.chat.revision, message, turn, run });
    await repository.markRunRunning(owner, { chatId, runId: id, startedAt: from.toISOString() });
    await repository.updateAdapterState(owner, {
      chatId, runId: id, driverKind: "codex", instanceId: "codex_default", schemaVersion: 1,
      state: { runId: id, conversationId: `thread_${conversation}` },
    });
    for (const [messageId, delta] of [[`msg_backfill_${n}_a`, "I’ll make a concept board."], [`msg_backfill_${n}_b`, "Here are six designs."]]) {
      await repository.appendAssistantDelta(owner, { chatId, runId: id, messageId, delta, createdAt: from.toISOString() });
    }
    await repository.finishRun(owner, { chatId, runId: id, outcome: "completed", completedAt: to.toISOString() });
    return id;
  }

  async function image(name: string, writtenAt: Date, bytes = png) {
    const path = join(imageDirectory, name);
    await writeFile(path, bytes);
    await utimes(path, writtenAt, writtenAt);
    return path;
  }

  async function replies(run = runId) {
    const messages = await repository.getMessages(owner, chatId, { afterSeq: 0, limit: 50 });
    return messages.filter((message) => message.role === "assistant" && message.runId === run);
  }

  const attachmentsOf = (message: CanonicalChatMessage) => message.parts.filter((part) => part.type === "attachment_reference");

  it("puts an image made during a run on that run's final reply, stored in the owner's home", async () => {
    await image("exec-a680a236.png", new Date("2026-11-26T21:56:40.000Z"));
    const revisionBefore = (await repository.get(owner, chatId)).chat.revision;

    const result = await backfillCodexGeneratedImages({ repository, homePath, codexHome });

    expect(result).toEqual({ status: "completed", attached: 1 });
    const [first, last] = await replies();
    expect(first.parts.some((part) => part.type === "attachment_reference")).toBe(false);
    const attachment = last.parts.find((part) => part.type === "attachment_reference");
    expect(attachment).toMatchObject({
      kind: "image", label: "exec-a680a236.png", mimeType: "image/png", sizeBytes: png.length,
      ownerReference: expect.stringMatching(/^data\/chat-artifacts\/codex\/sha256\/[a-f0-9]{64}\.png$/),
    });
    expect(await readFile(join(homePath, (attachment as { ownerReference: string }).ownerReference))).toEqual(png);
    // The file is servable to the owner, like a live-captured artifact.
    await expect(repository.ownsAttachmentPath(owner, (attachment as { ownerReference: string }).ownerReference)).resolves.toBe(true);
    expect((await repository.get(owner, chatId)).chat.revision).toBe(revisionBefore + 1);
  });

  it("runs once per home and never attaches the same image twice", async () => {
    await image("exec-a680a236.png", new Date("2026-11-26T21:56:40.000Z"));
    await backfillCodexGeneratedImages({ repository, homePath, codexHome });

    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome }))
      .resolves.toEqual({ status: "already_done", attached: 0 });
    await rm(join(homePath, "system", "chat-repairs"), { recursive: true });
    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome }))
      .resolves.toEqual({ status: "completed", attached: 0 });
    const last = (await replies()).at(-1)!;
    expect(last.parts.filter((part) => part.type === "attachment_reference")).toHaveLength(1);
  });

  it("leaves images written outside every run, links and non-images alone", async () => {
    await image("exec-later.png", new Date("2026-11-26T23:00:00.000Z"));
    await image("notes.txt", new Date("2026-11-26T21:56:40.000Z"), Buffer.from("text"));
    const secret = join(codexHome, "auth.json");
    await writeFile(secret, "{\"token\":\"private\"}");
    await symlink(secret, join(imageDirectory, "exec-link.png"));

    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome }))
      .resolves.toEqual({ status: "completed", attached: 0 });
    const last = (await replies()).at(-1)!;
    expect(last.parts.some((part) => part.type === "attachment_reference")).toBe(false);
  });

  it("finishes without a generated_images folder, and stops when asked to", async () => {
    await rm(join(codexHome, "generated_images"), { recursive: true });
    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome }))
      .resolves.toEqual({ status: "completed", attached: 0 });

    await rm(join(homePath, "system", "chat-repairs"), { recursive: true });
    const controller = new AbortController();
    controller.abort();
    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome, signal: controller.signal }))
      .resolves.toEqual({ status: "aborted", attached: 0 });
  });
  it("gives an image made in a quick follow-up to that run, not the one that just finished", async () => {
    // Run 1 finished at 21:57:02; run 2 starts 10 s later and writes its image
    // inside run 1's grace period. Run 2's own window must win.
    const followUp = await finishedCodexRun({
      n: 2, from: new Date("2026-11-26T21:57:12.000Z"), to: new Date("2026-11-26T21:58:30.000Z"),
    });
    await image("exec-follow-up.png", new Date("2026-11-26T21:57:20.000Z"));

    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome }))
      .resolves.toEqual({ status: "completed", attached: 1 });
    expect(attachmentsOf((await replies(runId)).at(-1)!)).toHaveLength(0);
    expect(attachmentsOf((await replies(followUp)).at(-1)!)).toEqual([expect.objectContaining({ label: "exec-follow-up.png" })]);
  });

  it("tells open clients which run's reply changed, so the image appears without a reload", async () => {
    await image("exec-a680a236.png", new Date("2026-11-26T21:56:40.000Z"));
    await backfillCodexGeneratedImages({ repository, homePath, codexHome });

    const events = await repository.replayOutbox(owner, { afterCursor: 0, limit: 200 });
    const repair = events.filter((event) => event.eventType === "chat.updated").at(-1)!;
    expect(repair.payload).toMatchObject({ runId, messageId: (await replies()).at(-1)!.id });
  });

  it("does not add an image the reply already shows under another attachment ID", async () => {
    const path = await image("exec-a680a236.png", new Date("2026-11-26T21:56:40.000Z"));
    // As live capture stores it: same content-addressed file, ID from the Codex item.
    await backfillCodexGeneratedImages({ repository, homePath, codexHome });
    const [stored] = attachmentsOf((await replies()).at(-1)!) as Array<{ ownerReference: string }>;
    await rm(join(homePath, "system", "chat-repairs"), { recursive: true });
    await rm(path);
    await image("exec-renamed-copy.png", new Date("2026-11-26T21:56:41.000Z"));

    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome }))
      .resolves.toEqual({ status: "completed", attached: 0 });
    expect(attachmentsOf((await replies()).at(-1)!)).toEqual([expect.objectContaining({ ownerReference: stored.ownerReference })]);
  });

  it("leaves the marker unwritten when a scan limit cuts work off, so the next start finishes it", async () => {
    await image("exec-1.png", new Date("2026-11-26T21:56:10.000Z"));
    await image("exec-2.png", new Date("2026-11-26T21:56:20.000Z"), Buffer.concat([png, Buffer.from([4])]));

    // The earliest image is still recovered; attaching is idempotent.
    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome, limits: { imagesPerThread: 1 } }))
      .resolves.toEqual({ status: "incomplete", attached: 1 });
    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome, limits: { runs: 0 } }))
      .resolves.toEqual({ status: "incomplete", attached: 0 });
    await expect(backfillCodexGeneratedImages({ repository, homePath, codexHome }))
      .resolves.toEqual({ status: "completed", attached: 1 });
    expect(attachmentsOf((await replies()).at(-1)!)).toHaveLength(2);
  });
});
