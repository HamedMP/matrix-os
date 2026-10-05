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
it("creates and links one ordinary supervised Chat task from canonical speech, ignoring provider-added commands", async () => {
  const admission = vi.fn(async (_principal, _owner, id, input) => ({ admission: "accepted", turn: { id: "cturn_real" }, run: { id: "run_real" }, record: await repository.get(owner, id) }));
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
  const admission = vi.fn(async (_principal, _owner, id) => ({ admission: "accepted", turn: { id: "cturn_real" }, run: { id: "run_real" }, record: await repository.get(owner, id) }));
  const port = createCanonicalLivePort({ repository, principal: { userId: "alice", source: "jwt" }, chatId: "chat_live", selection, orchestrator: { admitTurn: admission } as any, taskEvents: { subscribe: (_input, listener) => { emit = listener; return { close }; } } as any });
  const source = await port.journal({ id: "vturn_one", role: "user", text: "Do a task" });
  const task = await port.delegate({ sourceId: source.messageId, kind: "task", prompt: "ignored" });
  const received = vi.fn();
  const dispose = port.watchTask!(task.chatId!, received);
  await repository.kysely.updateTable("chats").set({ owner_id: "bob" }).where("id", "=", task.chatId!).execute();
  emit({ type: "run.state", runId: "run_real", state: "running" });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(received).not.toHaveBeenCalled();
  dispose();
});
