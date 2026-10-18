import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, sql } from "kysely";
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


describe("atomic Chat input admission",()=>{
  let engine:Awaited<ReturnType<typeof createTestPGlite>>;
  let repository:PostgresWorkspaceRepository;
  beforeAll(async()=>{engine=await createTestPGlite();repository=new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({dialect:engine.dialect}));await repository.initialize();});
  afterAll(async()=>{await repository?.close();if(engine&&!engine.client.closed)await engine.client.close();});
  it("deduplicates a retried new Chat and first input in one owner transaction",async()=>{
    const input={chatId:"chat_client",idempotencyKey:"request_atomic",message:"Run once"};
    const first=await repository.admitChatMessage("atomic_owner",input);
    const retry=await repository.admitChatMessage("atomic_owner",input);
    expect(retry.id).toBe(first.id);
    const concurrent=await Promise.all([
      repository.admitChatMessage("atomic_parallel",input),
      repository.admitChatMessage("atomic_parallel",input),
    ]);
    expect(concurrent[0].id).toBe(concurrent[1].id);
    expect(await repository.messages("atomic_parallel",concurrent[0].id)).toHaveLength(1);
    expect(await repository.listChats("atomic_owner",100)).toHaveLength(1);
    expect(await repository.messages("atomic_owner",first.id)).toHaveLength(1);
    await expect(repository.admitChatMessage("atomic_owner",{...input,message:"Changed"})).rejects.toMatchObject({code:"conflict"});
    const other=await repository.createChat("atomic_owner","another_chat","Other");
    expect((await repository.admitChatMessage("atomic_owner",{...input,chatId:other.id})).id).toBe(first.id);
    expect(await repository.messages("atomic_owner",other.id)).toHaveLength(0);
  });
  it("rolls back a new Chat if the first input insert fails",async()=>{
    await repository.db.schema.alterTable("shared_chat_messages").addCheckConstraint("reject_first_input",sql`text <> 'reject_first_input'`).execute();
    await expect(repository.admitChatMessage("rollback_owner",{chatId:"chat_client",idempotencyKey:"request_rollback",message:"reject_first_input"})).rejects.toThrow();
    expect(await repository.listChats("rollback_owner",100)).toEqual([]);
    expect(await repository.db.selectFrom("shared_chat_messages").selectAll().where("owner_id","=","rollback_owner").execute()).toEqual([]);
  });
  it("returns the newest bounded message window in ascending presentation order",async()=>{
    const chat=await repository.createChat("latest_owner","request_latest","Latest");
    await repository.db.insertInto("shared_chat_messages").values(Array.from({length:205},(_,index)=>({
      owner_id:"latest_owner",chat_id:chat.id,request_id:`request_${index}`,id:`msg_${index}`,seq:index+1,role:"assistant",text:`message ${index+1}`,created_at:new Date().toISOString(),
    }))).execute();
    const messages=await repository.messages("latest_owner",chat.id);
    expect(messages).toHaveLength(200);
    expect(messages[0].seq).toBe(6);
    expect(messages.at(-1)?.text).toBe("message 205");
    expect(messages.map(message=>message.seq)).toEqual(Array.from({length:200},(_,index)=>index+6));
  });
});
