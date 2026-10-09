import * as localChatSources from "@finnaai/matrix/local-chat-import";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, appendFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeChatImportService } from "../../desktop/src/main/files/local-chat-import";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "matrix-chat-native-"));
    directories.push(directory);
    const path = join(await realpath(directory), "session.jsonl");
    await writeFile(path, JSON.stringify({ type: "user", sessionId: sourceId, uuid: "u", message: { role: "user", content: "Synthetic prompt" } }) + "\n");
    const state = { signedIn: true, runtimeSlot: "primary", authGeneration: 3, userId: "user_synthetic" };
    const auth = { getStatus: vi.fn(() => state), getToken: () => "synthetic-token", getGatewayOrigin: () => "https://app.example.test" };
    const chooseFile = vi.fn(async () => path);
    const transfer = vi.fn(async (_payload, source) => { await source.read(0, source.rawSize, new AbortController().signal); return { jobId: sourceId, chatId: "chat_synthetic", messageCount: 1 }; });
    const progress = vi.fn();
    const chooseFiles = vi.fn(async () => [path]);
    const discoverSources = vi.fn(async () => ({ sources: [{path, harness:"claude" as const, title:"Synthetic prompt", rawBytes:100, updatedAt:"2026-10-01T00:00:00Z"}], limited:false }));
    const service = createNativeChatImportService({ auth, discoverSources, chooseFile, chooseFiles, transfer, progress });
    const request = { harness: "claude" as const, runtimeSlot: "primary", authGeneration: 3 };
    return { path, state, auth, discoverSources, chooseFile, chooseFiles, service, request, transfer, progress };
}
describe("native original transcript import", () => {
    it("returns an opaque selection, streams only the previewed boundary after append, and never exposes the local path", async () => {
        const x = await fixture();
        try {
            const result = await x.service.select(x.request);
            expect(result.status).toBe("selected");
            expect(JSON.stringify(result)).not.toContain(x.path);
            if (result.status !== "selected")
                throw new Error("Expected selected");
            await appendFile(x.path, "additional live bytes\n");
            expect(await x.service.apply({ runtimeSlot: x.request.runtimeSlot, authGeneration: x.request.authGeneration, selectionId: result.selectionId, title: result.preview.title })).toMatchObject({ status: "imported", chatId: "chat_synthetic" });
            expect(x.transfer.mock.calls[0]![0].rawSize).toBe(result.preview.rawBytes);
        }
        finally {
            await x.service.dispose();
        }
    });
    it("rejects stale auth before picker and discards a selection on account change", async () => {
        const x = await fixture();
        try {
            expect(await x.service.select({ ...x.request, authGeneration: 2 })).toEqual({ status: "cancelled" });
            expect(x.chooseFile).not.toHaveBeenCalled();
            const result = await x.service.select(x.request);
            if (result.status !== "selected")
                throw new Error("Expected selected");
            x.state.userId = "user_other";
            expect(await x.service.apply({ runtimeSlot: x.request.runtimeSlot, authGeneration: x.request.authGeneration, selectionId: result.selectionId, title: "Synthetic" })).toEqual({ status: "cancelled" });
            expect(x.transfer).not.toHaveBeenCalled();
        }
        finally {
            await x.service.dispose();
        }
    });
    it("cancels an in-flight operation and drains it before disposal", async () => {
        const x = await fixture();
        try {
            const result = await x.service.select(x.request);
            if (result.status !== "selected")
                throw new Error("Expected selected");
            let started!: () => void;
            const start = new Promise<void>(resolve => { started = resolve; });
            x.transfer.mockImplementation(async (_payload, _source, _transport, options) => { started(); await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true })); throw new Error("Unreachable"); });
            const pending = x.service.apply({ runtimeSlot: x.request.runtimeSlot, authGeneration: x.request.authGeneration, selectionId: result.selectionId, title: "Synthetic" });
            await start;
            await x.service.dispose();
            expect(await pending).toEqual({ status: "cancelled" });
        }
        finally {
            await x.service.dispose();
        }
    });
    it("does not accept renderer-provided file paths or storage URLs", async () => {
        const x = await fixture();
        try {
            expect(await x.service.select({ ...x.request, path: x.path })).toMatchObject({ status: "error" });
            expect(x.chooseFile).not.toHaveBeenCalled();
        }
        finally {
            await x.service.dispose();
        }
    });
    it("does not hold application shutdown behind an unresolved file picker",async()=>{
        const x=await fixture();let opened!:()=>void;const started=new Promise<void>(resolve=>{opened=resolve;});
        x.chooseFile.mockImplementation(async()=>{opened();return new Promise<string>(()=>{});});
        const selected=x.service.select(x.request);await started;
        const drained=await Promise.race([x.service.dispose().then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
        expect(drained).toBe(true);expect(await selected).toEqual({status:"cancelled"});
    });
});

