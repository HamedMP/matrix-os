// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RenameableConversationRow } from "../../shell/src/components/chat/ChatTitleRename";
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
  fireEvent.click(screen.getByRole("button", {name:"Search chats"}));
  const search = screen.getByRole("combobox", {name:"Search chats"});
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
  const doneHeader = screen.getByRole("button", { name: "Done" });
  expect(doneHeader.getAttribute("aria-expanded")).toBe("true");
  await screen.findByRole("button", { name: "B", exact: true });
  expect(screen.getByRole("button", { name: "A", exact: true })).toBeTruthy();
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
  expect(doneHeader.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "A", exact: true })).toBeTruthy();
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


it("opens the full archive page from Search and keeps its own search bar", async () => {
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  const client=clientFixture();
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json(await client.catalog())));
  const archiveClient={list:vi.fn(async()=>({items:[]})),search:vi.fn(async()=>({items:[]})),updateLifecycle:vi.fn(),delete:vi.fn()};
  await act(async()=>{render(<ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} agentClient={client} archiveClient={archiveClient}/>);await Promise.resolve();});
  expect(screen.queryByRole("button",{name:"Archived chats"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Search chats"}));
  fireEvent.click(screen.getByRole("tab",{name:"Archived",exact:true}));
  fireEvent.click(screen.getByRole("button",{name:"Open archived list"}));
  expect(screen.queryByRole("dialog",{name:"Archived chats"})).toBeNull();
  expect(screen.getByRole("region",{name:"Archived chats"})).toBeTruthy();
  expect(screen.getByRole("searchbox",{name:"Search archived chats"})).toBeTruthy();
  expect(screen.queryByRole("combobox",{name:"Search chats"})).toBeNull();
});


it("provides Pin and Move to project in a chat row menu", async () => {
 const pin=vi.fn(),move=vi.fn();
 render(<RenameableConversationRow conversation={{id:"chat_menu",title:"Menu chat",preview:"",messageCount:1,updatedAt:1}} active={false} mobile={false} editing={false} renamePending={false} onSelect={vi.fn()} onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} onPin={pin} moveItems={[{label:"Matrix OS",onSelect:move}]}/>);
 fireEvent.pointerDown(screen.getByRole("button",{name:"Actions for Menu chat"}),{button:0,ctrlKey:false});
 fireEvent.click(await screen.findByRole("menuitem",{name:"Pin",exact:true}));expect(pin).toHaveBeenCalledOnce();
 fireEvent.pointerDown(screen.getByRole("button",{name:"Actions for Menu chat"}),{button:0,ctrlKey:false});
 fireEvent.keyDown(await screen.findByRole("menuitem",{name:/Move to project/}),{key:"ArrowRight"});
 fireEvent.click(await screen.findByRole("menuitem",{name:"Matrix OS",exact:true}));expect(move).toHaveBeenCalledOnce();
});


it("archives the selected idle chat with the displayed desktop shortcut", async () => {
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  const client=clientFixture();vi.stubGlobal("fetch",vi.fn(async()=>Response.json(await client.catalog())));
  const archive=vi.fn(async()=>({chatId:"chat_shortcut",revision:2}));
  await act(async()=>{render(<ChatApp messages={[]} sessionId="chat_shortcut" busy={false} connected conversations={[{id:"chat_shortcut",title:"Shortcut chat",preview:"",messageCount:1,updatedAt:1}]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} onArchiveConversation={archive} agentClient={client}/>);await Promise.resolve();});
  fireEvent.keyDown(window,{key:"a",metaKey:true,shiftKey:true});
  await waitFor(()=>expect(archive).toHaveBeenCalledWith("chat_shortcut"));
});
