// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useWorkRailMoves } from "@desktop/renderer/src/features/work/work-rail/use-work-rail-moves";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
afterEach(cleanup);
it("does not project a late move or navigate when authority changes even if client object is reused",async()=>{
 useConnection.setState({userId:"owner",runtimeSlot:"pr-2128",authGeneration:1});
 let finish!:(record:CanonicalChatRecord)=>void;
 const record={chat:{id:"chat_move",revision:3}} as CanonicalChatRecord;
 const project={id:"project_move",slug:"move",name:"Move",kind:"folder" as const};
 const client={updateProject:vi.fn(()=>new Promise(resolve=>{finish=resolve}))} as unknown as CanonicalChatClient;
 const setRecords=vi.fn(),setExpandedProjects=vi.fn(),onChatMoved=vi.fn();
 const {result}=renderHook(()=>useWorkRailMoves({client,projects:[project],routeScopeRef:{current:{client,key:"current",generation:1}},setRecords,setExpandedProjects,onChatMoved}));
 act(()=>result.current.moveItems(record)[0]!.onSelect());
 useConnection.setState({runtimeSlot:"primary",authGeneration:2});
 await act(async()=>finish({...record,projectId:project.id}));
 expect(setRecords).not.toHaveBeenCalled();
 expect(setExpandedProjects).not.toHaveBeenCalled();
 expect(onChatMoved).not.toHaveBeenCalled();
});

it("rejects a move after same-store authority revocation before React renders", async () => {
 let epoch = 0;
 let finish!:(record:CanonicalChatRecord)=>void;
 const record={chat:{id:"chat_move",revision:3}} as CanonicalChatRecord;
 const project={id:"project_move",slug:"move",name:"Move",kind:"folder" as const};
 const client={updateProject:vi.fn(()=>new Promise(resolve=>{finish=resolve}))} as unknown as CanonicalChatClient;
 const setRecords=vi.fn(),setExpandedProjects=vi.fn(),onChatMoved=vi.fn();
 const scope={client,key:"current",generation:1,isCurrent:()=>epoch===0};
 const {result}=renderHook(()=>useWorkRailMoves({client,projects:[project],routeScopeRef:{current:scope},setRecords,setExpandedProjects,onChatMoved}));
 act(()=>result.current.moveItems(record)[0]!.onSelect());
 epoch++;
 await act(async()=>finish({...record,projectId:project.id}));
 expect(setRecords).not.toHaveBeenCalled();
 expect(setExpandedProjects).not.toHaveBeenCalled();
 expect(onChatMoved).not.toHaveBeenCalled();
});

it("fences a queued move updater when authority changes before React applies it", async () => {
 let epoch=0;
 const record={chat:{id:"chat_move",revision:3}} as CanonicalChatRecord;
 const updated={...record,projectId:"project_move"};
 const project={id:"project_move",slug:"move",name:"Move",kind:"folder" as const};
 const client={updateProject:vi.fn(async()=>updated)} as unknown as CanonicalChatClient;
 const setRecords=vi.fn(),setExpandedProjects=vi.fn();
 const scope={client,key:"current",generation:1,isCurrent:()=>epoch===0};
 const {result}=renderHook(()=>useWorkRailMoves({client,projects:[project],routeScopeRef:{current:scope},setRecords,setExpandedProjects}));
 await act(async()=>result.current.moveItems(record)[0]!.onSelect());
 expect(setRecords).toHaveBeenCalledOnce();
 epoch++;
 const previous=[record];
 expect(setRecords.mock.calls[0]![0](previous)).toBe(previous);
 expect(setExpandedProjects.mock.calls[0]![0]({})).toEqual({});
});