describe("native batch previews", () => {
    it("previews more than four chats independently and keeps every selected source applicable", async () => {
        const x = await fixture();
        try {
            const paths = [];
            for (let i = 0; i < 6; i++) {
                const path = x.path.replace("session.jsonl", `session-${i}.jsonl`);
                await writeFile(path, JSON.stringify({ type: "user", sessionId: `019eb0ae-9a30-7541-bdb8-db4d17e6514${i}`, uuid: "u", message: { role: "user", content: `Prompt ${i}` } }) + "\n");
                paths.push(path);
            }
            x.chooseFiles.mockResolvedValueOnce(paths);
            const result = await x.service.select({ ...x.request, multiple: true });
            expect(result.status).toBe("selected-many");
            if (result.status !== "selected-many") throw new Error("Expected batch");
            expect(result.selections).toHaveLength(6);
            expect(JSON.stringify(result)).not.toContain(x.path.slice(0, x.path.lastIndexOf("/")));
            for (const selection of result.selections) {
                expect(await x.service.apply({ runtimeSlot: x.request.runtimeSlot, authGeneration: x.request.authGeneration, selectionId: selection.selectionId, title: selection.preview.title })).toMatchObject({status: "imported"});
            }
        } finally { await x.service.dispose(); }
    });
    it("reports an unreadable file without losing valid previews and rejects an oversized batch", async () => {
        const x = await fixture();
        try {
            x.chooseFiles.mockResolvedValueOnce([x.path, x.path + ".missing"]);
            const result = await x.service.select({ ...x.request, multiple: true });
            expect(result).toMatchObject({status: "selected-many", selections: [expect.objectContaining({preview: expect.objectContaining({title: "Synthetic prompt"})})], errors: [expect.any(String)]});
            expect(JSON.stringify(result)).not.toContain(x.path);
            x.chooseFiles.mockResolvedValueOnce(Array.from({length: 33}, () => x.path));
            expect(await x.service.select({ ...x.request, multiple: true })).toMatchObject({status: "error"});
        } finally { await x.service.dispose(); }
    });
});

