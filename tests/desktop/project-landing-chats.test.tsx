// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useProjectLandingChats } from "@desktop/renderer/src/features/project/use-project-landing-chats";
afterEach(cleanup);
function record(id:string,projectId:string):CanonicalChatRecord{return {chat:{id,title:id,createdAt:"2026-10-03T00:00:00Z",updatedAt:"2026-10-03T00:00:00Z"},projectId} as CanonicalChatRecord;}
it("loads current and legacy Project associations without relying on newest global chats and fences client changes",async()=>{
 const stable=record("chat_stable","project_alpha"),legacy=record("chat_old","alpha");
 const client={list:vi.fn(async(input:any)=>({items:input.projectId === "alpha" ? [legacy] : [stable]}))} as unknown as CanonicalChatClient;
 const project={id:"project_alpha",slug:"alpha",name:"Alpha",kind:"folder" as const};
 const {result,rerender}=renderHook(({client})=>useProjectLandingChats(project,client),{initialProps:{client}});
 await waitFor(()=>expect(result.current.chats).toHaveLength(2));
 expect(client.list).toHaveBeenCalledWith({projectId:"project_alpha",limit:100});
 expect(client.list).toHaveBeenCalledWith({projectId:"alpha",limit:100});
 const next={list:vi.fn(()=>new Promise(()=>{}))} as unknown as CanonicalChatClient;
 rerender({client:next});
 expect(result.current.chats).toEqual([]);
});
