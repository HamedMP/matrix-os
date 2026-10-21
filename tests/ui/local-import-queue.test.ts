import { describe, expect, it, vi } from "vitest";
import { runLocalImportQueue } from "../../packages/ui/src/chat-import/local-import-queue";
import type { LocalChatCandidate, NativeChatImportAdapter, NativeSelection } from "../../packages/ui/src/chat-import/import-state";
const sources:LocalChatCandidate[]=Array.from({length:45},(_,i)=>({sourceKey:`key-${i}`,title:`Chat ${i}`,harness:"codex",rawBytes:1000,updatedAt:"2026-10-01"}));
function adapter(){
    let held=0;let maximum=0;
    const native={reserve:vi.fn(async()=>{}),prepare:vi.fn(async(keys:string[])=>{held+=keys.length;maximum=Math.max(maximum,held);return {selections:keys.map(key=>({selectionId:key,preview:{title:key}} as NativeSelection)),errors:[]};}),apply:vi.fn(async()=>({chatId:"chat_test",jobId:"job",messageCount:2})),release:vi.fn(async()=>{held--; }),pause:vi.fn()};
    return {native,maximum:()=>maximum,held:()=>held};
}
describe("streaming local import queue",()=>{
    it("reserves all45 chats then holds only one captured transcript at a time",async()=>{
        const {native,maximum,held}=adapter();const update=vi.fn();
        await runLocalImportQueue(sources,native,new AbortController().signal,update);
        expect(native.reserve).toHaveBeenCalledWith(sources.map(source=>source.sourceKey),expect.any(AbortSignal));
        expect(native.apply).toHaveBeenCalledTimes(45);expect(maximum()).toBe(1);expect(held()).toBe(0);
        expect(update.mock.calls.filter(([value])=>value.status==="imported")).toHaveLength(45);
    });
    it("keeps successes, releases failures and continues the remaining queue with safe errors",async()=>{
        const {native,held}=adapter();native.apply.mockRejectedValueOnce(new Error("postgres://private"));const update=vi.fn();
        await runLocalImportQueue(sources.slice(0,3),native,new AbortController().signal,update);
        expect(native.apply).toHaveBeenCalledTimes(3);expect(held()).toBe(0);
        const results=update.mock.calls.map(([value])=>value).filter(value=>["failed","imported"].includes(value.status));
        expect(results.map(value=>value.status)).toEqual(["failed","imported","imported"]);expect(results[0].error).not.toContain("private");
    });
    it("releases a late preview and never uploads after stop",async()=>{
        const {native}=adapter();const controller=new AbortController();
        native.prepare.mockImplementationOnce(async()=>{controller.abort();return {selections:[{selectionId:"late",preview:{title:"Late"}} as NativeSelection],errors:[]};});
        await runLocalImportQueue(sources,native,controller.signal,vi.fn());
        expect(native.release).toHaveBeenCalledWith(["late"]);expect(native.apply).not.toHaveBeenCalled();expect(native.prepare).toHaveBeenCalledTimes(1);
    });
    it("stops after a null canceled result and does not start the next chat",async()=>{
        const {native}=adapter();native.apply.mockResolvedValueOnce(null as never);
        await runLocalImportQueue(sources,native,new AbortController().signal,vi.fn());
        expect(native.apply).toHaveBeenCalledTimes(1);expect(native.release).toHaveBeenCalledTimes(1);
    });
    it("uses explicit edited titles and rejects reservation failures before any upload",async()=>{
        const {native}=adapter();await runLocalImportQueue(sources.slice(0,1),native,new AbortController().signal,vi.fn(),{"key-0":"Edited title"});
        expect(native.apply).toHaveBeenCalledWith("key-0","Edited title",expect.any(AbortSignal),expect.any(Function));
        native.reserve.mockRejectedValueOnce(new Error("expired"));native.apply.mockClear();
        await expect(runLocalImportQueue(sources,native,new AbortController().signal,vi.fn())).rejects.toThrow("expired");expect(native.apply).not.toHaveBeenCalled();
    });
});
