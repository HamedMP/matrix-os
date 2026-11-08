// @vitest-environment jsdom
import React from "react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {cleanup, render, screen, within} from "@testing-library/react";
import {BotChatPanel} from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import {createBotRoutineClient} from "../../../packages/ui/src/chat-agents/bots/routine-client.js";
import {ConversationTranscript} from "../../../desktop/src/renderer/src/components/conversation/transcript";
import {canonicalChatPresentation} from "../../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import {createCanonicalChatFixture} from "../../contracts/fixtures/canonical-chat";
import {clientFixture, saved} from "../../desktop/chat-agents-fixture";
import type {ChatAgentClient} from "../../../packages/ui/src/chat-agents/client.js";

const fireId="fire_"+"a".repeat(24), routineId="rt_"+"a".repeat(24);
function fixture({admitted=true, otherChat=false, live=true, requestId=`req_routine_${fireId}`}={}) {
  const {snapshot}=createCanonicalChatFixture("completed");
  snapshot.turns[0]!.clientRequestId=requestId;
  snapshot.messages[0]!.parts=[{type:"text",text:"Return READY."}];
  const fire={fireId,taskId:"task_scheduled_01",scheduledFor:"2026-08-24T23:59:00.000Z",status:admitted?"completed":"failed",attempts:admitted?1:0,failureCode:admitted?null:"background_not_authorized",updatedAt:"2026-08-25T00:00:00.000Z"};
  const row={routineId,botId:saved.id,chatId:otherChat?"chat_other_owner":snapshot.chat.id,
    proposal:{name:"Private schedule",prompt:"Return READY.",schedule:{kind:"cron",expr:"* * * * *",tz:"Asia/Shanghai"},selection:{instanceId:"matrix_chatgpt_plan",model:"gpt-6-luna"},authorizedEffects:["read"]},
    computerId:"Preview",status:"archived",revision:1,nextFireAt:null,requiresReview:false,targetAvailable:true,sourceAvailable:false,lastFire:fire};
  const request=vi.fn(async(path:string,method:string)=>{
    if(method!=="GET")throw new Error("Unexpected mutation");
    if(path.startsWith("/api/bot-routines?"))return {items:path.includes("archived=true")?[row]:[],pending:[],nextCursor:null};
    if(path==="/api/bot-routines")return {items:[],pending:[],nextCursor:null};
    if(path===`/api/bot-routines/${routineId}`)return {routine:row,history:[fire]};
    throw new Error("Unexpected path");
  });
  const base=clientFixture();base.list.mockResolvedValue({enabled:true,agents:live?[{...saved,recipeRef:{recipeId:"writer",version:"1"}}]:[]});
  const client={...base,bots:{routines:createBotRoutineClient(request),tasks:async()=>[],interactions:async()=>[],authority:async()=>null}} as unknown as ChatAgentClient;
  const turns=admitted?canonicalChatPresentation(snapshot):[];
  return {chatId:snapshot.chat.id,client,turns,request,fire};
}
beforeEach(()=>{globalThis.ResizeObserver=class{observe(){} unobserve(){} disconnect(){}} as typeof ResizeObserver;});
afterEach(cleanup);

it.each([true,false])("labels the exact scheduled input with live Bot=%s, without a top panel or duplicate prompt",async live=>{
  const f=fixture({live});
  render(<BotChatPanel client={f.client} chatId={f.chatId} directBotId={saved.id}><ConversationTranscript turns={f.turns} callbacks={{copyText:vi.fn()}}/></BotChatPanel>);
  const marker=await screen.findByText("Sent by scheduled task");
  const message=screen.getByText("Return READY.").closest('[data-message-id]')!;
  expect(within(message as HTMLElement).getByText("Sent by scheduled task")).toBe(marker);
  expect(screen.getAllByText("Return READY.")).toHaveLength(1);
  expect(screen.queryByText("Scheduled task history")).toBeNull();
  expect(screen.queryByText(/View history/)).toBeNull();
  expect(f.request.mock.calls.every(([,method])=>method==="GET")).toBe(true);
});

it("keeps an unadmitted failure in the message flow at its own timestamp without implying a sent message",async()=>{
  const f=fixture({admitted:false});
  render(<BotChatPanel client={f.client} chatId={f.chatId} directBotId={saved.id}><ConversationTranscript turns={f.turns} callbacks={{copyText:vi.fn()}}/></BotChatPanel>);
  const prompt=await screen.findByText("Scheduled task did not run");
  expect(prompt.closest('[data-message-id]')).toBeTruthy();
  expect(screen.getByText("Scheduled task did not run")).toBeTruthy();
  expect(screen.queryByText("Return READY.")).toBeNull();
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
  expect(screen.queryByText("background_not_authorized")).toBeNull();
  expect(screen.queryByText("Scheduled task history")).toBeNull();
});

it("does not label a manual message merely because its text matches a routine prompt",async()=>{
  const f=fixture({requestId:"req_manual_message"});
  const view=render(<BotChatPanel client={f.client} chatId={f.chatId} directBotId={saved.id}><ConversationTranscript turns={f.turns} callbacks={{copyText:vi.fn()}}/></BotChatPanel>);
  // The durable occurrence can render separately, but it must never be attached to the manual message.
  const bubble=screen.getByText("Return READY.").closest('[data-message-id]')!;
  expect(within(bubble as HTMLElement).queryByText("Sent by scheduled task")).toBeNull();
  view.unmount();
});
it("keeps a neutral occurrence when a retained turn no longer includes its input bubble",async()=>{
  const f=fixture();f.turns[0]!.user=undefined;
  render(<BotChatPanel client={f.client} chatId={f.chatId} directBotId={saved.id}><ConversationTranscript turns={f.turns} callbacks={{copyText:vi.fn()}}/></BotChatPanel>);
  expect(await screen.findByText("Scheduled task completed")).toBeTruthy();
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
});
it.each([0,5])("places an occurrence after the original input even when the latest attempt starts %s minutes later",async startMinute=>{
  const f=fixture({requestId:"req_manual_long"});
  f.fire.scheduledFor="2026-08-25T00:02:00.000Z";
  f.turns[0]!.startedAt=Date.parse(`2026-08-25T00:0${startMinute}:00Z`);
  f.turns[0]!.endedAt=Date.parse("2026-08-25T00:06:00Z");
  f.turns[0]!.final={kind:"message",id:"msg_late_reply",role:"assistant",phase:"final",markdown:"Later manual reply",copyText:"Later manual reply",timestamp:f.turns[0]!.endedAt};
  render(<BotChatPanel client={f.client} chatId={f.chatId} directBotId={saved.id}><ConversationTranscript turns={f.turns} callbacks={{copyText:vi.fn()}}/></BotChatPanel>);
  const status=await screen.findByText(/^Scheduled task completed/);
  expect(screen.getByText("Return READY.").compareDocumentPosition(status)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(status.compareDocumentPosition(screen.getByText("Later manual reply"))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
