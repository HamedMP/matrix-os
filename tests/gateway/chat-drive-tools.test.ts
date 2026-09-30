import { describe, expect, it, vi } from "vitest";
import { createChatDriveContext } from "../../packages/gateway/src/chat/drive-context.js";
const owner = { type: "personal" as const, ownerId: "user_owner" };
const drive = { kind: "drive" as const, scopeId: "00000000-0000-4000-8000-000000000001", organizationId: "org_company" };
const fileId = "00000000-0000-4000-8000-000000000002";
function fixture() {
    const get = vi.fn(async () => ({ chat: { id: "chat_drive", lifecycle: "active" } }));
    const search = vi.fn(async () => ({ organizationId: drive.organizationId, scopeId: drive.scopeId, files: [] }));
    const read = vi.fn(async () => ({ status: "text", readOnly: true, text: "plan", truncated: false, file: { id: fileId, path: "plan.md", version: 1 } }));
    const load = vi.fn(async () => ({ chatId: "chat_drive", references: [drive] }));
    const service = createChatDriveContext({ ownerId: owner.ownerId, repository: { get } as never, client: { search, read }, loadRun: load });
    return { service, get, search, read, load };
}
describe("read-only tools bound to admitted Chat drive references", () => {
    it("authorizes the configured private owner and current source membership", async () => { const f = fixture(); await f.service.authorize(owner, "chat_drive", [drive]); expect(f.search).toHaveBeenCalledWith(drive, { limit: 1 }, expect.any(AbortSignal)); await expect(f.service.authorize({ ...owner, ownerId: "user_other" }, "chat_drive", [drive])).rejects.toThrow(); expect(f.search).toHaveBeenCalledTimes(1); });
    it("blocks a shared Chat until an audience policy is implemented", async () => { const f = fixture(); f.get.mockResolvedValueOnce({ chat: { id: "chat_drive", lifecycle: "active", collaboration: { mode: "shared" } } } as never); await expect(f.service.authorize(owner, "chat_drive", [drive])).rejects.toThrow(); expect(f.search).not.toHaveBeenCalled(); });
    it("searches only a server-admitted reference; input cannot replace its scope", async () => { const f = fixture(); await f.service.search(owner.ownerId, "run_live", { referenceIndex: 0, query: "plan" }); expect(f.search).toHaveBeenCalledWith(drive, { query: "plan", limit: 30 }, expect.any(AbortSignal)); expect(f.load).toHaveBeenCalledTimes(2); await expect(f.service.search(owner.ownerId, "run_live", { referenceIndex: 0, scopeId: "forged" } as never)).rejects.toThrow(); expect(f.search).toHaveBeenCalledTimes(1); });
    it("denies invalid indexes, inactive runs and another owner before source I/O", async () => { const f = fixture(); await expect(f.service.read("user_other", "run_live", { referenceIndex: 0, fileId })).rejects.toThrow(); await expect(f.service.search(owner.ownerId, "run_live", { referenceIndex: 2 })).rejects.toThrow(); f.load.mockResolvedValueOnce(null as never); await expect(f.service.read(owner.ownerId, "run_done", { referenceIndex: 0, fileId })).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled(); });
    it("drops a result if the run is cancelled while the source read is in flight", async () => { const f = fixture(); f.load.mockResolvedValueOnce({ chatId: "chat_drive", references: [drive] }).mockResolvedValueOnce(null as never); await expect(f.service.read(owner.ownerId, "run_live", { referenceIndex: 0, fileId })).rejects.toThrow(); expect(f.read).toHaveBeenCalledWith(drive, fileId, expect.any(AbortSignal)); });
    it("pins individual files and rejects a caller-selected different file", async () => { const f = fixture(); const pinned = { ...drive, kind: "file" as const, fileId, version: 1 }; f.load.mockResolvedValue({ chatId: "chat_drive", references: [pinned] } as never); await f.service.read(owner.ownerId, "run_live", { referenceIndex: 0 }); expect(f.read).toHaveBeenCalledWith(pinned, undefined, expect.any(AbortSignal)); await expect(f.service.read(owner.ownerId, "run_live", { referenceIndex: 0, fileId: "00000000-0000-4000-8000-000000000003" })).rejects.toThrow(); expect(f.read).toHaveBeenCalledTimes(1); });
});
