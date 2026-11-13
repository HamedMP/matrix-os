// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {ChatApp} from "../../shell/src/components/ChatApp";
import {createCanonicalProviderCatalogFixture} from "../contracts/fixtures/canonical-chat";
import type {ChatAgentClient} from "@matrix-os/ui";
vi.mock("@clerk/nextjs",()=>({useOrganization:()=>({organization:null}),useAuth:()=>({userId:null,sessionId:null})}));
vi.mock("../../shell/src/components/chat-provider-onboarding",()=>({ChatProviderOnboarding:({children}:{children:React.ReactNode})=><>{children}</>}));
beforeEach(()=>{const data=new Map<string,string>();vi.stubGlobal("localStorage",{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k),clear:()=>data.clear()});vi.stubGlobal("fetch",vi.fn(async()=>Response.json(createCanonicalProviderCatalogFixture())));vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("submits scheduling requests as conversation without a scheduler selector or client route flag",async()=>{
 const submit=vi.fn<React.ComponentProps<typeof ChatApp>["onSubmit"]>(async()=>true),directBot=vi.fn(async()=>null);
 const originRead=vi.fn(async()=>({sourceChatId:"chat_source",pending:[],deliveries:[],hasMore:false}));
 const api={bots:{directBot,routineOrigin:{get:originRead,resolve:vi.fn()},tasks:vi.fn(async()=>[]),interactions:vi.fn(async()=>[])},list:vi.fn(async()=>({enabled:true,agents:[]}))} as unknown as ChatAgentClient;
 render(<ChatApp messages={[{id:"msg_source",role:"assistant",content:"Ready",timestamp:0}]} sessionId="chat_source" agentClient={api} busy={false} connected navigationFresh isCurrentAuthority={()=>true} conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={submit} routineFullAccessChat={{id:"chat_source",ownerScope:{type:"personal",ownerId:"owner"},lifecycle:"active"}}/>);
 const input=screen.getByRole("textbox",{name:"Message chat"});
 await waitFor(()=>expect((input as HTMLTextAreaElement).disabled).toBe(false));
 await waitFor(()=>expect(originRead).toHaveBeenCalled());
 expect(screen.queryByRole("button",{name:"Persistent task"})).toBeNull();
 expect(screen.queryByRole("combobox",{name:"Routine destination"})).toBeNull();
 const request="Every morning at 9, summarize my tasks.";
 fireEvent.change(input,{target:{value:request}});fireEvent.click(screen.getByRole("button",{name:"Send"}));
 await waitFor(()=>expect(submit).toHaveBeenCalledTimes(1));
 expect(submit.mock.calls[0]![0]).toBe(request);expect(submit.mock.calls[0]![2]).not.toHaveProperty("routineCreation");
 fireEvent.change(input,{target:{value:"What is on my calendar?"}});fireEvent.click(screen.getByRole("button",{name:"Send"}));
 await waitFor(()=>expect(submit).toHaveBeenCalledTimes(2));expect(submit.mock.calls[1]![2]).not.toHaveProperty("routineCreation");
});
it("does not read source approvals from a mismatched private Chat detail",async()=>{
 const directBot=vi.fn(async()=>null),get=vi.fn(async()=>({sourceChatId:"chat_current",pending:[],deliveries:[],hasMore:false}));
 const client={bots:{directBot,routineOrigin:{get}},list:vi.fn(async()=>({enabled:true,agents:[]}))} as unknown as ChatAgentClient;
 render(<ChatApp messages={[{id:"msg_current",role:"assistant",content:"Ready",timestamp:0}]} sessionId="chat_current" agentClient={client} busy={false} connected navigationFresh isCurrentAuthority={()=>true} conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
  routineFullAccessChat={{id:"chat_previous",ownerScope:{type:"personal",ownerId:"owner"},lifecycle:"active"}}/>);
 await waitFor(()=>expect(directBot).toHaveBeenCalled());expect(get).not.toHaveBeenCalled();
});
it("the canonical Web Chat client reaches the strict origin API for reads and exact decisions",async()=>{
 const {createCanonicalShellChatClient}=await import("../../shell/src/lib/canonical-chat-client");
 const {createRoutineOriginRoutes}=await import("../../packages/gateway/src/bots/routine-origin-routes");
 const read=vi.fn(async()=>({sourceChatId:"chat_source",pending:[],deliveries:[],hasMore:false,deliveryPending:false}));
 const response={interaction:{interactionId:"in_abcdefgh",status:"resolved" as const,revision:8}};
 const resolve=vi.fn(async()=>({response}));
 const routes=createRoutineOriginRoutes({service:{read,resolve},getPrincipal:()=>({userId:"owner",source:"jwt"}),
   handle:"test-pc",machineId:"machine",runtimeSlot:"primary",verifyApproval:vi.fn(async()=>({sessionId:"owner-session"}) as never),admitContinuation:vi.fn()});
 // Model only the trusted proxy session for this transport test. Production clients never send the proof header.
 const {ROUTINE_ORIGIN_PROOF_HEADER}=await import("@matrix-os/contracts");
 const fetchFn:typeof fetch=async(url,options)=>{const req=new Request(url,options);if(req.method==="POST")req.headers.set(ROUTINE_ORIGIN_PROOF_HEADER,"proxy-fixture");return routes.fetch(req);};
 const client=createCanonicalShellChatClient({gatewayUrl:"https://fixture.test",fetchFn}).agents!.bots!.routineOrigin!;
 await expect(client.get("chat_source")).resolves.toMatchObject({sourceChatId:"chat_source"});
 await expect(client.resolve("chat_source","in_abcdefgh",{kind:"approval",decision:"approve",baseRevision:7})).resolves.toEqual(response);
 expect(read).toHaveBeenCalledTimes(1);expect(resolve).toHaveBeenCalledTimes(1);
});
it("Electron retains the selected runtime while reading the same strict origin route",async()=>{
 const {createApiClient}=await import("../../desktop/src/renderer/src/lib/api");
 const {createCanonicalChatClient}=await import("../../desktop/src/renderer/src/lib/canonical-chat-client");
 const {createRoutineOriginRoutes}=await import("../../packages/gateway/src/bots/routine-origin-routes");
 const {buildForwardedQueryString}=await import("../../packages/platform/src/request-routing");
 const {readExplicitVmRoute}=await import("../../packages/platform/src/session-routing-identity");
 const read=vi.fn(async()=>({sourceChatId:"chat_source",pending:[],deliveries:[],hasMore:false,deliveryPending:false}));
 const routes=createRoutineOriginRoutes({service:{read,resolve:vi.fn()},getPrincipal:()=>({userId:"owner",source:"jwt"}),handle:"test-pc",machineId:"machine",runtimeSlot:"dev",verifyApproval:vi.fn(),admitContinuation:vi.fn()});
 const fetchFn=vi.fn(async(url:string,options?:RequestInit)=>{const current=new URL(url);return routes.request((readExplicitVmRoute(current.pathname)?.upstreamPath??current.pathname)+buildForwardedQueryString(url),options);});
 const api=createApiClient({baseUrl:"https://fixture.test/vm/test-pc",getRuntimeSlot:()=>"dev",fetchFn});
 const origin=createCanonicalChatClient(api).agents!.bots!.routineOrigin!;
 await expect(origin.get("chat_source")).resolves.toMatchObject({sourceChatId:"chat_source"});expect(new URL(fetchFn.mock.calls[0]![0]).search).toBe("?timeline=1&runtime=dev");
 await expect(api.get("/api/chats/chat_source/routine-origin?forged=value")).rejects.toMatchObject({httpStatus:400});expect(read).toHaveBeenCalledOnce();
});
