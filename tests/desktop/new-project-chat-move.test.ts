// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { createProjectForChat, moveChatToCreatedProject } from "@desktop/renderer/src/features/work/work-rail/new-project-chat-move";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
const update = vi.hoisted(() => vi.fn());
vi.mock("@desktop/renderer/src/lib/canonical-chat-client", () => ({createCanonicalChatClient:() => ({updateProject:update})}));
const project={id:"project_new",slug:"new",name:"New",kind:"scratch" as const};
const record={chat:{id:"chat_move",revision:7}} as CanonicalChatRecord;
afterEach(()=>{update.mockReset();useUi.getState().setCreateProjectOpen(false);useUi.getState().clearPendingProjectChatMove();});
function prepare(){useConnection.setState({userId:"owner",platformHost:"https://platform.test",runtimeSlot:"pr-2128",authGeneration:2,api:{} as never});createProjectForChat(record);}
it("uses the loaded revision and immediately focuses the moved Chat after the existing Project opens",async()=>{
 prepare();useTabs.setState({tabs:[],activeTabId:null});
 const before=useUi.getState().projectChatMoveRefreshRequest;
 update.mockResolvedValue({chat:{...record.chat,title:"Moved Chat"},projectId:project.id});
 const afterOpened=await moveChatToCreatedProject(project);
 expect(update).toHaveBeenCalledWith("chat_move",{baseRevision:7,projectId:"project_new"});
 expect(useUi.getState().pendingProjectChatMove).toBeNull();
 expect(useUi.getState().projectChatMoveRefreshRequest).toBe(before+1);
 afterOpened?.();
 expect(useTabs.getState().tabs.some(tab=>tab.workRoute === "project" && tab.projectSlug === "new" && tab.chatId === "chat_move")).toBe(true);
});
it("cancels assignment on dialog cancel or authority switch",async()=>{prepare();useUi.getState().setCreateProjectOpen(false);await moveChatToCreatedProject(project);expect(update).not.toHaveBeenCalled();prepare();useConnection.setState({runtimeSlot:"primary"});await moveChatToCreatedProject(project);expect(update).not.toHaveBeenCalled();expect(useUi.getState().pendingProjectChatMove).toBeNull();});
it("keeps original assignment on a failed move, clears retry request, and reports safe recovery",async()=>{prepare();update.mockRejectedValue(new Error("private database details"));await moveChatToCreatedProject(project);expect(useUi.getState().pendingProjectChatMove).toBeNull();expect(useUi.getState().projectChatMoveError).toContain("original project is preserved");expect(useUi.getState().projectChatMoveError).not.toContain("private");});

it("does not clear a newer pending request when an old move settles",async()=>{prepare();let finish!:(value:unknown)=>void;update.mockImplementation(()=>new Promise(resolve=>{finish=resolve}));const first=moveChatToCreatedProject(project);createProjectForChat({...record,chat:{...record.chat,id:"chat_newer"}});finish({});await first;expect(useUi.getState().pendingProjectChatMove?.chatId).toBe("chat_newer");});