describe("owner-bound local catalog",()=>{
    it("discovers opaque metadata and previews only IDs belonging to the current catalog",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try {
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected discovered");
            expect(JSON.stringify(found)).not.toContain(x.path);expect(x.transfer).not.toHaveBeenCalled();
            expect(await x.service.prepare({...session,sourceKeys:["019eb0ae-9a30-7541-bdb8-db4d17e65140"]})).toMatchObject({status:"error"});
            const prepared=await x.service.prepare({...session,sourceKeys:[found.sources[0]!.sourceKey]});
            expect(prepared).toMatchObject({status:"selected-many",selections:[expect.objectContaining({preview:expect.objectContaining({title:"Synthetic prompt"})})]});
            expect(x.chooseFile).not.toHaveBeenCalled();expect(x.chooseFiles).not.toHaveBeenCalled();
            x.state.userId="user_other";
            expect(await x.service.prepare({...session,sourceKeys:[found.sources[0]!.sourceKey]})).toMatchObject({status:"error"});
        }finally{await x.service.dispose();}
    });
    it("releases removed native previews without dropping retained chats or catalog IDs",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try {
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected catalog");
            for(let i=0;i<130;i++){
                const selected=await x.service.prepare({...session,sourceKeys:[found.sources[0]!.sourceKey]});
                if(selected.status!=="selected-many" || !selected.selections[0])throw new Error("Preview capacity leaked");
                const selectionId=selected.selections[0].selectionId;
                expect(x.service.release({...session,authGeneration:2,selectionIds:[selectionId]})).toEqual({ok:false});
                expect(x.service.release({...session,selectionIds:[selectionId]})).toEqual({ok:true});
                expect(await x.service.apply({...session,selectionId,title:"Removed"})).toEqual({status:"cancelled"});
            }
            expect(await x.service.prepare({...session,sourceKeys:[found.sources[0]!.sourceKey]})).toMatchObject({status:"selected-many",selections:[expect.any(Object)]});
        }finally{await x.service.dispose();}
    });
    it("queues discovery restart until an aborted scan has settled",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try{
            let finish!:(result:Awaited<ReturnType<typeof x.discoverSources>>)=>void;
            x.discoverSources.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
            const first=x.service.discover(session);
            await vi.waitFor(()=>expect(x.discoverSources).toHaveBeenCalledTimes(1));
            x.service.pause(session);
            const second=x.service.discover(session);
            finish({sources:[],limited:false});
            expect(await first).toEqual({status:"cancelled"});
            expect(await second).toMatchObject({status:"discovered"});
            expect(x.discoverSources).toHaveBeenCalledTimes(2);
        }finally{await x.service.dispose();}
    });
    it("cancels a queued restart before the previous aborted operation drains",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try{
            let finish!:(result:Awaited<ReturnType<typeof x.discoverSources>>)=>void;
            x.discoverSources.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
            const first=x.service.discover(session);await vi.waitFor(()=>expect(x.discoverSources).toHaveBeenCalledTimes(1));
            x.service.pause(session);const second=x.service.discover(session);x.service.pause(session);
            finish({sources:[],limited:false});
            expect(await first).toEqual({status:"cancelled"});expect(await second).toEqual({status:"cancelled"});
            expect(x.discoverSources).toHaveBeenCalledTimes(1);
        }finally{await x.service.dispose();}
    });
    it("clears catalog IDs when Settings closes and rejects stale sessions before scanning",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try{
            expect(await x.service.discover({...session,authGeneration:2})).toEqual({status:"cancelled"});expect(x.discoverSources).not.toHaveBeenCalled();
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected discovered");
            x.service.pause({...session,discardSelections:true});
            expect(await x.service.prepare({...session,sourceKeys:[found.sources[0]!.sourceKey]})).toMatchObject({status:"error"});
        }finally{await x.service.dispose();}
    });
});


