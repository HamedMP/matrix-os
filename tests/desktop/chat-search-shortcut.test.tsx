// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGlobalShortcuts } from "@desktop/renderer/src/features/mission-control/shortcuts";
import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import { useUi } from "@desktop/renderer/src/stores/ui";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
const client = {list:vi.fn(async()=>({items:[]}))} as unknown as CanonicalChatClient;
function Shortcuts() {useGlobalShortcuts();return null;}
const menuListeners = new Map<string, (event:{action:string})=>void>();
function Surface({active,searchShortcutActive=active}:{active:boolean;searchShortcutActive?:boolean}) {
  const noop=()=>{};
  return <><Shortcuts/><WorkRail client={client} projects={[]} active={active} searchShortcutActive={searchShortcutActive} onNewGlobalChat={noop} onCreateProject={noop} onNewProjectChat={noop} onSelectChat={noop} onCollapse={noop}/></>;
}
beforeEach(()=>{menuListeners.clear();useUi.setState(useUi.getInitialState(),true);vi.stubGlobal("operator",{on:(channel:string, callback:(event:{action:string})=>void)=>{menuListeners.set(channel,callback);return ()=>menuListeners.delete(channel);}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it.each(["metaKey","ctrlKey"])("routes %s-K to the active Chat search and keeps global palette outside Chat",async modifier=>{
  const view=render(<Surface active/>);
  await screen.findByRole("button",{name:"Search chats"});
  fireEvent.keyDown(window,{key:"k",[modifier]:true});
  expect(await screen.findByRole("dialog",{name:"Search chats"})).toBeTruthy();
  expect(useUi.getState().paletteOpen).toBe(false);
  view.rerender(<Surface active={false}/>);
  fireEvent.keyDown(window,{key:"k",[modifier]:true});
  expect(useUi.getState().paletteOpen).toBe(true);
});
it("lets an already open palette retain Cmd-K and rejects modified/repeated competing requests",async()=>{
  await act(async()=>{render(<Surface active/>);await Promise.resolve();});
  fireEvent.keyDown(window,{key:"k",metaKey:true,shiftKey:true});
  expect(screen.queryByRole("dialog",{name:"Search chats"})).toBeNull();
  expect(useUi.getState().paletteOpen).toBe(false);
  fireEvent.keyDown(window,{key:"k",metaKey:true,repeat:true});
  expect(useUi.getState().paletteOpen).toBe(false);
  useUi.setState({paletteOpen:true});
  fireEvent.keyDown(window,{key:"k",metaKey:true});
  expect(useUi.getState().paletteOpen).toBe(false);
  expect(screen.queryByRole("dialog",{name:"Search chats"})).toBeNull();
});

it("routes native menu accelerator requests to the same Chat search and ignores a visible unfocused rail",async()=>{
  const view=render(<Surface active/>);
  await act(async()=>{menuListeners.get("menu:action")?.({action:"palette"});});
  expect(await screen.findByRole("dialog",{name:"Search chats"})).toBeTruthy();
  expect(useUi.getState().paletteOpen).toBe(false);
  view.rerender(<Surface active searchShortcutActive={false}/>);
  await act(async()=>{menuListeners.get("menu:action")?.({action:"palette"});});
  expect(useUi.getState().paletteOpen).toBe(true);
  view.unmount();
  expect(menuListeners.has("menu:action")).toBe(false);
});
