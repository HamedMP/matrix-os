import {openRoutineHistory} from "../lib/open-routine-history";
import type {BotInteraction,RoutineChatOriginView} from "@matrix-os/contracts";
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react-native";
import {Linking} from "react-native";
import {NativeSourceChatRoutines} from "../components/chat/NativeSourceChatRoutines";
import {NativeRoutineReceipt} from "../components/chat/NativeRoutineReceipt";
const mockShowChat=jest.fn();
const mockSelectChat=jest.fn(),mockGetToken=jest.fn(async()=>"fixture-token");
const emptyView=():RoutineChatOriginView=>({sourceChatId:"chat_source",pending:[],deliveries:[],hasMore:false,deliveryPending:false});
const mockClient={get:jest.fn(async():Promise<RoutineChatOriginView>=>emptyView()),resolve:jest.fn()};
const interaction:BotInteraction={interactionId:"in_abcdefgh",chatId:"chat_executor",agentId:"bot_existing",taskId:"task_execution",kind:"approval",blocking:true,status:"pending",expiresAt:"2099-01-01T00:00:00.000Z",revision:7,payload:{kind:"approval",tool:"routine.activate",audience:"direct",policyRevision:3,argsDigest:"a".repeat(64),preview:JSON.stringify({proposal:{name:"Morning brief",prompt:"Write a private brief.",schedule:{kind:"once",at:"2099-01-01T00:00:00.000Z"},selection:{instanceId:"matrix_chatgpt_plan",model:"gpt-6-luna"},authorizedEffects:["read"]},source:{accountId:"account_private",computerId:"computer_fixture",grantRevision:3,definitionRevision:2}})}};
const pendingView=():RoutineChatOriginView=>({...emptyView(),pending:[{sourceChatId:"chat_source",anchorMessageId:"msg_source",interaction}]});
jest.mock("@clerk/clerk-expo",()=>({useAuth:()=>({getToken:mockGetToken,userId:"owner",sessionId:"session"})}));
jest.mock("@/lib/canonical-chat-session-context",()=>({useCanonicalChatSession:()=>({selectChat:mockSelectChat})}));
jest.mock("@/lib/use-shell-navigation",()=>({useShowChatScreen:()=>mockShowChat}));
jest.mock("expo/fetch",()=>({fetch:jest.fn()}));
jest.mock("micromark",()=>({micromark:jest.fn()}));
jest.mock("micromark-extension-gfm",()=>({gfm:jest.fn(),gfmHtml:jest.fn()}));
jest.mock("@matrix-os/ui/routine-origin",()=>({...jest.requireActual("@matrix-os/ui/routine-origin"),createRoutineOriginClient:()=>mockClient}));
afterEach(()=>{cleanup();jest.restoreAllMocks();mockSelectChat.mockReset();mockShowChat.mockReset();mockClient.get.mockReset().mockImplementation(async()=>emptyView());mockClient.resolve.mockReset();});
it("keeps Native Mobile scheduling conversational without a persistent creation button",async()=>{
 const open=jest.spyOn(Linking,"openURL").mockResolvedValue(undefined);
 render(<NativeSourceChatRoutines gatewayUrl="https://app.matrix-os.com/vm/fixture?runtime=primary" chatId="chat_source" eligible/>);
 await waitFor(()=>expect(mockClient.get).toHaveBeenCalled());
 expect(screen.queryByRole("button",{name:"Persistent task"})).toBeNull();expect(open).not.toHaveBeenCalled();
});
it("reviews an existing approval in the real source browser without submitting a native decision",async()=>{
 mockClient.get.mockResolvedValueOnce(pendingView());const open=jest.spyOn(Linking,"openURL").mockResolvedValue(undefined);
 render(<NativeSourceChatRoutines gatewayUrl="https://app.matrix-os.com/vm/fixture?runtime=primary" chatId="chat_source" eligible/>);
 fireEvent.press(await screen.findByRole("button",{name:"Review in browser"}));
 await screen.findByText("Continue in your browser to review this scheduled task.");
 expect(open).toHaveBeenCalledWith("https://app.matrix-os.com/vm/fixture/routine-cli/confirm?runtime=primary&originChat=chat_source&interaction=in_abcdefgh");expect(mockClient.resolve).not.toHaveBeenCalled();
});
it("renders an uncertain receipt distinctly and opens its actual canonical history",()=>{
 render(<NativeRoutineReceipt onOpenChat={id=>openRoutineHistory(id,mockSelectChat,mockShowChat)} text="Committed safe output" receipt={{type:"routine_receipt",engine:"matrix",kind:"status",routineId:`rt_${"a".repeat(24)}`,fireId:`fire_${"b".repeat(24)}`,attempt:1,status:"unknown",scheduledFor:"2026-11-06T09:00:00.000Z",canonicalChatId:"chat_executor",canonicalTaskId:"task_real_execution",model:"gpt-6-luna"}}/>);
 expect(screen.getByText("Scheduled task")).toBeTruthy();expect(screen.getByText("Outcome unconfirmed")).toBeTruthy();expect(screen.getByText("Committed safe output")).toBeTruthy();
 fireEvent.press(screen.getByRole("button",{name:"Open execution history"}));expect(mockSelectChat).toHaveBeenCalledWith("chat_executor");expect(mockShowChat).toHaveBeenCalledTimes(1);
});
it("discards an approval browser result if the Chat goes private to shared and back before the open settles",async()=>{
 let finish!:()=>void;const open=jest.spyOn(Linking,"openURL").mockClear().mockImplementation(()=>new Promise<void>(r=>{finish=r;}));
 const host=(eligible:boolean)=><NativeSourceChatRoutines gatewayUrl="https://app.matrix-os.com/vm/fixture" chatId="chat_source" eligible={eligible}/>;
 mockClient.get.mockResolvedValueOnce(pendingView());
 const {rerender}=render(host(true));fireEvent.press(await screen.findByRole("button",{name:"Review in browser"}));
 rerender(host(false));rerender(host(true));await act(async()=>{finish();});
 expect(open).toHaveBeenCalledTimes(1);expect(screen.queryByText("Continue in your browser to review this scheduled task.")).toBeNull();
});
it("offers the same manual refresh after a failed scheduled-task read",async()=>{
 mockClient.get.mockRejectedValueOnce(new Error("offline"));
 render(<NativeSourceChatRoutines gatewayUrl="https://app.matrix-os.com/vm/fixture" chatId="chat_source" eligible/>);
 const retry=await screen.findByRole("button",{name:"Refresh scheduled tasks"});
 fireEvent.press(retry);await waitFor(()=>expect(screen.queryByRole("button",{name:"Refresh scheduled tasks"})).toBeNull());
});
it("shows the source view's overflow notice in Native Mobile",async()=>{
 mockClient.get.mockResolvedValueOnce({...emptyView(),hasMore:true});
 render(<NativeSourceChatRoutines gatewayUrl="https://app.matrix-os.com/vm/fixture" chatId="chat_source" eligible/>);
 expect(await screen.findByText(/More scheduled task items are available in Schedules/)).toBeTruthy();
});
