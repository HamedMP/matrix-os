import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import { CanonicalChatDetailResponseSchema, CanonicalChatListResponseSchema } from "../../packages/contracts/src/canonical-chat-api.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { PostgresWorkspaceRepository, type WorkspaceDatabase } from "../../packages/workspace-worker/src/data/repository.js";
import { createWorkspaceRoutes } from "../../packages/workspace-worker/src/routes.js";
import { createDefaultOsViewDocument } from "../../packages/contracts/src/os-view.js";
import { R2WorkspaceFiles } from "../../packages/workspace-worker/src/data/files.js";

describe("shared API durable read/write wiring", () => {
  let engine: Awaited<ReturnType<typeof createTestPGlite>>;
  let repository: PostgresWorkspaceRepository;
  const runtime = { status: vi.fn(async () => ({ state: "sleeping" })), enqueue: vi.fn(async () => ({ queued: true })) };
  const contents = new Map<string, string>(); // Test fixture only, capped to 100 entries below.
  const files = new R2WorkspaceFiles({
    get: async (key) => contents.has(key) ? { size: new TextEncoder().encode(contents.get(key)!).byteLength, text: async () => contents.get(key)! } : null,
    put: async (key, value) => { if (contents.size >= 100) throw new Error("Test fixture full"); contents.set(key, value); },
    delete: async (key) => { contents.delete(key); },
  });
  beforeAll(async () => {
    engine = await createTestPGlite();
    repository = new PostgresWorkspaceRepository(new Kysely<WorkspaceDatabase>({ dialect: engine.dialect }));
    await repository.initialize();
  });
  afterAll(async () => { contents.clear(); await repository?.close(); if (engine && !engine.client.closed) await engine.client.close(); });
  const token = "preview_token_with_32_bytes_minimum";
  const request = (owner: string, path: string, body?: unknown, method = "GET") => {
    const app = createWorkspaceRoutes({ repository, files, runtime, auth: { previewBearer: { token, ownerId: owner } }, previewEnabled: true });
    return app.fetch(new Request(`https://shared.test${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  };
  it("persists file text without compute and retains uncertain uploads for scheduled cleanup", async () => {
    expect((await request("owner1", "/api/files/text", { path: "notes/test.txt", content: "initial", baseRevision: 0 }, "PUT")).status).toBe(200);
    expect((await request("owner1", "/api/files/text", { path: "notes/test.txt", content: "updated", baseRevision: 1 }, "PUT")).status).toBe(200);
    expect((await request("owner1", "/api/files/text", { path: "notes/test.txt", content: "stale", baseRevision: 1 }, "PUT")).status).toBe(409);
    expect(contents.size).toBe(2); // Current pointer plus an uncertain upload for the collector.
    expect(await (await request("owner1", "/api/files/text?path=notes/test.txt")).json()).toMatchObject({ content: "updated", revision: 2 });
    expect((await request("owner2", "/api/files/text?path=notes/test.txt")).status).toBe(404);
    expect(runtime.enqueue).not.toHaveBeenCalled();
  });
  it("returns actual persisted user and agent messages matching released Chat contracts", async () => {
    const response = await request("owner1", "/api/workspace/actions", { type: "chat", chatId: "chat_new", idempotencyKey: "request_new", message: "Please work" }, "POST");
    const { chatId } = await response.json() as { chatId: string };
    await repository.appendMessage("owner1", chatId, "agent_output", "assistant", "Done");
    expect(CanonicalChatListResponseSchema.safeParse(await (await request("owner1", "/api/chats")).json()).success).toBe(true);
    const detail = CanonicalChatDetailResponseSchema.parse(await (await request("owner1", `/api/chats/${chatId}?limit=200`)).json());
    expect(detail.messages.map((message) => message.parts[0])).toEqual([{ type: "text", text: "Please work" }, { type: "text", text: "Done" }]);
    expect((await request("owner2", `/api/chats/${chatId}`)).status).toBe(404);
  });
  it("reads OS view document and revision from the same SQL row snapshot", async () => {
    const owner = "os_view_get_race";
    const original = createDefaultOsViewDocument();
    const newer = { ...original, pinnedApps: ["files"] };
    await repository.saveSetting(owner, "osView", { document: original }, 0);
    let updated = false;
    let release: () => void;
    const changed = new Promise<void>((resolve) => { release = resolve; });
    const racingRepository = new Proxy(repository, { get(target, property) {
      if (property === "settings" || property === "settingsSnapshot") return async (id: string) => {
        const result = await (target as unknown as Record<string, (owner: string) => Promise<unknown>>)[property](id);
        if (!updated) { updated = true; await target.saveSetting(owner, "osView", { document: newer }, 1); release(); }
        return result;
      };
      if (property === "bootstrap") return async (id: string) => { await changed; return target.bootstrap(id); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const app = createWorkspaceRoutes({ repository: racingRepository, files, runtime, auth: { previewBearer: { token, ownerId: owner } }, previewEnabled: true });
    const response = await app.fetch(new Request("https://shared.test/api/os-view-state", { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    const state = await response.json() as { revision: number; document: { pinnedApps: string[] } };
    // A pre-write snapshot is valid, but must carry its own revision.
    expect(state).toMatchObject({ revision: 2, document: { pinnedApps: [] } });
    expect((await repository.bootstrap(owner)).revision).toBe(2);
  });
  it.each([2, 3])("rejects OS view patch revision %s when a concurrent saved edit wins", async (baseRevision) => {
    const owner = `os_view_patch_race_${baseRevision}`;
    const original = createDefaultOsViewDocument();
    const newer = { ...original, pinnedApps: ["files"] };
    await repository.saveSetting(owner, "osView", { document: original }, 0);
    let updated = false;
    let release: () => void;
    const changed = new Promise<void>((resolve) => { release = resolve; });
    const racingRepository = new Proxy(repository, { get(target, property) {
      if (property === "settings" || property === "settingsSnapshot") return async (id: string) => {
        const result = await (target as unknown as Record<string, (owner: string) => Promise<unknown>>)[property](id);
        if (!updated) { updated = true; await target.saveSetting(owner, "osView", { document: newer }, 1); release(); }
        return result;
      };
      if (property === "bootstrap") return async (id: string) => { await changed; return target.bootstrap(id); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const app = createWorkspaceRoutes({ repository: racingRepository, files, runtime, auth: { previewBearer: { token, ownerId: owner } }, previewEnabled: true });
    const response = await app.fetch(new Request("https://shared.test/api/os-view-state", { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({
      baseRevision, mutationId: `osvm_${"a".repeat(32)}`, patch: { canvas: { transform: { panX: 42, panY: 0, zoom: 1 } } },
    }) }));
    expect(response.status).toBe(409);
    expect((await repository.settings(owner)).osView).toMatchObject({ document: { pinnedApps: ["files"] } });
    expect((await repository.bootstrap(owner)).revision).toBe(2);
  });

  it("retains a newly referenced object when a file commit acknowledgement is lost",async()=>{
    const owner="lost_file_ack";
    const commit=repository.commitFile.bind(repository);
    const uncertain=new Proxy(repository,{get(target,property){
      if(property==="commitFile")return async (...args:Parameters<typeof commit>)=>{await commit(...args);throw new Error("acknowledgement lost");};
      const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;
    }});
    const app=createWorkspaceRoutes({repository:uncertain,files,runtime,auth:{previewBearer:{token,ownerId:owner}},previewEnabled:true});
    const response=await app.fetch(new Request("https://shared.test/api/files/text",{method:"PUT",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({path:"saved.txt",content:"durable",baseRevision:0})}));
    expect(response.status).toBe(503);
    const pointer=await repository.file(owner,"saved.txt");
    expect(pointer).not.toBeNull();
    expect(await files.read(pointer!.objectKey)).toBe("durable");
  });
  it("applies the directory limit after grouping immediate children",async()=>{
    for(let index=0;index<51;index++)await repository.commitFile("grouped_files",`a/${String(index).padStart(2,"0")}.txt`,`grouped-${index}`,1,0);
    await repository.commitFile("grouped_files","z.txt","grouped-last",1,0);
    const response=await request("grouped_files","/api/files/list?limit=50");
    expect((await response.json() as {entries:{name:string}[]}).entries.map(entry=>entry.name)).toEqual(["a","z.txt"]);
  });

});
