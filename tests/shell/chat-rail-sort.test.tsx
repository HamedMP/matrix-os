// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { useWebChatRailOrder } from "../../shell/src/components/chat/useWebChatRailOrder";
import { clientFixture } from "../desktop/chat-agents-fixture";
vi.mock("@clerk/nextjs",async original=>({...await original<typeof import("@clerk/nextjs")>(),useOrganization:()=>({organization:null}),useAuth:()=>({userId:null,sessionId:null})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("shows Web search without filter or sorting controls",async()=> {
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  const client = clientFixture();
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json(await client.catalog())));
  await act(async()=>{render(<ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} agentClient={client}/>);await Promise.resolve();});
  const search = screen.getByRole("textbox", {name:"Search chats"});
  fireEvent.change(search, {target:{value:"test"}});
  expect((search as HTMLInputElement).value).toBe("test");
  expect(screen.queryByRole("button",{name:"Sort chats"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Unread"})).toBeNull();
});
it("keeps Web manual order in the current client and rejects stale identity callbacks",()=> {
  const items=[{id:"a",preview:"A",messageCount:1,updatedAt:1},{id:"b",preview:"B",messageCount:1,updatedAt:2}];
  const first={}; const second={};
  const hook=renderHook(({client})=>useWebChatRailOrder(items,client),{initialProps:{client:first}});
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["b","a"]);
  act(()=>hook.result.current.setMode("manual"));
  const stale=hook.result.current.move;
  act(()=>hook.result.current.move("chat","a","b"));
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["a","b"]);
  const oldScope=hook.result.current.scopeKey;
  hook.rerender({client:second});
  expect(hook.result.current.mode).toBe("lastUpdated");
  expect(hook.result.current.scopeKey).not.toBe(oldScope);
  act(()=>stale("chat","a","b"));
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["b","a"]);
  hook.rerender({client:first});
  act(()=>hook.result.current.setMode("manual"));
  act(()=>stale("chat","a","b"));
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["b","a"]);
});
it("keeps legacy conversations visible when an update timestamp is outside the Date range",()=> {
  const items=[{id:"invalid",preview:"Invalid date",messageCount:1,updatedAt:1e30},{id:"valid",preview:"Valid date",messageCount:1,updatedAt:2}];
  const client={};
  const hook=renderHook(()=>useWebChatRailOrder(items,client));
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["valid","invalid"]);
});

it.each(["keyboard", "drag"])("starts Web manual ordering with a direct %s move without Search sorting", async action => {
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  const client=clientFixture();
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json(await client.catalog())));
  const items=[{id:"a",preview:"A",messageCount:1,updatedAt:1},{id:"b",preview:"B",messageCount:1,updatedAt:2}];
  const select=vi.fn();
  await act(async()=>{render(<ChatApp messages={[]} busy={false} connected conversations={items} onNewChat={vi.fn()} onSwitchConversation={select} onSubmit={vi.fn()} agentClient={client}/>);await Promise.resolve();});
  const row=(id:string)=>document.querySelector<HTMLElement>(`[data-rail-order-id="${id}"]`)!;
  const ids=()=>[...document.querySelectorAll<HTMLElement>("[data-rail-order-id]")].map(e=>e.dataset.railOrderId);
  expect(ids()).toEqual(["b","a"]);
  expect(screen.queryByRole("button",{name:"Sort chats"})).toBeNull();
  if(action==="keyboard")fireEvent.keyDown(screen.getByRole("button",{name:"B",exact:true}),{key:"ArrowDown",altKey:true});
  else {
    const values=new Map<string,string>();
    const transfer={effectAllowed:"",dropEffect:"",types:["application/x-matrix-chat-rail"],setData:(key:string,value:string)=>values.set(key,value),getData:(key:string)=>values.get(key)??""};
    fireEvent.dragStart(row("b"),{dataTransfer:transfer});
    fireEvent.drop(row("a"),{dataTransfer:transfer});
  }
  await waitFor(()=>expect(ids()).toEqual(["a","b"]));
  expect(select).not.toHaveBeenCalled();
});
it("rejects invalid Web moves before entering manual order",()=>{
  const client={};const items=[{id:"a",preview:"A",messageCount:1,updatedAt:1},{id:"b",preview:"B",messageCount:1,updatedAt:2}];
  const hook=renderHook(()=>useWebChatRailOrder(items,client));
  act(()=>hook.result.current.move("chat","a","missing"));
  act(()=>hook.result.current.move("chat","a","a"));
  act(()=>hook.result.current.move("project","a","b"));
  expect(hook.result.current.mode).toBe("lastUpdated");
  act(()=>hook.result.current.move("chat","a","b"));
  expect(hook.result.current.mode).toBe("manual");
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["a","b"]);
});
