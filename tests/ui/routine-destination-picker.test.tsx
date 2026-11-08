// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {act,cleanup,renderHook,waitFor} from "@testing-library/react";
import type {ChatAgentClient} from "@matrix-os/ui";
import {useRoutineDestinationPicker} from "../../packages/ui/src/chat/use-routine-destination-picker";
afterEach(cleanup);
const view={availability:"unset",preference:{revision:0,target:null,updatedAt:null}};
function fixture(){const remember=vi.fn(async()=>({availability:"available",preference:{revision:1,target:{botId:"bot_existing",chatId:"chat_executor",bindingCreatedAt:"2026-11-06T00:00:00.000Z"},updatedAt:"2026-11-06T00:00:00.000Z"}})),create=vi.fn();const client={list:vi.fn(async()=>({agents:[{id:"bot_existing",name:"Existing",archived:false,recipeRef:{recipeId:"known",version:"1"}}]})),bots:{routineDestination:{get:vi.fn(async()=>view),remember},directChat:vi.fn(async()=>"chat_executor"),directBot:vi.fn(async()=>"bot_existing"),ensureDirectChat:create}} as unknown as ChatAgentClient;return {client,remember,create};}
it("selects only an existing actual direct Bot using strict destination fields, without creating a Bot or Chat",async()=>{
 const {client,remember,create}=fixture();const {result}=renderHook(()=>useRoutineDestinationPicker(client,true));await waitFor(()=>expect(result.current.pending).toBe(false));
 await act(async()=>result.current.choose("bot_existing"));expect(remember).toHaveBeenCalledWith({botId:"bot_existing",chatId:"chat_executor",baseRevision:0},expect.any(AbortSignal));expect(create).not.toHaveBeenCalled();
});
it.each(["directChat", "directBot"] as const)("preserves confirmed candidates when another %s lookup fails", async failedLookup => {
  const { client, remember } = fixture();
  const library = await client.list();
  vi.mocked(client.list).mockResolvedValue({
    ...library,
    agents: [{ ...library.agents[0]!, id: "bot_unavailable", name: "Unavailable" }, ...library.agents],
  });
  vi.mocked(client.bots!.directChat).mockImplementation(async id => {
    if (id === "bot_existing") return "chat_executor";
    if (failedLookup === "directChat") throw new Error("private request failure");
    return "chat_unavailable";
  });
  vi.mocked(client.bots!.directBot).mockImplementation(async chatId => {
    if (chatId === "chat_executor") return "bot_existing";
    throw new Error("private request failure");
  });
  const { result } = renderHook(() => useRoutineDestinationPicker(client, true));
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.candidates).toEqual([{ botId: "bot_existing", chatId: "chat_executor", name: "Existing" }]);
  expect(result.current.error).toBe("Some routine destinations could not be confirmed. Refresh to check again.");
  await act(async () => result.current.choose("bot_unavailable"));
  expect(remember).not.toHaveBeenCalled();
  await act(async () => result.current.choose("bot_existing"));
  expect(remember).toHaveBeenCalledWith({ botId: "bot_existing", chatId: "chat_executor", baseRevision: 0 }, expect.any(AbortSignal));
  expect(result.current.error).toBe("");
});
it("invalidates a retained picker callback when creation selection changes, including enabled A to B to A",async()=>{
 const {client,remember}=fixture();const {result,rerender}=renderHook(({enabled})=>useRoutineDestinationPicker(client,enabled),{initialProps:{enabled:true}});await waitFor(()=>expect(result.current.pending).toBe(false));const old=result.current.choose;rerender({enabled:false});rerender({enabled:true});await waitFor(()=>expect(result.current.pending).toBe(false));await act(async()=>old("bot_existing"));expect(remember).not.toHaveBeenCalled();
});
it("does not mutate a preference through a callback retained after unmount",async()=>{
 const {client,remember}=fixture();const {result,unmount}=renderHook(()=>useRoutineDestinationPicker(client,true));await waitFor(()=>expect(result.current.pending).toBe(false));
 const choose=result.current.choose;unmount();await choose("bot_existing");expect(remember).not.toHaveBeenCalled();
});
it("reuses a verified available preference without consulting unrelated candidate Chats",async()=>{
 const {client}=fixture();vi.mocked(client.bots!.routineDestination!.get).mockResolvedValue({availability:"available",preference:{target:{botId:"bot_existing",chatId:"chat_executor",bindingCreatedAt:"2026-11-06T00:00:00.000Z"},revision:1,updatedAt:"2026-11-06T00:00:00.000Z"}});
 vi.mocked(client.list).mockRejectedValue(new Error("library unavailable"));
 const {result}=renderHook(()=>useRoutineDestinationPicker(client,true));await waitFor(()=>expect(result.current.pending).toBe(false));
 expect(result.current.view?.availability).toBe("available");expect(client.list).not.toHaveBeenCalled();
});
it("aborts a pending preference write when the picker is closed",async()=>{
 const {client}=fixture();let finish!:()=>void;let signal:AbortSignal|undefined;
 vi.mocked(client.bots!.routineDestination!.remember).mockImplementation(async(_body,caller)=>{signal=caller;await new Promise<void>(r=>{finish=r;});throw new Error("disconnected");});
 const {result,unmount}=renderHook(()=>useRoutineDestinationPicker(client,true));await waitFor(()=>expect(result.current.pending).toBe(false));
 let request!:Promise<void>;act(()=>{request=result.current.choose("bot_existing");});unmount();const aborted=signal?.aborted;finish();await request;expect(aborted).toBe(true);
});