describe("reserved streaming import catalogs",()=>{
    it("returns more than 200 discovered sources while retaining the prepare transport cap",async()=>{
        const x=await fixture(); const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try {
            const source=(await x.discoverSources()).sources[0]!;
            x.discoverSources.mockResolvedValueOnce({sources:Array.from({length:250},()=>source),limited:false});
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected catalog");
            expect(found.sources).toHaveLength(250);expect(found.limited).toBe(false);
            expect(x.service.reserve({...session,sourceKeys:found.sources.map(source=>source.sourceKey)})).toEqual({ok:true});
            expect(await x.service.prepare({...session,sourceKeys:found.sources.slice(0,33).map(source=>source.sourceKey)})).toEqual({status:"cancelled"});
            expect(await x.service.prepare({...session,sourceKeys:[found.sources[249]!.sourceKey]})).toMatchObject({status:"selected-many"});
        }finally{await x.service.dispose();}
    });
    it("bounds the 20,000-entry catalog and accepts reservation at its exact capacity",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try {
            const source=(await x.discoverSources()).sources[0]!;
            x.discoverSources.mockResolvedValueOnce({sources:Array.from({length:20001},()=>source),limited:false});
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected catalog");
            expect(found.sources).toHaveLength(20000);expect(found.limited).toBe(true);
            expect(x.service.reserve({...session,sourceKeys:found.sources.map(source=>source.sourceKey)})).toEqual({ok:true});
        }finally{await x.service.dispose();}
    });
    it("prepares a streaming queue without rechecking the complete catalog for every transcript",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try {
            const source=(await x.discoverSources()).sources[0]!;
            x.discoverSources.mockResolvedValueOnce({sources:Array.from({length:250},()=>source),limited:false});
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected catalog");
            expect(x.service.reserve({...session,sourceKeys:found.sources.map(source=>source.sourceKey)})).toEqual({ok:true});x.auth.getStatus.mockClear();
            for(const source of found.sources.slice(0,20)) {
                const selected=await x.service.prepare({...session,sourceKeys:[source.sourceKey]});
                if(selected.status!=="selected-many" || !selected.selections[0])throw new Error("Expected preview");
                x.service.release({...session,selectionIds:[selected.selections[0].selectionId]});
            }
            expect(x.auth.getStatus.mock.calls.length).toBeLessThan(1000);
        }finally{await x.service.dispose();}
    });
    it("validates every ID and owner before extending any expiry, and pins valid queues for 24 hours",async()=>{
        const x=await fixture(); const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};let now=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>now);
        try {
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected catalog");const key=found.sources[0]!.sourceKey;
            expect(x.service.reserve({...session,sourceKeys:[key,randomUUID()]})).toEqual({ok:false});
            now+=16*60_000;
            expect(await x.service.prepare({...session,sourceKeys:[key]})).toMatchObject({status:"error"});
            const next=await x.service.discover(session);if(next.status!=="discovered")throw new Error("Expected fresh catalog");const fresh=next.sources[0]!.sourceKey;
            expect(x.service.reserve({...session,authGeneration:2,sourceKeys:[fresh]})).toEqual({ok:false});
            expect(x.service.reserve({...session,sourceKeys:Array.from({length:20001},()=>randomUUID())})).toEqual({ok:false});
            x.state.userId="another_owner";expect(x.service.reserve({...session,sourceKeys:[fresh]})).toEqual({ok:false});x.state.userId="user_synthetic";
            expect(x.service.reserve({...session,sourceKeys:[fresh]})).toEqual({ok:true});
            now+=2*60*60_000;
            expect(await x.service.prepare({...session,sourceKeys:[fresh]})).toMatchObject({status:"selected-many"});
            now+=23*60*60_000;
            expect(await x.service.prepare({...session,sourceKeys:[fresh]})).toMatchObject({status:"error"});
        }finally{await x.service.dispose();}
    });
    it("discards reserved IDs on Settings close, auth change and shutdown",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try {
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected catalog");const sourceKeys=[found.sources[0]!.sourceKey];
            expect(x.service.reserve({...session,sourceKeys})).toEqual({ok:true});x.service.pause({...session,discardSelections:true});expect(x.service.reserve({...session,sourceKeys})).toEqual({ok:false});
            const second=await x.service.discover(session);if(second.status!=="discovered")throw new Error("Expected catalog");const keys=[second.sources[0]!.sourceKey];
            expect(x.service.reserve({...session,sourceKeys:keys})).toEqual({ok:true});x.state.authGeneration++;expect(x.service.reserve({...session,sourceKeys:keys})).toEqual({ok:false});
            x.service.cancelAll();x.state.authGeneration--;expect(x.service.reserve({...session,sourceKeys:keys})).toEqual({ok:false});await x.service.dispose();
            expect(x.service.reserve({...session,sourceKeys:keys})).toEqual({ok:false});
        }finally{await x.service.dispose();}
    });
});


