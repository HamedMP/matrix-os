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
