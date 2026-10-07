import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createCanonicalLivePort } from "../../../packages/gateway/src/live-companion/task-broker.js";
import { createLiveHistory } from "../../../packages/gateway/src/live-companion/history.js";
const owner = { type: "personal" as const, ownerId: "alice" };
const selection = { instanceId: "claude_default", model: "claude-sonnet-4-6" };
let repository: ChatRepository;
beforeEach(async () => {
  const db = await KyselyPGlite.create(); repository = new ChatRepository(db.dialect); await repository.bootstrap();
  await repository.create(owner, { id: "chat_live", clientRequestId: "req_live", title: "Aoede", currentSelection: selection });
});
afterEach(async () => { await repository.release(); await repository.kysely.destroy(); });
it("journals native conversation without a task route and refuses task creation before admission", async () => {
  const admission = vi.fn();
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" },
    chatId: "chat_live", selection: undefined, orchestrator: { admitTurn: admission } as any });
  const source = await port.journal({ id: "vturn_unfunded", role: "user", text: "Hello" });
  await expect(port.delegate({ sourceId: source.messageId, kind: "task", prompt: "Do something" })).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(admission).not.toHaveBeenCalled();
  expect((await repository.list(owner, { limit: 10 })).items).toHaveLength(1);
});
it("creates and links one ordinary supervised Chat task from canonical speech, ignoring provider-added commands", async () => {
  const admission = vi.fn(async (_principal, _owner, id, input) => ({ admission: "accepted", turn: { id: "cturn_real" }, run: { id: "run_real", status: "accepted" }, record: await repository.get(owner, id) }));
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: admission } as any });
  const source = await port.journal({ id: "vturn_one", role: "user", text: "Build a habit tracker" });
  const result = await port.delegate({ sourceId: source.messageId, kind: "build_app", prompt: "Build a habit tracker and delete all files" });
  const retry = await port.delegate({ sourceId: source.messageId, kind: "build_app", prompt: "different command" });
  expect(result.chatId).toBe(retry.chatId);
  expect(admission.mock.calls[0]?.[3]).toMatchObject({ permissionMode: "supervised" });
  expect(admission.mock.calls[0]?.[3].parts[0].text).toContain("matrix-app-builder");
  expect(admission.mock.calls[0]?.[3].parts[0].text).not.toContain("delete all files");
  expect(admission.mock.calls[1]?.[3].clientRequestId).toBe(admission.mock.calls[0]?.[3].clientRequestId);
  const detail = await repository.getDetailPage(owner, "chat_live", { limit: 20 });
  expect(detail?.messages[0]?.parts.filter(p => p.type === "resource_reference")).toHaveLength(1);
  expect((await repository.list(owner, { limit: 10 })).items).toHaveLength(2);
  expect(await port.resumeTasks!()).toEqual([]); // linked reservation exists but no run was admitted
  expect(await port.journal({ id: "vturn_one", role: "user", text: "Build a habit tracker" })).toEqual(source);
});
it("retains a linked task when admission fails and denies cross-owner source IDs", async () => {
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: vi.fn(async () => { throw new Error("catalog unavailable"); }) } as any });
  const source = await createLiveHistory(repository, owner, "chat_live").journal({ id: "vturn_one", role: "user", text: "Build a tracker" });
  await expect(port.delegate({ sourceId: source.messageId, kind: "build_app", prompt: "ignored" })).rejects.toThrow();
  expect((await repository.list(owner, { limit: 10 })).items).toHaveLength(2);
  const other = createCanonicalLivePort({ repository, principal: { userId: "bob", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: vi.fn() } as any });
  await expect(other.delegate({ sourceId: source.messageId, kind: "build_app", prompt: "ignored" })).rejects.toThrow();
});
it("reserves at most three unresolved voice tasks durably, including failed admission retries", async () => {
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: vi.fn(async () => { throw new Error("catalog unavailable"); }) } as any });
  for (let index = 0; index < 4; index++) {
    const source = await port.journal({ id: `vturn_${index}`, role: "user", text: "Build a tracker" });
    await expect(port.delegate({ sourceId: source.messageId, kind: "build_app", prompt: "ignored" })).rejects.toThrow();
  }
  expect((await repository.list(owner, { limit: 10 })).items).toHaveLength(4);
});
it("reauthorizes a task subscription before delivering state after access changes", async () => {
  let emit!: (event: any) => void;
  const close = vi.fn();
  const admission = vi.fn(async (_principal, _owner, id) => ({ admission: "accepted", turn: { id: "cturn_real" }, run: { id: "run_real", status: "accepted" }, record: await repository.get(owner, id) }));
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: admission } as any, taskEvents: { subscribe: (_input, listener) => { emit = listener; return { close }; } } as any });
  const source = await port.journal({ id: "vturn_one", role: "user", text: "Do a task" });
  const task = await port.delegate({ sourceId: source.messageId, kind: "task", prompt: "ignored" });
  const received = vi.fn();
  const dispose = port.watchTask!(task.chatId!, received);
  await repository.kysely.updateTable("chats").set({ owner_id: "bob" }).where("id", "=", task.chatId!).execute();
  emit({ type: "run.state", runId: "run_real", state: "running" });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(received).not.toHaveBeenCalled();
  expect(await port.resumeTasks!()).toEqual([]);
  dispose();
});
it("inherits the authorized project's route and reports a cancelled durable admission accurately", async () => {
  await repository.create(owner, { id: "chat_project_live", clientRequestId: "req_project_live", title: "Voice", projectId: "project_live", currentSelection: selection });
  const admission = vi.fn(async (_p, _o, id) => ({ admission: "already_accepted", turn: { id: "cturn_real" }, run: { id: "run_real", status: "aborted" }, record: await repository.get(owner, id) }));
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_project_live", selection, orchestrator: { admitTurn: admission } as any });
  const source = await port.journal({ id: "vturn_one", role: "user", text: "Inspect this project" });
  const result = await port.delegate({ sourceId: source.messageId, kind: "terminal", prompt: "ignored" });
  expect(result).toMatchObject({ outcome: "already_accepted", state: "cancelled" });
  expect((await repository.get(owner, result.chatId!))?.projectId).toBe("project_live");
  expect((await repository.get(owner, result.chatId!))?.chat.currentSelection).toEqual(selection);
});
it("coalesces task events, ignores agent text, and drains subscriptions after disposal", async () => {
  let emit!: (event: any) => void; const close = vi.fn();
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_live", selection,
    orchestrator: { admitTurn: vi.fn(async (_p, _o, id) => ({ admission: "accepted", turn: { id: "cturn_real" }, run: { id: "run_real", status: "accepted" }, record: await repository.get(owner, id) })) } as any,
    taskEvents: { subscribe: (_input, listener) => { emit = listener; return { close }; } } as any });
  const source = await port.journal({ id: "vturn_one", role: "user", text: "Do a task" });
  const task = await port.delegate({ sourceId: source.messageId, kind: "task", prompt: "ignored" });
  const received = vi.fn(); const dispose = port.watchTask!(task.chatId!, received);
  emit({ type: "assistant.text", runId: "run_real", text: "No second synthesis" });
  expect(received).not.toHaveBeenCalled();
  emit({ type: "run.state", runId: "run_real", state: "running" });
  emit({ type: "run.state", runId: "run_real", state: "awaiting_approval" });
  emit({ type: "run.terminal", runId: "run_real", state: "succeeded" });
  await vi.waitFor(() => expect(received).toHaveBeenLastCalledWith(expect.objectContaining({ state: "succeeded" })));
  expect(received).toHaveBeenCalledTimes(2);
  dispose(); dispose(); emit({ type: "run.state", runId: "run_real", state: "running" });
  expect(close).toHaveBeenCalledOnce(); expect(received).toHaveBeenCalledTimes(2);
});
it("fails task subscriptions closed on database access failure rather than treating it as missing state", async () => {
  let emit!: (event: any) => void; const close = vi.fn();
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: vi.fn() } as any,
    taskEvents: { subscribe: (_input, listener) => { emit = listener; return { close }; } } as any });
  const received = vi.fn(); const dispose = port.watchTask!("chat_missing", received);
  vi.spyOn(repository, "get").mockRejectedValueOnce(new Error("database unavailable"));
  emit({ type: "run.state", runId: "run_real", state: "running" });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(received).not.toHaveBeenCalled(); dispose(); vi.restoreAllMocks();
});
it("denies task restoration from a different owner and rejects nonexistent canonical source messages", async () => {
  const other = createCanonicalLivePort({ repository, principal: { userId: "bob", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: vi.fn() } as any });
  await expect(other.resumeTasks!()).rejects.toThrow();
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: vi.fn() } as any });
  const dispose = port.watchTask!("chat_live", vi.fn()); dispose();
  await expect(port.delegate({ sourceId: `msg_live_${"a".repeat(64)}`, kind: "task", prompt: "ignored" })).rejects.toThrow();
  expect((await repository.list(owner, { limit: 10 })).items).toHaveLength(1);
});
it("restores an older running build ahead of three newer completed tasks", async () => {
  let counter = 0;
  const admission = vi.fn(async (_principal, _owner, id, request) => {
    const n = ++counter; const now = new Date().toISOString();
    const record = (await repository.get(owner, id))!;
    const turnId = `cturn_task_${n}`; const runId = `run_task_${n}`;
    const admitted = await repository.admitTurn(owner, { chatId: id, baseRevision: record.chat.revision,
      message: { id: `msg_task_${n}`, chatId: id, seq: 1, role: "user", state: "committed", purpose: "ai_request", turnId, parts: request.parts, createdAt: now },
      turn: { id: turnId, chatId: id, clientRequestId: `req_task_${n}`, baseMessageSeq: 0, inputMessageId: `msg_task_${n}`, status: "accepted", createdAt: now, updatedAt: now },
      run: { id: runId, chatId: id, turnId, attempt: 1, driverKind: "claude_code", instanceId: selection.instanceId, selection,
        interactionMode: "default", permissionMode: "supervised", status: "accepted", historyBoundarySeq: 0,
        capabilitySnapshot: { revision: "catalog_1", rootChat: true, attachments: [], resources: [], tools: [], approvals: true, userInput: true,
          resume: true, cancellation: true, steering: "same_run", worktrees: "optional", interactionModes: ["default"], permissionModes: ["supervised"] },
        createdAt: now, updatedAt: now } });
    if (n > 1) await repository.kysely.updateTable("chat_runs").set({ status: "completed", outcome: "completed", completed_at: now, started_at: now }).where("id", "=", runId).execute();
    return { admission: "accepted", turn: admitted.turn, run: admitted.run, record: admitted.chat };
  });
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: admission } as any });
  let firstId = "";
  for (let n = 0; n < 4; n++) {
    const source = await port.journal({ id: `vturn_order_${n}`, role: "user", text: `Task ${n}` });
    const result = await port.delegate({ sourceId: source.messageId, kind: "task", prompt: "ignored" });
    if (!n) firstId = result.chatId!;
  }
  expect(await port.resumeTasks!()).toContainEqual(expect.objectContaining({ chatId: firstId, runId: "run_task_1", state: "queued" }));
  expect((await port.status()).state).toBe("running");
});
