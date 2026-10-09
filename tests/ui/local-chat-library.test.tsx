// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatImportPanel } from "../../packages/ui/src/chat-import/ChatImportPanel";
const counts={humanInputs:1,assistantResponses:1,agentInputs:0,toolCalls:0,toolResults:0,attachments:0,externalReferences:0,thinkingRecords:0,contextRecords:0,unknownRecords:0,sourceIssues:0};
const sources=[{sourceKey:"a",harness:"codex" as const,title:"Fix import progress",rawBytes:1000,updatedAt:"2026-10-01T12:00:00Z",recordedDirectory:"/work/app"},{sourceKey:"b",harness:"claude" as const,title:"Plan the launch",rawBytes:2000,updatedAt:"2026-10-01T12:00:00Z"}];
function adapter(){return {discover:vi.fn(async()=>({sources,limited:false})),prepare:vi.fn(async(keys:string[])=>({selections:keys.map(key=>({selectionId:key,preview:{harness:"codex" as const,sourceId:key,sourceHash:"a".repeat(64),rawBytes:1000,title:"Fix import progress",firstVisibleText:"Synthetic preview",parserVersion:1 as const,counts}})),errors:[]})),apply:vi.fn(async()=>({chatId:"chat_a",jobId:"a",messageCount:2})),pause:vi.fn()};}
afterEach(cleanup);
describe("automatic local chat library",()=>{
    it("selects every discovered conversation by default and imports more than32 sequentially after deselection",async()=>{
        const native=adapter();const many=Array.from({length:45},(_,i)=>({...sources[i%2]!,sourceKey:`source-${i}`,title:`Conversation ${i}`}));
        native.discover.mockResolvedValue({sources:many,limited:false});
        native.prepare.mockImplementation(async(keys)=>({selections:keys.map(key=>({selectionId:key,preview:{harness:"codex",sourceId:key,sourceHash:"a".repeat(64),rawBytes:1000,title:key,firstVisibleText:"Synthetic preview",parserVersion:1,counts}})),errors:[]}));
        render(<ChatImportPanel native={native}/>);
        const first=await screen.findByRole("checkbox",{name:"Select Conversation 0"});
        expect((first as HTMLInputElement).checked).toBe(true);
        expect(screen.getAllByRole("checkbox").filter(node=>(node as HTMLInputElement).checked)).toHaveLength(45);
        fireEvent.click(first);
        fireEvent.click(screen.getByRole("button",{name:"Import 44 selected chats"}));
        await waitFor(()=>expect(native.apply).toHaveBeenCalledTimes(44));
        expect(native.prepare.mock.calls.every(([keys])=>keys.length===1)).toBe(true);
        expect(native.prepare.mock.calls.flatMap(([keys])=>keys)).not.toContain("source-0");
    });
    it("keeps all250 selected across pages and filters, with deselect/select all",async()=>{
        const native=adapter();native.discover.mockResolvedValue({sources:Array.from({length:250},(_,i)=>({...sources[i%2]!,sourceKey:`page-${i}`,title:`Paged ${i}`})),limited:false});
        render(<ChatImportPanel native={native}/>);await screen.findByRole("checkbox",{name:"Select Paged 0",hidden:true});
        expect(screen.getAllByRole("checkbox",{hidden:true})).toHaveLength(100);expect(screen.getByRole("button",{name:"Import 250 selected chats",hidden:true})).toBeTruthy();
        fireEvent.click(screen.getByRole("checkbox",{name:"Select Paged 0",hidden:true}));fireEvent.click(screen.getByRole("button",{name:"Next page",hidden:true}));
        expect((screen.getByRole("checkbox",{name:"Select Paged 100",hidden:true}) as HTMLInputElement).checked).toBe(true);
        fireEvent.change(screen.getByRole("searchbox"),{target:{value:"Paged 249"}});expect(screen.getByRole("button",{name:"Import 249 selected chats",hidden:true})).toBeTruthy();
        expect(screen.getByText("250 found · 249 selected · 248 hidden by filters")).toBeTruthy();
        fireEvent.click(screen.getByRole("button",{name:"Deselect all",hidden:true}));expect((screen.getByRole("button",{name:"Import 0 selected chats",hidden:true}) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole("button",{name:"Select all",hidden:true}));expect(screen.getByRole("button",{name:"Import 250 selected chats",hidden:true})).toBeTruthy();
    });
    it("retries only failed selected chats and leaves successful ones unchecked",async()=>{
        const native=adapter();native.apply.mockRejectedValueOnce(new Error("private filesystem path"));render(<ChatImportPanel native={native}/>);
        fireEvent.click(await screen.findByRole("button",{name:"Import 2 selected chats"}));await screen.findByRole("button",{name:"Import 1 selected chat"});
        expect(native.apply).toHaveBeenCalledTimes(2);expect((screen.getByRole("checkbox",{name:"Select Plan the launch"}) as HTMLInputElement).checked).toBe(false);
        fireEvent.click(screen.getByRole("button",{name:"Import 1 selected chat"}));await screen.findByText("2 chats ready in Matrix.");
        expect(native.apply).toHaveBeenCalledTimes(3);
    });
    it("discovers both tools without a file picker, searches and previews only selected conversations before upload",async()=>{
        const native=adapter();render(<ChatImportPanel native={native}/>);
        await screen.findByRole("checkbox",{name:"Select Fix import progress"});
        expect(screen.queryByText("Choose transcripts")).toBeNull();expect(document.querySelector('input[type="file"]')).toBeNull();
        expect(native.apply).not.toHaveBeenCalled();expect(native.prepare).not.toHaveBeenCalled();
        fireEvent.change(screen.getByRole("searchbox",{name:"Search local conversations"}),{target:{value:"import"}});
        expect(screen.queryByRole("checkbox",{name:"Select Plan the launch"})).toBeNull();
        fireEvent.click(screen.getByRole("button",{name:"Preview Fix import progress"}));
        await screen.findByText("Synthetic preview");expect(native.prepare).toHaveBeenCalledWith(["a"],expect.any(AbortSignal));expect(native.apply).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button",{name:"Import private Chat"}));await screen.findByText("Imported 2 history entries into Matrix Chat.");
    });
    it("rediscovers opaque source keys before starting another batch",async()=>{
        const native=adapter();render(<ChatImportPanel native={native}/>);
        await screen.findByRole("checkbox",{name:"Select Fix import progress"});
        fireEvent.click(screen.getByRole("button",{name:"Preview Fix import progress"}));
        await screen.findByText("Synthetic preview");
        fireEvent.click(screen.getByRole("button",{name:"Import private Chat"}));
        fireEvent.click(await screen.findByRole("button",{name:"Start another batch"}));
        await waitFor(()=>expect(native.discover).toHaveBeenCalledTimes(2));
        expect(native.pause).toHaveBeenCalledWith(true);
        await screen.findByRole("checkbox",{name:"Select Fix import progress"});
        fireEvent.click(screen.getByRole("button",{name:"Preview Fix import progress"}));
        await screen.findByText("Synthetic preview");
        expect(native.prepare).toHaveBeenCalledTimes(3);
    });
    it("lets the first preview stop and ignores its late selection reset",async()=>{
        const native=adapter();let settle:(value:Awaited<ReturnType<typeof native.prepare>>)=>void=()=>{throw new Error("missing waiter");};
        native.prepare.mockImplementationOnce(()=>new Promise(resolve=>{settle=resolve;}));
        render(<ChatImportPanel native={native}/>);
        await screen.findByRole("checkbox",{name:"Select Fix import progress"});
        fireEvent.click(screen.getByRole("button",{name:"Preview Fix import progress"}));
        fireEvent.click(screen.getByRole("button",{name:"Stop waiting"}));
        fireEvent.click(screen.getByRole("checkbox",{name:"Select Plan the launch"}));
        fireEvent.click(screen.getByRole("checkbox",{name:"Select Plan the launch"}));
        await act(async()=>{settle({selections:[],errors:[]});});
        expect((screen.getByRole("checkbox",{name:"Select Plan the launch"}) as HTMLInputElement).checked).toBe(true);
        expect(native.apply).not.toHaveBeenCalled();
    });
    it("clears stale catalog previews when refresh replaces opaque IDs",async()=>{
        const native=adapter();render(<ChatImportPanel native={native}/>);
        await screen.findByRole("checkbox",{name:"Select Fix import progress"});
        fireEvent.click(screen.getByRole("button",{name:"Preview Fix import progress"}));await screen.findByText("Synthetic preview");
        native.discover.mockResolvedValueOnce({sources:sources.map(source=>({...source,sourceKey:`fresh-${source.sourceKey}`})),limited:false});
        fireEvent.click(screen.getByRole("button",{name:"Refresh local conversations"}));
        await waitFor(()=>expect(native.discover).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole("button",{name:"Import private Chat"})).toBeNull();
        fireEvent.click(await screen.findByRole("button",{name:"Preview Fix import progress"}));await screen.findByText("Synthetic preview");
        fireEvent.click(screen.getByRole("button",{name:"Import private Chat"}));await screen.findByText("Imported 2 history entries into Matrix Chat.");
        expect(native.prepare).toHaveBeenLastCalledWith(["fresh-a"],expect.any(AbortSignal));
    });
    it("filters by app and shows a recoverable empty state when roots are missing",async()=>{
        const native=adapter();render(<ChatImportPanel native={native}/>);await screen.findByRole("checkbox",{name:"Select Plan the launch"});
        fireEvent.click(screen.getByRole("button",{name:"Claude Code"}));expect(screen.queryByRole("checkbox",{name:"Select Fix import progress"})).toBeNull();
        native.discover.mockResolvedValueOnce({sources:[],limited:false});fireEvent.click(screen.getByRole("button",{name:"Refresh local conversations"}));
        await screen.findByText("No local conversations found.");expect(native.apply).not.toHaveBeenCalled();
    });
    it("supports refresh and keeps discovery errors safe",async()=>{
        const native=adapter();native.discover.mockRejectedValueOnce(new Error("postgres://secret"));
        render(<ChatImportPanel native={native}/>);expect((await screen.findByRole("alert")).textContent).not.toContain("secret");
        fireEvent.click(screen.getByRole("button",{name:"Refresh local conversations"}));
        await screen.findByRole("checkbox",{name:"Select Fix import progress"});await waitFor(()=>expect(native.discover).toHaveBeenCalledTimes(2));
    });
});
