// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useChatMaximized } from "@desktop/renderer/src/features/onboarding-widget/use-chat-maximized";
import { useDesktopSurfaces, type DesktopSurface } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";
import { useProjectView } from "@desktop/renderer/src/stores/project-view";
import { useTabs, type Tab } from "@desktop/renderer/src/stores/tabs";

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };

function arrange({ tab, mode, workspaceView = "tabs", osView = "desktop" }: {
  tab: Tab;
  mode: DesktopSurface["mode"];
  workspaceView?: "desktop" | "tabs";
  osView?: "desktop" | "canvas";
}) {
  useTabs.setState({ tabs: [tab], activeTabId: tab.id });
  useDesktopSurfaces.setState({
    surfaces: { [tab.id]: { tabId: tab.id, mode, restoreMode: mode === "tab" ? "tab" : "window", bounds: BOUNDS, zIndex: 10 } },
    workspaceView,
  });
  useNativeDesktopMode.setState({ mode: osView });
}

const chatTab: Tab = { id: "chat-1", kind: "work", workRoute: "chat", title: "Chat", closable: false };
const projectTab: Tab = { id: "project-1", kind: "work", workRoute: "project", projectSlug: "demo", chatView: "conversation", chatId: "chat-1", title: "Chat", closable: false };
const terminalTab: Tab = { id: "term-1", kind: "terminal", title: "Terminal", closable: true };

describe("useChatMaximized", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
    useNativeDesktopMode.setState(useNativeDesktopMode.getInitialState(), true);
    useProjectView.setState(useProjectView.getInitialState(), true);
  });

  afterEach(cleanup);

  it("is true only while the active Chat fills the Desktop workspace", () => {
    arrange({ tab: chatTab, mode: "tab" });
    const { result } = renderHook(() => useChatMaximized());
    expect(result.current).toBe(true);

    act(() => useDesktopSurfaces.getState().restoreAsWindow(chatTab.id));
    expect(result.current).toBe(false);
  });

  it("ignores a floating Chat window, a maximized non-Chat app, and Canvas", () => {
    arrange({ tab: chatTab, mode: "window", workspaceView: "desktop" });
    const { result } = renderHook(() => useChatMaximized());
    expect(result.current).toBe(false);

    act(() => arrange({ tab: terminalTab, mode: "tab" }));
    expect(result.current).toBe(false);

    act(() => arrange({ tab: chatTab, mode: "tab", osView: "canvas" }));
    expect(result.current).toBe(false);
  });

  it("hides the widget over a full-screen project Chat even when saved project view state is stale", () => {
    arrange({ tab: projectTab, mode: "tab" });
    useProjectView.getState().setView("demo", "board");
    const { result } = renderHook(() => useChatMaximized());
    expect(result.current).toBe(true);

    act(() => arrange({ tab: terminalTab, mode: "tab" }));
    expect(result.current).toBe(false);
  });
});
