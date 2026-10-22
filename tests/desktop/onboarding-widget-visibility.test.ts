// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useChatMaximized } from "@desktop/renderer/src/features/onboarding-widget/use-chat-maximized";
import { useDesktopSurfaces, type DesktopSurface } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";
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
const terminalTab: Tab = { id: "term-1", kind: "terminal", title: "Terminal", closable: true };

describe("useChatMaximized", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
    useNativeDesktopMode.setState(useNativeDesktopMode.getInitialState(), true);
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
    expect(renderHook(() => useChatMaximized()).result.current).toBe(false);

    arrange({ tab: terminalTab, mode: "tab" });
    expect(renderHook(() => useChatMaximized()).result.current).toBe(false);

    arrange({ tab: chatTab, mode: "tab", osView: "canvas" });
    expect(renderHook(() => useChatMaximized()).result.current).toBe(false);
  });
});
