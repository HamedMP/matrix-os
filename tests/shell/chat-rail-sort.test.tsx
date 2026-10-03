// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { useWebChatRailOrder } from "../../shell/src/components/chat/useWebChatRailOrder";
import { clientFixture } from "../desktop/chat-agents-fixture";
vi.mock("@clerk/nextjs",async original=>({...await original<typeof import("@clerk/nextjs")>(),useOrganization:()=>({organization:null}),useAuth:()=>({userId:null,sessionId:null})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("offers Last updated and Manual order beside Web search without an unread filter",async()=> {
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  const client = clientFixture();
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json(await client.catalog())));
  render(<ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} agentClient={client}/>);
  const sort = screen.getByRole("button",{name:"Sort chats"});
  await act(async()=>{fireEvent.keyDown(sort,{key:"ArrowDown"});await Promise.resolve();});
  expect(await screen.findByRole("menuitemradio",{name:"Last updated"})).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitemradio",{name:"Manual order"}));
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
