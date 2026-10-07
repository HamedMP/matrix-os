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

it.each(["new", "lastUpdated", "manual"].flatMap(mode => ["keyboard", "drag"].map(action => [mode, action])))("supports direct %s preference reorder via %s without a Search sort control", async (mode, action) => {
  useConnection.setState({status:"signed-in",userId:"owner-a",platformHost:"https://platform.test",runtimeSlot:"primary"});
  if (mode !== "new") localStorage.setItem(`matrix-chat-rail-order:${JSON.stringify(["https://platform.test", "owner-a", "primary"])}`, JSON.stringify({ mode, chatIds: ["b", "a"], projectIds: [] }));
  const items = records.map(record=>({...record,chat:{...record.chat,title:record.chat.id.toUpperCase(),ownerScope:{type:"personal",ownerId:"owner"},lifecycle:"active",attention:"none",revision:1,messageCount:1}}));
  const client = {list:vi.fn(async()=>({items}))} as unknown as CanonicalChatClient;
  render(<WorkRail client={client} projects={[]} active onNewGlobalChat={vi.fn()} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()} onSelectChat={vi.fn()} onCollapse={vi.fn()}/>);
  await screen.findByRole("button",{name:"B"});
  const done = screen.getByRole("button",{name:"Done"}).closest("section")!;
  const ids = ()=>[...done.querySelectorAll<HTMLElement>("[data-rail-order-id]")].map(item=>item.dataset.railOrderId);
  expect(ids()).toEqual(["b","a"]);
  expect(screen.queryByRole("button",{name:"Sort chats"})).toBeNull();
  if (action === "keyboard") fireEvent.keyDown(screen.getByRole("button",{name:"B"}),{key:"ArrowDown",altKey:true});
  else {
    const data = new Map<string,string>();
    const transfer = {effectAllowed:"",dropEffect:"",types:["application/x-matrix-chat-rail"],setData:(type:string,value:string)=>data.set(type,value),getData:(type:string)=>data.get(type) ?? ""};
    fireEvent.dragStart(screen.getByRole("button",{name:"B"}).parentElement!,{dataTransfer:transfer});
    fireEvent.drop(screen.getByRole("button",{name:"A"}).parentElement!,{dataTransfer:transfer});
  }
  await waitFor(()=>expect(ids()).toEqual(["a","b"]));
  const stored = JSON.parse(localStorage.getItem(`matrix-chat-rail-order:${JSON.stringify(["https://platform.test", "owner-a", "primary"])}`)!);
  expect(stored.mode).toBe("manual");
  expect(stored.chatIds).toEqual(["a", "b"]);
  expect(client.list).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button",{name:"A"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Recent"})).toBeNull();
});


it("enters manual order from visible Projects without restoring stale Chat order", () => {
  useConnection.setState({status:"signed-in",userId:"owner-a",platformHost:"https://platform.test",runtimeSlot:"primary"});
  localStorage.setItem(`matrix-chat-rail-order:${JSON.stringify(["https://platform.test", "owner-a", "primary"])}`,
    JSON.stringify({ mode: "lastUpdated", chatIds: ["a", "b"], projectIds: ["p", "q"] }));
  const projects = [{ slug: "p", name: "P", kind: "folder" as const, updatedAt: "2026-10-01T00:00:00Z" },
    { slug: "q", name: "Q", kind: "folder" as const, updatedAt: "2026-10-02T00:00:00Z" }];
  const order = renderHook(() => useWorkRailOrder(records, projects));
  expect(order.result.current.projects.map(item => item.slug)).toEqual(["q", "p"]);
  act(() => order.result.current.move("project", "p", "q"));
  expect(order.result.current.mode).toBe("manual");
  expect(order.result.current.projects.map(item => item.slug)).toEqual(["p", "q"]);
  expect(order.result.current.chats.map(item => item.chat.id)).toEqual(["b", "a"]);
});

it("ignores invalid reorder targets without changing automatic preferences", () => {
  const order = renderHook(() => useWorkRailOrder(records, []));
  act(() => order.result.current.move("chat", "a", "missing"));
  act(() => order.result.current.move("chat", "a", "a"));
  expect(order.result.current.mode).toBe("lastUpdated");
  expect(order.result.current.chats.map(item => item.chat.id)).toEqual(["b", "a"]);
});


it.each(["manual", "lastUpdated"])("preserves saved %s Chat order when Projects reorder before Chats load", mode => {
  useConnection.setState({status:"signed-in",userId:"owner-a",platformHost:"https://platform.test",runtimeSlot:"primary"});
  const key = `matrix-chat-rail-order:${JSON.stringify(["https://platform.test", "owner-a", "primary"])}`;
  localStorage.setItem(key, JSON.stringify({ mode, chatIds: ["b", "a"], projectIds: ["p", "q"] }));
  const projects = [{ slug: "p", name: "P", kind: "folder" as const }, { slug: "q", name: "Q", kind: "folder" as const }];
  const order = renderHook(({ loaded }: { loaded: boolean }) => useWorkRailOrder(loaded ? records : [], projects), { initialProps: { loaded: false } });
  act(() => order.result.current.move("project", "q", "p"));
  expect(JSON.parse(localStorage.getItem(key)!).chatIds).toEqual(["b", "a"]);
  order.rerender({ loaded: true });
  expect(order.result.current.chats.map(item => item.chat.id)).toEqual(["b", "a"]);
  order.unmount();
  const reopened = renderHook(() => useWorkRailOrder(records, projects));
  expect(reopened.result.current.chats.map(item => item.chat.id)).toEqual(["b", "a"]);
});

it("preserves saved Project order while Chats reorder before Projects load", () => {
  useConnection.setState({status:"signed-in",userId:"owner-a",platformHost:"https://platform.test",runtimeSlot:"primary"});
  const key = `matrix-chat-rail-order:${JSON.stringify(["https://platform.test", "owner-a", "primary"])}`;
  localStorage.setItem(key, JSON.stringify({ mode: "manual", chatIds: ["b", "a"], projectIds: ["q", "p"] }));
  const projects = [{ slug: "p", name: "P", kind: "folder" as const }, { slug: "q", name: "Q", kind: "folder" as const }];
  const order = renderHook(({ loaded }: { loaded: boolean }) => useWorkRailOrder(records, loaded ? projects : []), { initialProps: { loaded: false } });
  act(() => order.result.current.move("chat", "a", "b"));
  expect(JSON.parse(localStorage.getItem(key)!).projectIds).toEqual(["q", "p"]);
  order.rerender({ loaded: true });
  expect(order.result.current.projects.map(item => item.slug)).toEqual(["q", "p"]);
});


it("keeps unseen manual Chat IDs when the other list moves with partial Chat data", () => {
  useConnection.setState({status:"signed-in",userId:"owner-a",platformHost:"https://platform.test",runtimeSlot:"primary"});
  const key = `matrix-chat-rail-order:${JSON.stringify(["https://platform.test", "owner-a", "primary"])}`;
  localStorage.setItem(key, JSON.stringify({ mode: "manual", chatIds: ["b", "a"], projectIds: ["p", "q"] }));
  const projects = [{ slug: "p", name: "P", kind: "folder" as const }, { slug: "q", name: "Q", kind: "folder" as const }];
  const order = renderHook(({ loaded }: { loaded: boolean }) => useWorkRailOrder(loaded ? records : [records[0]!], projects), { initialProps: { loaded: false } });
  act(() => order.result.current.move("project", "q", "p"));
  order.rerender({ loaded: true });
  expect(order.result.current.chats.map(item => item.chat.id)).toEqual(["b", "a"]);
});
