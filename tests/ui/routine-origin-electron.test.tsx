// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import type {BotInteraction,RoutineChatOriginView} from "@matrix-os/contracts";
import type {ChatAgentClient} from "@matrix-os/ui";
import {nativeScheduledMessageFixture} from "../helpers/native-scheduled-message-fixture";
afterEach(()=>{cleanup();vi.clearAllMocks();});
const desktopHandoff = vi.hoisted(()=>({destination:vi.fn(),invoke:vi.fn()}));
vi.mock("../../desktop/src/renderer/src/features/chat/routine-action-confirmation",()=>({desktopRoutineConfirmationDestination:desktopHandoff.destination}));
vi.mock("../../desktop/src/renderer/src/lib/operator",()=>({invoke:desktopHandoff.invoke}));
const interaction:BotInteraction={interactionId:"in_abcdefgh",chatId:"chat_executor",agentId:"bot_existing",taskId:"task_execution",kind:"approval",blocking:true,status:"pending",expiresAt:"2099-01-01T00:00:00.000Z",revision:7,payload:{kind:"approval",tool:"routine.activate",audience:"direct",policyRevision:3,argsDigest:"a".repeat(64),preview:JSON.stringify({proposal:{name:"Morning brief",prompt:"Write a private brief.",schedule:{kind:"once",at:"2099-01-01T00:00:00.000Z"},selection:{instanceId:"matrix_chatgpt_plan",model:"gpt-6-luna"},authorizedEffects:["read"]},source:{accountId:"account_private",computerId:"computer_fixture",grantRevision:3,definitionRevision:2}})}};
function fixture(pending=false){const chat=nativeScheduledMessageFixture().record.chat;
 const view:RoutineChatOriginView={sourceChatId:chat.id,pending:pending?[{sourceChatId:chat.id,anchorMessageId:"msg_source",interaction}]:[],deliveries:[],hasMore:false,deliveryPending:false};
 const get=vi.fn(async()=>view),resolve=vi.fn();const client={bots:{routineOrigin:{get,resolve}}} as unknown as ChatAgentClient;return {chat,client,get,resolve};}
it("keeps ordinary Electron scheduling conversational without a persistent creation button",async()=>{
 const {SourceChatRoutines}=await import("../../desktop/src/renderer/src/features/chat/SourceChatRoutines");const {chat,client,get}=fixture();
 render(<SourceChatRoutines client={client} chat={chat} ordinary revision={0}/>);await waitFor(()=>expect(get).toHaveBeenCalled());
 expect(screen.queryByRole("button",{name:"Persistent task"})).toBeNull();expect(desktopHandoff.destination).not.toHaveBeenCalled();
});
it("does not open the old source browser if the Electron approval unmounts during Computer lookup",async()=>{
 const {SourceChatRoutines}=await import("../../desktop/src/renderer/src/features/chat/SourceChatRoutines");
 let finish!:()=>void;desktopHandoff.destination.mockImplementation(async()=>{await new Promise<void>(r=>{finish=r;});return {connection:{platformHost:"https://app.example.test"},computer:{gatewayPath:"/vm/fixture"},current:()=>true};});
 const {chat,client}=fixture(true);const card=render(<SourceChatRoutines client={client} chat={chat} ordinary revision={0}/>);
 fireEvent.click(await screen.findByRole("button",{name:"Review in browser"}));card.unmount();await act(async()=>{finish();});expect(desktopHandoff.invoke).not.toHaveBeenCalled();
});
it("opens the existing schedule approval in the source browser with selectors only",async()=>{
 const {SourceChatRoutines}=await import("../../desktop/src/renderer/src/features/chat/SourceChatRoutines");
 desktopHandoff.destination.mockResolvedValue({connection:{platformHost:"https://app.example.test"},computer:{gatewayPath:"/vm/fixture?runtime=dev"},current:()=>true});
 const {chat,client,resolve}=fixture(true);render(<SourceChatRoutines client={client} chat={chat} ordinary revision={0}/>);
 fireEvent.click(await screen.findByRole("button",{name:"Review in browser"}));
 await screen.findByRole("status");expect(desktopHandoff.invoke).toHaveBeenCalledWith("shell:open-external",{url:`https://app.example.test/vm/fixture/routine-cli/confirm?runtime=dev&originChat=${chat.id}&interaction=in_abcdefgh`});
 expect(resolve).not.toHaveBeenCalled();expect(screen.queryByRole("button",{name:"Persistent task"})).toBeNull();
});
