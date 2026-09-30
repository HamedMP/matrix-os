import { KyselyPGlite } from "kysely-pglite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createChatDriveProjectRoutes } from "../../packages/gateway/src/chat/drive-projects.js";
const owner = { type: "personal" as const, ownerId: "user_projects" };
const reference = { kind: "drive" as const, organizationId: "org_company", scopeId: "00000000-0000-4000-8000-000000000001" };
const request = { baseRevision: 0, clientRequestId: "req_associate", reference };
const json = (body: unknown) => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
describe("owner-persisted company drive Chat projects", () => {
    let repository: ChatRepository;
    let app: Awaited<ReturnType<typeof createChatDriveProjectRoutes>>;
    let actor: string;
    let authorize: ReturnType<typeof vi.fn>;
    beforeEach(async () => { repository = new ChatRepository((await KyselyPGlite.create()).dialect); await repository.bootstrap(); await repository.create(owner, { id: "chat_project", clientRequestId: "req_create", title: "Private plan" }); actor = owner.ownerId; authorize = vi.fn(async () => undefined); app = await createChatDriveProjectRoutes({ repository, drives: { authorize }, resolveOwner: () => ({ type: "personal", ownerId: actor }) }); });
    afterEach(async () => { await repository.kysely.destroy(); });
    it("persists an idempotent private association and its revision event together", async () => {
        const events: unknown[] = [];
        const sink = repository.registerOutboxSink(event => { events.push(event); });
        const first = await app.request('/api/chats/chat_project/drive-project', json(request));
        expect(first.status).toBe(200);
        expect(await first.json()).toMatchObject({ chatId: "chat_project", reference, revision: 1 });
        expect(authorize).toHaveBeenCalledWith(owner, "chat_project", [reference], expect.anything());
        expect((await repository.get(owner, "chat_project"))?.chat.collaboration).toBeUndefined();
        expect((await repository.get(owner, "chat_project"))?.projectId).toBeUndefined();
        expect(events).toHaveLength(1);
        expect((await app.request('/api/chats/chat_project/drive-project', json(request))).status).toBe(200);
        expect(events).toHaveLength(1);
        expect((await app.request('/api/chats/chat_project/drive-project', json({ ...request, reference: null }))).status).toBe(409);
        const lookup = await app.request('/api/chat-drive-projects/lookup', { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatIds: ["chat_project"] }) });
        expect(await lookup.json()).toMatchObject({ associations: [{ chatId: "chat_project", reference }] });
        sink.dispose();
    });
    it("keeps authorization reads and the association write in one scoped transaction", async()=>{
        authorize.mockImplementationOnce(async (_owner,_chatId,_references,scoped)=>{
          expect(scoped).toBeDefined();
          expect(scoped.kysely.isTransaction).toBe(true);
          expect((await scoped.get(owner,"chat_project"))?.chat.id).toBe("chat_project");
        });
        expect((await app.request('/api/chats/chat_project/drive-project',json(request))).status).toBe(200);
    });
    it("rejects stale writes, other owners, shared Chats and ungranted sources", async () => {
        actor = "user_other";
        expect((await app.request('/api/chats/chat_project/drive-project', json(request))).status).toBe(404);
        expect(authorize).not.toHaveBeenCalled();
        actor = owner.ownerId;
        expect((await app.request('/api/chats/chat_project/drive-project', json({ ...request, baseRevision: 9 }))).status).toBe(409);
        authorize.mockRejectedValueOnce(new Error("Revoked membership"));
        expect((await app.request('/api/chats/chat_project/drive-project', json(request))).status).toBe(503);
        await repository.kysely.updateTable("chats").set({ collaboration: { scopeId: reference.scopeId, mode: "discussion_only", executionFenced: true } }).where("id", "=", "chat_project").execute();
        expect((await app.request('/api/chats/chat_project/drive-project', json(request))).status).toBe(409);
    });
    it("validates every boundary and rechecks a sharing transition after source I/O", async () => {
        expect((await app.request('/api/chats/invalid/drive-project', json(request))).status).toBe(422);
        expect((await app.request('/api/chats/chat_project/drive-project?actor=other', json(request))).status).toBe(422);
        expect((await app.request('/api/chats/chat_project/drive-project', json({ ...request, actorId: "other" }))).status).toBe(422);
        expect((await app.request('/api/chats/chat_project/drive-project', json({ padding: "x".repeat(5000) }))).status).toBe(413);
        authorize.mockImplementationOnce(async (_owner,_chatId,_references,scoped) => { await scoped.kysely.updateTable("chats").set({ collaboration: { scopeId: reference.scopeId, mode: "discussion_only", executionFenced: true } }).where("id", "=", "chat_project").execute(); });
        expect((await app.request('/api/chats/chat_project/drive-project', json(request))).status).toBe(409);
        const result = await app.request('/api/chat-drive-projects/lookup', { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatIds: ["chat_project"] }) });
        expect(await result.json()).toEqual({ associations: [] });
    });
});
