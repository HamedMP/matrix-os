// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { BotInteraction, RoutineChatOriginView } from "@matrix-os/contracts";
import { createRoutineOriginClient } from "../../packages/ui/src/chat/routine-origin-client";
import { useRoutineOrigin } from "../../packages/ui/src/chat/use-routine-origin";
import { RoutineOriginApprovals } from "../../packages/ui/src/chat/RoutineOriginApprovals";
import { routineReceiptMessage } from "../../packages/ui/src/chat/routine-receipt";
import { usePersistentTaskSelection } from "../../packages/ui/src/chat/use-persistent-task-selection";
import { nativeScheduledMessageFixture } from "../helpers/native-scheduled-message-fixture";
afterEach(cleanup);
const interaction: BotInteraction = {interactionId:"in_abcdefgh",chatId:"chat_executor",agentId:"bot_existing",taskId:"task_real_execution",kind:"approval",blocking:true,status:"pending",expiresAt:"2099-01-01T00:00:00.000Z",revision:7,payload:{kind:"approval",tool:"routine.activate",audience:"direct",policyRevision:3,argsDigest:"a".repeat(64),preview:JSON.stringify({proposal:{name:"Morning brief",prompt:"Write a private brief.",schedule:{kind:"once",at:"2099-01-01T00:00:00.000Z"},selection:{instanceId:"matrix_chatgpt_plan",model:"gpt-6-luna"},authorizedEffects:["read"]},source:{accountId:"account_private",computerId:"computer_fixture",grantRevision:3,definitionRevision:2}})}};
const view = (): RoutineChatOriginView => ({sourceChatId:"chat_source",pending:[{sourceChatId:"chat_source",anchorMessageId:"msg_source",interaction}],deliveries:[],deliveryPending:false,hasMore:false});
it("uses the source alias and unchanged canonical interaction revision, without a Bot binding context", async () => {
 const request=vi.fn(async (_p:string, method:string)=>method==="GET"?view():{interaction:{...interaction,status:"resolved",revision:8}});
 const client=createRoutineOriginClient(request);
 function Fixture(){const state=useRoutineOrigin({client,chatId:"chat_source",eligible:true});return <RoutineOriginApprovals state={state}/>;}
 render(<Fixture/>);
 fireEvent.click(await screen.findByRole("button",{name:"Approve schedule"}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith("/api/chats/chat_source/routine-origin/in_abcdefgh/resolve","POST",{kind:"approval",baseRevision:7,decision:"approve"},expect.anything()));
 expect(request.mock.calls.some(([p])=>p.includes("chat_executor/interactions"))).toBe(false);
});
it("reconciles a lost acknowledgment before enabling another explicit decision; never retries mutation",async()=>{
 let reads=0;const get=vi.fn(async()=>++reads===1?view():{...view(),pending:[]});const resolve=vi.fn(async()=>{throw new TypeError("connection lost secret");});
 const client={get,resolve};const {result}=renderHook(()=>useRoutineOrigin({client,chatId:"chat_source",eligible:true}));
 await waitFor(()=>expect(result.current.fresh).toBe(true));
 await act(async()=>{await expect(result.current.resolve(interaction,{kind:"approval",baseRevision:7,decision:"approve"})).rejects.toThrow();});
 expect(resolve).toHaveBeenCalledTimes(1);expect(get).toHaveBeenCalledTimes(2);expect(result.current.view?.pending).toEqual([]);
});
it("fences retained decisions and late reads across source/client changes including A to B to A",async()=>{
 const get=vi.fn(async()=>view()),resolve=vi.fn();const client={get,resolve};
 const {result,rerender}=renderHook(({chatId})=>useRoutineOrigin({client,chatId,eligible:true}),{initialProps:{chatId:"chat_source"}});
 await waitFor(()=>expect(result.current.fresh).toBe(true)); const retained=result.current.resolve;
 rerender({chatId:"chat_other"});rerender({chatId:"chat_source"});
 await act(async()=>{await expect(retained(interaction,{kind:"approval",baseRevision:7,decision:"approve"})).rejects.toThrow();});
 expect(resolve).not.toHaveBeenCalled();
});
it("accepts only server stored committed source receipt parts, never wording or user metadata",()=>{
 const d=nativeScheduledMessageFixture();const m={...d.messages[0]!,turnId:undefined,runId:undefined};
 const receipt={type:"routine_receipt" as const,engine:"matrix" as const,kind:"output" as const,routineId:`rt_${"a".repeat(24)}`,fireId:`fire_${"b".repeat(24)}`,attempt:1,status:"completed" as const,scheduledFor:m.createdAt,canonicalChatId:"chat_executor",canonicalTaskId:"task_real_execution",model:"gpt-6-luna"};
 const message={...m,parts:[{type:"text" as const,text:"Real committed result"},receipt]};
 expect(routineReceiptMessage(message,m.chatId)).toEqual(receipt);
 for(const change of [{role:"user"},{state:"pending"},{turnId:"cturn_foreground"},{chatId:"chat_other"},{parts:[{type:"text",text:JSON.stringify(receipt)}]}]) expect(routineReceiptMessage({...message,...change} as typeof message,m.chatId)).toBeUndefined();
 expect(d.turns).toHaveLength(1);expect(d.runs).toHaveLength(1);
});
it("consumes explicit creation once and fences old selectors across identity changes",()=>{
 const {result,rerender}=renderHook(({scope})=>usePersistentTaskSelection({scope,eligible:true}),{initialProps:{scope:"ownerA/chatA"}});
 expect(result.current.selected).toBe(false);act(()=>result.current.select(true));expect(result.current.selected).toBe(true);
 let route:unknown;act(()=>{route=result.current.consume();});expect(route).toBe("matrix");expect(result.current.selected).toBe(false);expect(result.current.consume()).toBeUndefined();
 const retained=result.current.select;rerender({scope:"ownerB/chatB"});act(()=>retained(true));expect(result.current.selected).toBe(false);
});
it("retains the explicit route for reconciliation of the same request after the selector resets",()=>{
 const {result}=renderHook(()=>usePersistentTaskSelection({scope:"same-owner-chat",eligible:true}));act(()=>result.current.select(true));
 let route:unknown;act(()=>{route=result.current.consume("req_exact_submit");});expect(route).toBe("matrix");expect(result.current.selected).toBe(false);
 expect(result.current.consume("req_exact_submit")).toBe("matrix");expect(result.current.consume("req_next_submit")).toBeUndefined();
});
it("retains the saved-decision notice after the resolved approval disappears from the fresh source read",async()=>{
 let reads=0;const client={get:vi.fn(async()=>++reads===1?view():{...view(),pending:[]}),resolve:vi.fn(async()=>({interaction:{interactionId:interaction.interactionId,status:"resolved" as const,revision:8},continuationPending:true as const}))};
 const {result}=renderHook(()=>useRoutineOrigin({client,chatId:"chat_source",eligible:true}));await waitFor(()=>expect(result.current.fresh).toBe(true));await act(async()=>{await result.current.resolve(interaction,{kind:"approval",decision:"approve",baseRevision:7});});
 expect(result.current.view?.pending).toEqual([]);expect(result.current.notice).toContain("Your decision was saved");expect(client.resolve).toHaveBeenCalledTimes(1);
});
it("removes the private preview on read failure and rejects a callback retained from the earlier successful read",async()=>{
 const get=vi.fn().mockResolvedValueOnce(view()).mockRejectedValue(new Error("unavailable"));
 const client={get,resolve:vi.fn()};const {result}=renderHook(()=>useRoutineOrigin({client,chatId:"chat_source",eligible:true}));
 await waitFor(()=>expect(result.current.fresh).toBe(true));const retained=result.current.resolve;
 act(()=>result.current.refresh());await waitFor(()=>expect(result.current.fresh).toBe(false));
 expect(result.current.view).toBeNull();
 await expect(retained(interaction,{kind:"approval",decision:"approve",baseRevision:7})).rejects.toThrow();expect(client.resolve).not.toHaveBeenCalled();
});
it("pins a lost acknowledgment to the exact decision and revision when the canonical read still shows it pending",async()=>{
 const client={get:vi.fn(async()=>view()),resolve:vi.fn().mockRejectedValueOnce(new TypeError("lost")).mockResolvedValue({interaction:{...interaction,status:"resolved",revision:8}})};
 const {result}=renderHook(()=>useRoutineOrigin({client,chatId:"chat_source",eligible:true}));
 await waitFor(()=>expect(result.current.fresh).toBe(true));
 await act(async()=>{await expect(result.current.resolve(interaction,{kind:"approval",decision:"approve",baseRevision:7})).rejects.toThrow();});
 await act(async()=>{await expect(result.current.resolve(interaction,{kind:"approval",decision:"deny",baseRevision:7})).rejects.toThrow();});
 expect(client.resolve).toHaveBeenCalledTimes(1);
 await act(async()=>{await result.current.resolve(interaction,{kind:"approval",decision:"approve",baseRevision:7});});expect(client.resolve).toHaveBeenCalledTimes(2);
});
it("cancels a pending decision transport when the source loses eligibility",async()=>{
 let signal:AbortSignal|undefined;let finish!:()=>void;
 const resolve=vi.fn(async (_chat:string,_id:string,_input:unknown,token?:AbortSignal)=>{signal=token;await new Promise<void>(r=>{finish=r;});throw new Error("offline");});
 const client={get:vi.fn(async()=>view()),resolve};const {result,rerender}=renderHook(({eligible})=>useRoutineOrigin({client,chatId:"chat_source",eligible}),{initialProps:{eligible:true}});
 await waitFor(()=>expect(result.current.fresh).toBe(true));let request!:Promise<unknown>;
 act(()=>{request=result.current.resolve(interaction,{kind:"approval",decision:"deny",baseRevision:7}).catch(()=>undefined);});rerender({eligible:false});
 const aborted=signal?.aborted;await act(async()=>{finish();await request;});expect(aborted).toBe(true);
});
it("consumes the route only once even when an old submit callback is invoked before React re-renders",()=>{
 const {result}=renderHook(()=>usePersistentTaskSelection({scope:"owner/chat",eligible:true}));act(()=>result.current.select(true));
 const consume=result.current.consume;act(()=>{expect(consume("first")).toBe("matrix");expect(consume("second")).toBeUndefined();});
});
it("rejects a retained explicit submit rather than interpreting a scope change as the native default",()=>{
 const {result,rerender}=renderHook(({scope})=>usePersistentTaskSelection({scope,eligible:true}),{initialProps:{scope:"ownerA/chatA"}});
 act(()=>result.current.select(true));const oldSubmit=result.current.consume;rerender({scope:"ownerB/chatB"});
 expect(()=>oldSubmit("delayed-file-read")).toThrow();
});
it("shows the Schedules navigation hint even when only past deliveries overflow the source view",async()=>{
 const client={get:vi.fn(async()=>({...view(),hasMore:true,pending:[]})),resolve:vi.fn()};
 function Fixture(){return <RoutineOriginApprovals state={useRoutineOrigin({client,chatId:"chat_source",eligible:true})}/>;}
 render(<Fixture/>);expect(await screen.findByText(/More scheduled task items are available in Schedules/)).toBeTruthy();
});
