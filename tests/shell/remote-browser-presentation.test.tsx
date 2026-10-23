// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppViewer } from "../../shell/src/components/AppViewer";
import { DesktopWindow } from "../../shell/src/components/desktop/DesktopWindow";
import { CanvasWindow } from "../../shell/src/components/canvas/CanvasWindow";
import { useWindowManager, resetWindowManagerLayoutPersistenceForTests, type AppWindow } from "../../shell/src/hooks/useWindowManager";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode";
import { useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform";

vi.mock("../../shell/src/components/RemoteBrowserView", () => ({ RemoteBrowserView: (props: {surface:string;active?:boolean;onOpenCloudDesktop?:()=>void;onOpenBrowser?:()=>void}) => <div data-testid="browser-surface" data-active={String(props.active)} data-surface={props.surface}><button onClick={props.onOpenCloudDesktop}>Open Cloud desktop</button><button onClick={props.onOpenBrowser}>Open Browser</button></div> }));
vi.mock("../../shell/src/hooks/useSocket", () => ({useSocket:()=>({send:vi.fn(), subscribe:()=>()=>{}})}));
vi.mock("../../shell/src/hooks/useFileWatcher", () => ({useFileWatcher:()=>{}}));
vi.mock("../../shell/src/lib/posthog-client", () => ({capturePostHogEvent:vi.fn()}));
vi.mock("../../shell/src/components/terminal/TerminalApp", () => ({TerminalApp:()=>null}));
vi.mock("../../shell/src/components/file-browser/FileBrowser", () => ({FileBrowser:()=>null}));
vi.mock("../../shell/src/components/preview-window/PreviewWindow", () => ({PreviewWindow:()=>null}));
vi.mock("../../shell/src/components/ChatApp", () => ({ChatApp:()=>null}));

const initial:AppWindow={id:"remote-browser",title:"Browser",path:"__browser__",x:20,y:20,width:900,height:600,minimized:false,zIndex:1};
beforeEach(()=>{
  vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("Owner HTML must not be fetched")));
  resetWindowManagerLayoutPersistenceForTests();
  useWindowManager.setState({windows:[initial],nextZ:2,closedPaths:new Set(),closedLayouts:new Map(),focusedWindowId:initial.id,fullscreenWindowId:null});
  useCanvasTransform.setState({zoom:1,panX:0,panY:0,isAnimating:false,isScrolling:false});
});
afterEach(()=>{cleanup();resetWindowManagerLayoutPersistenceForTests();vi.unstubAllGlobals();});

it("renders compiled product surfaces and canonical cross-app actions without owner HTML",()=>{
  const open=vi.fn();
  render(<AppViewer path="__browser__" active onOpenApp={open}/>);
  expect(screen.getByTestId("browser-surface").getAttribute("data-surface")).toBe("browser");
  fireEvent.click(screen.getByRole("button",{name:"Open Cloud desktop"}));
  expect(open).toHaveBeenCalledWith("Cloud desktop","__cloud-desktop__");
  expect(fetch).not.toHaveBeenCalled();
});

for(const mode of ["desktop","canvas"] as const)describe(`Web ${mode} Browser focus/minimize lifecycle`,()=>{
  it("suspends input/resize when unfocused or minimized and restores the same window",()=>{
    useDesktopMode.setState({mode,_hydrated:true});
    const renderWindow=(win:AppWindow)=>mode==="canvas"?<CanvasWindow win={win}/>:<DesktopWindow win={win} dockPosition="bottom" fullscreenWindowId={null} interacting={false} minimizingIds={new Set()} onAnimateMinimize={vi.fn()} onCloseWindow={vi.fn()} onDragEnd={vi.fn()} onDragMove={vi.fn()} onDragStart={vi.fn()} onFocusWindow={vi.fn()} onOpenWindow={vi.fn()} onResizeInteractionChange={vi.fn()} onToggleFullscreen={vi.fn()}/>;
    const view=render(renderWindow(initial));
    expect(screen.getByTestId("browser-surface").getAttribute("data-active")).toBe("true");
    act(()=>useWindowManager.setState({focusedWindowId:null}));
    expect(screen.getByTestId("browser-surface").getAttribute("data-active")).toBe("false");
    act(()=>useWindowManager.getState().minimizeWindow(initial.id));
    view.rerender(renderWindow(useWindowManager.getState().windows[0]));
    expect(screen.getByTestId("browser-surface").getAttribute("data-active")).toBe("false");
    act(()=>useWindowManager.getState().openWindow("Browser","__browser__",0));
    view.rerender(renderWindow(useWindowManager.getState().windows[0]));
    expect(screen.getByTestId("browser-surface").getAttribute("data-active")).toBe("true");
    expect(useWindowManager.getState().windows).toHaveLength(1);
    expect(useWindowManager.getState().windows[0].id).toBe(initial.id);
  });
});
