// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useWorkRailOrder } from "@desktop/renderer/src/features/work/work-rail/use-work-rail-order";
import { WorkRailOrderContext, WorkRailOrderItem } from "@desktop/renderer/src/features/work/work-rail/WorkRailOrderItem";
import { WorkRailScrollArea } from "@desktop/renderer/src/features/work/work-rail/WorkRailScrollArea";
import { useConnection } from "@desktop/renderer/src/stores/connection";
const records = ["a","b"].map((id,index)=>({chat:{id,createdAt:`2026-10-0${index+1}T00:00:00Z`,updatedAt:`2026-10-0${index+2}T00:00:00Z`}} as CanonicalChatRecord));
afterEach(()=>{cleanup();vi.useRealTimers();localStorage.clear();useConnection.setState(useConnection.getInitialState(),true);});
it("persists manual reorder only for the same user and Computer",()=> {
  useConnection.setState({status:"signed-in",userId:"owner-a",platformHost:"https://platform.test",runtimeSlot:"pr2128"});
  const first = renderHook(()=>useWorkRailOrder(records,[]));
  expect(first.result.current.chats.map(item=>item.chat.id)).toEqual(["b","a"]);
  act(()=>first.result.current.setMode("manual"));
  act(()=>first.result.current.move("chat","a","b"));
  expect(first.result.current.chats.map(item=>item.chat.id)).toEqual(["a","b"]);
  first.unmount();
  const next = renderHook(()=>useWorkRailOrder(records,[]));
  expect(next.result.current.mode).toBe("manual");
  expect(next.result.current.chats.map(item=>item.chat.id)).toEqual(["a","b"]);
  act(()=>useConnection.setState({runtimeSlot:"primary"}));
  expect(next.result.current.mode).toBe("lastUpdated");
  expect(next.result.current.chats.map(item=>item.chat.id)).toEqual(["b","a"]);
  act(()=>useConnection.setState({runtimeSlot:"pr2128",userId:"owner-b"}));
  expect(next.result.current.mode).toBe("lastUpdated");
  act(()=>useConnection.setState({userId:"owner-a"}));
  expect(next.result.current.mode).toBe("manual");
  expect(next.result.current.chats.map(item=>item.chat.id)).toEqual(["a","b"]);
  const stale = next.result.current.move;
  act(()=>useConnection.setState({authGeneration:1}));
  act(()=>stale("chat","b","a"));
  expect(next.result.current.chats.map(item=>item.chat.id)).toEqual(["a","b"]);
});
it("supports manual keyboard and drag reorder while rejecting other groups",()=> {
  const move = vi.fn();
  render(<WorkRailOrderContext.Provider value={{manual:true,move}}><nav>
    <WorkRailOrderItem id="a" kind="chat" group="done"><button>A</button></WorkRailOrderItem>
    <WorkRailOrderItem id="b" kind="chat" group="done"><button>B</button></WorkRailOrderItem>
    <WorkRailOrderItem id="c" kind="chat" group="working"><button>C</button></WorkRailOrderItem>
  </nav></WorkRailOrderContext.Provider>);
  fireEvent.keyDown(screen.getByRole("button",{name:"B"}),{key:"ArrowUp",altKey:true});
  expect(move).toHaveBeenLastCalledWith("chat","b","a");
  const data = new Map<string,string>();
  const transfer = {effectAllowed:"",dropEffect:"",types:["application/x-matrix-chat-rail"],setData:(type:string,value:string)=>data.set(type,value),getData:(type:string)=>data.get(type) ?? ""};
  fireEvent.dragStart(screen.getByRole("button",{name:"A"}).parentElement!,{dataTransfer:transfer});
  fireEvent.drop(screen.getByRole("button",{name:"B"}).parentElement!,{dataTransfer:transfer});
  expect(move).toHaveBeenLastCalledWith("chat","a","b");
  fireEvent.drop(screen.getByRole("button",{name:"C"}).parentElement!,{dataTransfer:transfer});
  expect(move).toHaveBeenCalledTimes(2);
});
it("shows the edge scrollbar during scrolling and hides it again when idle",()=> {
  vi.useFakeTimers();
  render(<WorkRailScrollArea><button>Shared with me</button></WorkRailScrollArea>);
  const area = screen.getByTestId("work-rail-scroll");
  expect(area.dataset.scrolling).toBe("false");
  fireEvent.scroll(area);
  expect(area.dataset.scrolling).toBe("true");
  act(()=>vi.advanceTimersByTime(700));
  expect(area.dataset.scrolling).toBe("false");
});

it("applies the sort menu and keyboard reorder to actual Done rows without filtering", async ()=> {
  const items = records.map(record=>({...record,chat:{...record.chat,title:record.chat.id.toUpperCase(),ownerScope:{type:"personal",ownerId:"owner"},lifecycle:"active",attention:"none",revision:1,messageCount:1}}));
  const client = {list:vi.fn(async()=>({items}))} as unknown as CanonicalChatClient;
  render(<WorkRail client={client} projects={[]} active onNewGlobalChat={vi.fn()} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()} onSelectChat={vi.fn()} onCollapse={vi.fn()}/>);
  await screen.findByRole("button",{name:"B"});
  const done = screen.getByRole("button",{name:"Done"}).closest("section")!;
  const ids = ()=>[...done.querySelectorAll<HTMLElement>("[data-rail-order-id]")].map(item=>item.dataset.railOrderId);
  expect(ids()).toEqual(["b","a"]);
  fireEvent.pointerDown(screen.getByRole("button",{name:"Sort chats"}),{button:0,ctrlKey:false,pointerType:"mouse"});
  fireEvent.click(await screen.findByRole("menuitemradio",{name:"Manual order"}));
  fireEvent.keyDown(screen.getByRole("button",{name:"B"}),{key:"ArrowDown",altKey:true});
  await waitFor(()=>expect(ids()).toEqual(["a","b"]));
  expect(client.list).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button",{name:"A"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Recent"})).toBeNull();
});
