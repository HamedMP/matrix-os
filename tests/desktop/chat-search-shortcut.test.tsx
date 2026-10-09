// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGlobalShortcuts } from "@desktop/renderer/src/features/mission-control/shortcuts";
import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { clearChatNavigationScopes } from "@matrix-os/ui";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useWorkNavigation } from "@desktop/renderer/src/features/work/use-work-navigation";
import { NAVIGATION_CACHE_INVOKE } from "@desktop/shared/navigation-cache-ipc";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
const navigationRead = vi.fn(async () => ({ version: 1 as const, items: [], truncated: false }));
const client = {list:vi.fn(async()=>({items:[]})), navigation:navigationRead} as unknown as CanonicalChatClient;
const initialConnection = useConnection.getState();
let verifiedScope = true;
const nativeInvoke = vi.fn(async (channel: string, payload: unknown) => {
  if (!(channel in NAVIGATION_CACHE_INVOKE)) throw new Error(`Unexpected test IPC channel: ${channel}`);
  const protocol = NAVIGATION_CACHE_INVOKE[channel as keyof typeof NAVIGATION_CACHE_INVOKE];
  protocol.request.parse(payload);
  const response = channel === "navigation-cache:context"
    ? { scope: verifiedScope ? "a".repeat(64) : null, authGeneration: 1 }
    : channel === "navigation-cache:load" ? { snapshot: null } : { ok: true };
  return protocol.response.parse(response);
});
async function navigationReady() { await waitFor(() => expect(navigationRead).toHaveBeenCalledOnce()); }
function Shortcuts() {useGlobalShortcuts();return null;}
const menuListeners = new Map<string, (event:{action:string})=>void>();
function Surface({active,searchShortcutActive=active}:{active:boolean;searchShortcutActive?:boolean}) {
  const noop=()=>{};
  return <><Shortcuts/><WorkRail client={client} projects={[]} active={active} searchShortcutActive={searchShortcutActive} onNewGlobalChat={noop} onCreateProject={noop} onNewProjectChat={noop} onSelectChat={noop} onCollapse={noop}/></>;
}
beforeEach(()=>{verifiedScope=true;navigationRead.mockClear();nativeInvoke.mockClear();menuListeners.clear();clearChatNavigationScopes();useUi.setState(useUi.getInitialState(),true);
  useConnection.setState({ ...useConnection.getInitialState(), status:"signed-in", userId:"shortcut_fixture", platformHost:"https://platform.test", runtimeSlot:"primary", authGeneration:1, organizationStatus:"none" },true);
  vi.stubGlobal("operator",{invoke:nativeInvoke,on:(channel:string, callback:(event:{action:string})=>void)=>{menuListeners.set(channel,callback);return ()=>menuListeners.delete(channel);}});});
afterEach(async()=>{
  cleanup();
  // Let queued native cache deletion finish while its bridge still exists.
  await act(async()=>{clearChatNavigationScopes();useConnection.setState(initialConnection,true);});
  vi.unstubAllGlobals();
});
it.each(["metaKey","ctrlKey"])("routes %s-K to the active Chat search and keeps global palette outside Chat",async modifier=>{
  const view=render(<Surface active/>);
  await navigationReady();
  await screen.findByRole("button",{name:"Search chats"});
  fireEvent.keyDown(window,{key:"k",[modifier]:true});
  expect(await screen.findByRole("dialog",{name:"Search chats"})).toBeTruthy();
  expect(useUi.getState().paletteOpen).toBe(false);
  view.rerender(<Surface active={false}/>);
  fireEvent.keyDown(window,{key:"k",[modifier]:true});
  expect(useUi.getState().paletteOpen).toBe(true);
});
it("lets an already open palette retain Cmd-K and rejects modified/repeated competing requests",async()=>{
  render(<Surface active/>);
  await navigationReady();
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
  await navigationReady();
  await act(async()=>{menuListeners.get("menu:action")?.({action:"palette"});});
  expect(await screen.findByRole("dialog",{name:"Search chats"})).toBeTruthy();
  expect(useUi.getState().paletteOpen).toBe(false);
  view.rerender(<Surface active searchShortcutActive={false}/>);
  await act(async()=>{menuListeners.get("menu:action")?.({action:"palette"});});
  expect(useUi.getState().paletteOpen).toBe(true);
  view.unmount();
  expect(menuListeners.has("menu:action")).toBe(false);
});

it("keeps Chat search closed when native context denies a verified navigation scope", async () => {
  verifiedScope = false;
  await act(async () => { render(<Surface active/>); });
  expect(nativeInvoke).toHaveBeenCalledWith("navigation-cache:context", {});
  expect(navigationRead).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await act(async () => { menuListeners.get("menu:action")?.({ action: "palette" }); });
  expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
  expect(useUi.getState().paletteOpen).toBe(false);
});

it("closes search on navigation revocation and rejects keyboard and native reopen requests", async () => {
  render(<Surface active/>);
  await navigationReady();
  const navigation = renderHook(() => useWorkNavigation(client, undefined, true));
  await waitFor(() => expect(navigation.result.current.fresh).toBe(true));
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(await screen.findByRole("dialog", { name: "Search chats" })).toBeTruthy();
  act(() => navigation.result.current.store!.revoke());
  expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  await act(async () => { menuListeners.get("menu:action")?.({ action: "palette" }); });
  expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
  expect(useUi.getState().paletteOpen).toBe(false);
});
