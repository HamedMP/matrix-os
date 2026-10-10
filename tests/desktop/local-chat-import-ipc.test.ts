import { describe, expect, it, vi } from "vitest";
import { registerLocalChatImportIpc } from "../../desktop/src/main/ipc/local-chat-import";
import { LOCAL_CHAT_IMPORT_INVOKE } from "../../desktop/src/shared/local-chat-import-ipc";
describe("trusted Chat import IPC", () => {
    const request = { harness: "claude", runtimeSlot: "primary", authGeneration: 3 };
    function fixture() { const listeners = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(); const select = vi.fn(async () => ({ status: "cancelled" })); const reserve=vi.fn(()=>({ok:true}));const service = { reserve, discover:vi.fn(), prepare:vi.fn(), select, release:vi.fn(()=>({ok:true})), apply: vi.fn(), pause: vi.fn(), cancelAll: vi.fn(), dispose: vi.fn() }; registerLocalChatImportIpc({ handle: (channel, listener) => { listeners.set(channel, listener); } }, service as never, event => event === "trusted"); return { listeners, select, reserve }; }
    it("rejects non-main-frame senders and malformed paths before invoking the picker", async () => { const x = fixture(); const listener = x.listeners.get("runtime:chat-import-select")!; await expect(listener("untrusted", request)).rejects.toThrow("invalid request"); await expect(listener("trusted", { ...request, path: "/private/session.jsonl" })).rejects.toThrow("invalid request"); expect(x.select).not.toHaveBeenCalled(); });
    it("validates trusted results and registers dependencies before accepting requests", async () => { const x = fixture(); expect(await x.listeners.get("runtime:chat-import-select")!("trusted", request)).toEqual({ status: "cancelled" }); x.select.mockResolvedValueOnce({ status: "selected", path: "/private/file" } as never); await expect(x.listeners.get("runtime:chat-import-select")!("trusted", request)).rejects.toThrow("internal error"); expect(() => registerLocalChatImportIpc({ handle: vi.fn() }, {} as never, () => true)).toThrow("Chat import unavailable"); });
    it("registers bounded owner-session reservation and rejects unknown paths or oversized batches",async()=>{
        const x=fixture();const session={runtimeSlot:"primary",authGeneration:3};const sourceKeys=["019eb0ae-9a30-7541-bdb8-db4d17e65146"];
        expect(await x.listeners.get("runtime:chat-import-reserve")!("trusted",{...session,sourceKeys})).toEqual({ok:true});expect(x.reserve).toHaveBeenCalledWith({...session,sourceKeys});
        await expect(x.listeners.get("runtime:chat-import-reserve")!("untrusted",{...session,sourceKeys})).rejects.toThrow("invalid request");
        expect(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-reserve"].request.safeParse({...session,sourceKeys,path:"/private"}).success).toBe(false);
        expect(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-reserve"].request.safeParse({...session,sourceKeys:Array.from({length:20001},()=>sourceKeys[0])}).success).toBe(false);
    });
    it("rejects oversized or secret-bearing renderer inputs", () => { expect(LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-apply"].request.safeParse({ ...request, selectionId: "not-a-uuid", title: "x", accessToken: "private" }).success).toBe(false); });
});