describe("native prepared batches retain titles and release cancelled previews",()=>{
    it("preserves the discovered saved title in preview and upload without changing original bytes or hash",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};
        try {
            const source=(await x.discoverSources()).sources[0]!;x.discoverSources.mockResolvedValueOnce({sources:[{...source,title:"Saved local title"}],limited:false});
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected catalog");
            const prepared=await x.service.prepare({...session,sourceKeys:[found.sources[0]!.sourceKey]});
            if(prepared.status!=="selected-many" || !prepared.selections[0])throw new Error("Expected preview");const selected=prepared.selections[0];
            expect(selected.preview.title).toBe("Saved local title");
            const bytes=await readFile(x.path);
            expect(selected.preview.sourceHash).toBe(createHash("sha256").update(bytes).digest("hex"));expect(selected.preview.rawBytes).toBe(bytes.length);
            expect(await x.service.apply({...session,selectionId:selected.selectionId,title:selected.preview.title})).toMatchObject({status:"imported"});
            expect(x.transfer.mock.calls[0]![0]).toMatchObject({title:"Saved local title",sourceHash:selected.preview.sourceHash,rawSize:bytes.length});
        }finally{await x.service.dispose();}
    });
    it("releases only previews created by a stopped two-file batch and preserves previously returned previews",async()=>{
        const x=await fixture();const session={runtimeSlot:x.request.runtimeSlot,authGeneration:x.request.authGeneration};const secondPath=x.path.replace("session.jsonl","second.jsonl");
        await writeFile(secondPath,JSON.stringify({type:"user",sessionId:sourceId,uuid:"second",message:{role:"user",content:"Second"}})+"\n");
        const originalOpen=localChatSources.openLocalChatSource;let started:(()=>void)|undefined;
        vi.spyOn(localChatSources,"openLocalChatSource").mockImplementation(async(...args)=>{
            const source=await originalOpen(...args);
            return args[0]!==secondPath ? source : {...source,async preview(_harness: Parameters<typeof source.preview>[0],signal: AbortSignal=new AbortController().signal){
                started?.();await new Promise<never>((_resolve,reject)=>signal?.addEventListener("abort",()=>reject(new DOMException("Stopped","AbortError")),{once:true}));throw new Error("Unreachable");
            }};
        });
        try {
            const source=(await x.discoverSources()).sources[0]!;x.discoverSources.mockResolvedValueOnce({sources:[...Array.from({length:32},()=>source),{...source,path:secondPath}],limited:false});
            const found=await x.service.discover(session);if(found.status!=="discovered")throw new Error("Expected catalog");const firstKeys=found.sources.slice(0,32).map(source=>source.sourceKey);const secondKey=found.sources[32]!.sourceKey;
            const retained=await x.service.prepare({...session,sourceKeys:[firstKeys[0]!]});if(retained.status!=="selected-many" || !retained.selections[0])throw new Error("Expected retained preview");
            for(let i=0;i<120;i++) {
                const pendingStarted=new Promise<void>(resolve=>{started=resolve;});const pending=x.service.prepare({...session,sourceKeys:[firstKeys[0]!,secondKey]});
                await pendingStarted;x.service.pause(session);expect(await pending).toEqual({status:"cancelled"});
            }
            const next=await x.service.prepare({...session,sourceKeys:firstKeys});expect(next).toMatchObject({status:"selected-many",errors:[]});
            if(next.status!=="selected-many")throw new Error("Expected next batch");expect(next.selections).toHaveLength(32);
            expect(await x.service.apply({...session,selectionId:retained.selections[0].selectionId,title:"Retained"})).toMatchObject({status:"imported"});
        }finally{await x.service.dispose();}
    });
});
