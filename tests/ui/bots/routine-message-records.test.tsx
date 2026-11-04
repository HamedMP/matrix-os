// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {readRoutineMessages,useRoutineMessages} from "../../../packages/ui/src/chat-agents/bots/use-routine-messages.js";
import {routineMessageTimeline,routineRequestFireId} from "../../../packages/ui/src/chat-agents/bots/routine-transcript.js";
import {RoutineOccurrenceMessage} from "../../../packages/ui/src/chat-agents/bots/RoutineMessage.js";
import {UserMessage} from "../../../desktop/src/renderer/src/components/conversation/user-message";
import type {BotRoutineClient} from "../../../packages/ui/src/chat-agents/bots/routine-client.js";
import {routineMessageFixture} from "../../helpers/routine-message-fixture";

afterEach(cleanup);
function apiFor(...saved:ReturnType<typeof routineMessageFixture>[]){
  return{list:vi.fn(async()=>({items:saved.map(row=>row.routine),pending:[],nextCursor:null})),detail:vi.fn(async(id:string)=>saved.find(row=>row.routine.routineId===id)!),control:vi.fn(),review:vi.fn()} satisfies BotRoutineClient;
}
it("filters other Chats before reading details and rejects a drifting detail identity",async()=>{
  const own=routineMessageFixture(),other=routineMessageFixture("chat_other","b"),api=apiFor(own,other);
  api.detail.mockResolvedValue(other);
  const result=await readRoutineMessages(api,"chat_owner");
  expect(result.occurrences).toEqual([]);expect(result.failed).toBe(true);
  expect(api.detail).toHaveBeenCalledExactlyOnceWith(own.routine.routineId);
  expect(api.control).not.toHaveBeenCalled();expect(api.review).not.toHaveBeenCalled();
});
it("follows archived pages to find this Chat without accumulating foreign data",async()=>{
  const own=routineMessageFixture(),api=apiFor(own),cursor={before:"2026-11-01T00:00:00Z",beforeId:"rt_"+"b".repeat(24)};
  api.list.mockImplementation(async query=>({items:query?.before?[own.routine]:[],pending:[],nextCursor:query?.archived&&!query.before?cursor:null}));
  const read=await readRoutineMessages(api,"chat_owner");
  expect(read.occurrences).toHaveLength(1);
  expect(api.list).toHaveBeenCalledWith({...cursor,archived:"true"});
});
it("keeps already read records and safe incomplete state when a refresh cannot list tasks",async()=>{
  const own=routineMessageFixture(),api=apiFor(own);
  const first=await readRoutineMessages(api,"chat_owner");
  api.list.mockRejectedValue(new Error("secret /home/private"));
  const second=await readRoutineMessages(api,"chat_owner",first.saved);
  expect(second.failed).toBe(true);expect(second.occurrences).toEqual(first.occurrences);
});
it("uses bounded current/archived reads and avoids rereading unchanged durable details",async()=>{
  const own=routineMessageFixture(),api=apiFor(own),cursor={before:"2026-11-01T00:00:00Z",beforeId:own.routine.routineId};
  api.list.mockResolvedValue({items:[own.routine],pending:[],nextCursor:cursor});
  const first=await readRoutineMessages(api,"chat_owner");
  expect(api.list).toHaveBeenCalledTimes(8);expect(first.incomplete).toBe(true);
  await readRoutineMessages(api,"chat_owner",first.saved);
  expect(api.detail).toHaveBeenCalledTimes(1);
});
it("inserts unadmitted failures between messages while retaining actual message order and removing duplicates after admission",()=>{
  const saved=routineMessageFixture(),occurrence={routine:saved.routine,fire:saved.history[0]!};
  const messages=[{id:"before",at:Date.parse("2026-11-02T00:59:00Z"),request:"req_manual"},{id:"after",at:Date.parse("2026-11-02T01:01:00Z"),request:"req_manual2"}];
  const rows=routineMessageTimeline(messages,[occurrence],message=>message.request,message=>message.at);
  expect(rows.map(row=>row.kind==="message"?row.value.id:row.occurrence.fire.fireId)).toEqual(["before",saved.history[0]!.fireId,"after"]);
  const admitted=[...messages,{id:"scheduled",at:Date.parse("2026-11-02T01:00:02Z"),request:`req_routine_${occurrence.fire.fireId}_a2`}];
  const merged=routineMessageTimeline(admitted,[occurrence],message=>message.request,message=>message.at);
  expect(merged.filter(row=>row.kind==="occurrence")).toHaveLength(0);
  expect(merged.map(row=>row.kind==="message"?row.value.id:"")).toEqual(["before","after","scheduled"]);
});
it("never derives scheduled identity from prompt text, loose IDs or unsupported retry suffixes",()=>{
  const id="fire_"+"a".repeat(24);
  expect(routineRequestFireId(`req_routine_${id}`)).toBe(id);
  expect(routineRequestFireId(`req_routine_${id}_a3`)).toBe(id);
  for(const value of [`req_routine_${id}_a4`,`Please run req_routine_${id}`,`req_routine_${id}suffix`,null])expect(routineRequestFireId(value)).toBeUndefined();
});
it("drops a delayed old-Chat response and does not read when the transcript is hidden",async()=>{
  const old=routineMessageFixture("chat_old"),next=routineMessageFixture("chat_new","b"),api=apiFor(old,next);
  let finish!:(value:ReturnType<typeof routineMessageFixture>)=>void;
  api.detail.mockImplementation(id=>id===old.routine.routineId?new Promise(resolve=>{finish=resolve;}):Promise.resolve(next));
  function Probe({chatId,enabled=true}:{chatId:string;enabled?:boolean}){const state=useRoutineMessages(api,chatId,enabled);return <>{state.occurrences.map(row=><p key={row.fire.fireId}>{row.routine.chatId}</p>)}</>;}
  const view=render(<Probe chatId="chat_old"/>);
  await waitFor(()=>expect(finish).toBeTypeOf("function"));
  view.rerender(<Probe chatId="chat_new"/>);
  await screen.findByText("chat_new");
  await act(async()=>finish(old));
  expect(screen.queryByText("chat_old")).toBeNull();
  view.rerender(<Probe chatId="chat_new" enabled={false}/>);
  expect(screen.queryByText("chat_new")).toBeNull();
});
it("expands a long scheduled message in place without duplicating the prompt",()=>{
  const own=routineMessageFixture(),prompt="Read only fixed acceptance text. ".repeat(35);
  own.routine.proposal.prompt=prompt;
  render(<UserMessage scheduled={{routine:own.routine,fire:own.history[0]!}} message={{kind:"message",id:"msg_long",role:"user",phase:"commentary",markdown:prompt,copyText:prompt,timestamp:0}} callbacks={{copyText:vi.fn()}}/>);
  const text=screen.getByText(prompt.trim());
  expect(text.closest("[data-message-preview-content]")?.hasAttribute("inert")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Show full message"}));
  expect(screen.getAllByText(prompt.trim())).toHaveLength(1);expect(text.closest("[data-message-preview-content]")?.hasAttribute("inert")).toBe(false);
});

it("does not turn the current edited definition into an old failed input",()=>{
  const own=routineMessageFixture();own.routine.proposal.prompt="NEW text approved after this old occurrence";
  render(<RoutineOccurrenceMessage occurrence={{routine:own.routine,fire:own.history[0]!}}/>);
  expect(screen.getByText("Scheduled task did not run")).toBeTruthy();
  expect(screen.queryByText(own.routine.proposal.prompt)).toBeNull();
});
it("discloses the producer's recent-run boundary instead of silently losing older markers",async()=>{
  const own=routineMessageFixture(),api=apiFor(own);
  own.history=Array.from({length:20},(_,i)=>({...own.history[0]!,fireId:"fire_"+i.toString(16).padStart(24,"0")}));
  const result=await readRoutineMessages(api,"chat_owner");
  expect(result.occurrences).toHaveLength(20);expect(result.incomplete).toBe(true);
});
it("retains a same-scope successful snapshot through failed Retry and fences repeated in-flight Retry",async()=>{
  const own=routineMessageFixture(),api=apiFor(own);
  function Probe(){const state=useRoutineMessages(api,"chat_owner");return <>{state.occurrences.map(row=><p key={row.fire.fireId}>Saved occurrence</p>)}{state.failed?<p>Read unavailable</p>:null}<button onClick={state.retry}>Retry read</button></>;}
  render(<Probe/>);await screen.findByText("Saved occurrence");
  api.list.mockRejectedValue(new Error("offline"));
  fireEvent.click(screen.getByRole("button",{name:"Retry read"}));
  await screen.findByText("Read unavailable");
  expect(screen.getByText("Saved occurrence")).toBeTruthy();
  const pending:Array<(value:{items:never[];pending:never[];nextCursor:null})=>void>=[];
  api.list.mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
  const before=api.list.mock.calls.length;
  fireEvent.click(screen.getByRole("button",{name:"Retry read"}));
  fireEvent.click(screen.getByRole("button",{name:"Retry read"}));
  expect(api.list.mock.calls.length-before).toBe(1);
  cleanup();await act(async()=>{for(const resolve of pending)resolve({items:[],pending:[],nextCursor:null});});
});
