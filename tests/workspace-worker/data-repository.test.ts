import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { PostgresWorkspaceRepository, type WorkspaceDatabase } from "../../packages/workspace-worker/src/data/repository.js";

describe("shared owner data repository", () => {
  let engine: Awaited<ReturnType<typeof createTestPGlite>>;
  let repository: PostgresWorkspaceRepository;
  beforeAll(async () => {
    engine = await createTestPGlite();
    repository = new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({ dialect: engine.dialect }));
    await repository.initialize();
  });
  afterAll(async () => { await repository?.close(); if (engine && !engine.client.closed) await engine.client.close(); });
  it("creates an empty workspace idempotently and isolates owners", async () => {
    expect((await repository.bootstrap("owner_a")).layout).toEqual({ windows: [] });
    await repository.saveLayout("owner_a", { windows: [{ id: "notes" }] }, 0);
    expect((await repository.bootstrap("owner_b")).layout).toEqual({ windows: [] });
    expect((await repository.bootstrap("owner_a")).layout.windows).toHaveLength(1);
  });
  it("checks revision in the write and does not overwrite stale layout", async () => {
    await expect(repository.saveLayout("owner_a", { windows: [] }, 0)).rejects.toMatchObject({ code: "conflict" });
    expect((await repository.bootstrap("owner_a")).layout.windows).toHaveLength(1);
  });
  it("creates owner scoped chats once per request and hides other owners", async () => {
    const first = await repository.createChat("owner_a", "req_same", "Hello");
    const second = await repository.createChat("owner_a", "req_same", "Changed");
    expect(second.id).toBe(first.id);
    expect((await repository.listChats("owner_a", 50))).toHaveLength(1);
    expect(await repository.chat("owner_b", first.id)).toBeNull();
  });
  it("conditionally publishes immutable file pointers", async () => {
    await repository.commitFile("owner_a", "notes/hello.txt", "key-a", 5, 0);
    expect(await repository.file("owner_b", "notes/hello.txt")).toBeNull();
    await expect(repository.commitFile("owner_a", "notes/hello.txt", "key-stale", 4, 0)).rejects.toMatchObject({ code: "conflict" });
    expect((await repository.file("owner_a", "notes/hello.txt"))?.objectKey).toBe("key-a");
  });
});

describe("bounded durable agent publication", () => {
  it("refuses stale generations before publishing output", async () => {
    const engine = await createTestPGlite();
    const repository = new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({ dialect: engine.dialect }));
    await repository.initialize();
    const { PostgresRuntimeStore } = await import("../../packages/workspace-worker/src/data/runtime-store.js");
    const store = new PostgresRuntimeStore(repository.db); await store.initialize();
    const chat = await repository.createChat("agent_owner", "request1", "Work");
    const lease = (await store.claim({ ownerId: "agent_owner", jobId: "agent1", type: "chat", chatId: chat.id }, 100, 1000, 5000))!;
    await expect(repository.publishOutput({ ...lease, generation: 99 }, { text: "wrong", files: [] }, 200)).rejects.toMatchObject({ code: "conflict" });
    expect(await repository.publishOutput(lease, { text: "done", files: [{ path: "spike-result.txt", objectKey: "r2result", bytes: 2, baseRevision: 0 }] }, 200)).toBe(true);
    expect((await repository.messages("agent_owner", chat.id))[0]).toMatchObject({ role: "assistant", text: "done" });
    expect(await repository.messages("another_owner", chat.id)).toEqual([]);
    expect((await repository.file("agent_owner", "spike-result.txt"))?.objectKey).toBe("r2result");
    // Retry after uncertain acknowledgement has no second message/file mutation.
    expect(await repository.publishOutput(lease, { text: "done", files: [{ path: "spike-result.txt", objectKey: "r2retry", bytes: 2, baseRevision: 0 }] }, 200)).toBe(false);
    expect(await repository.messages("agent_owner", chat.id)).toHaveLength(1);
    await store.finish(lease, "completed", 250);
    const next = (await store.claim({ ownerId: "agent_owner", jobId: "agent2", type: "chat", chatId: chat.id }, 300, 1000, 5000))!;
    await repository.commitFile("agent_owner", "spike-result.txt", "browser-edit", 7, 1);
    await expect(repository.publishOutput(next, { text: "stale output", files: [
      { path: "new-file.txt", objectKey: "would-be-new", bytes: 3, baseRevision: 0 },
      { path: "spike-result.txt", objectKey: "would-overwrite", bytes: 4, baseRevision: 1 },
    ] }, 350)).rejects.toMatchObject({ code: "conflict" });
    expect(await repository.file("agent_owner", "new-file.txt")).toBeNull();
    expect((await repository.file("agent_owner", "spike-result.txt"))?.objectKey).toBe("browser-edit");
    expect(await repository.messages("agent_owner", chat.id)).toHaveLength(1);
    await repository.close(); if (!engine.client.closed) await engine.client.close();
  });
});
