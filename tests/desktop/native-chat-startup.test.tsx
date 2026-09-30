// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import NativeDesktopShell from "@desktop/renderer/src/features/desktop-shell/NativeDesktopShell";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";
import { useDesktopAppDrawer } from "@desktop/renderer/src/stores/desktop-app-drawer";
import { resetDesktopIconsRuntime, useDesktopIcons } from "@desktop/renderer/src/stores/desktop-icons";
import { useDraftChat } from "@desktop/renderer/src/stores/draft-chat";
import { useHermesChat } from "@desktop/renderer/src/stores/hermes-chat";
import { useThreads } from "@desktop/renderer/src/stores/threads";
import { desktopQueryClient } from "@desktop/renderer/src/lib/query-client";

vi.mock("@desktop/renderer/src/features/mission-control/TabContent", () => ({
  TabPane: ({ tab }: { tab: { title: string } }) => <div>{tab.title} content</div>,
  TabErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  useUi.setState(useUi.getInitialState(), true);
  useNativeDesktopMode.setState(useNativeDesktopMode.getInitialState(), true);
  useDesktopAppDrawer.setState(useDesktopAppDrawer.getInitialState(), true);
  useDraftChat.setState(useDraftChat.getInitialState(), true);
  useHermesChat.setState(useHermesChat.getInitialState(), true);
  useThreads.setState(useThreads.getInitialState(), true);
  resetDesktopIconsRuntime();
  useDesktopIcons.setState(useDesktopIcons.getInitialState(), true);
  desktopQueryClient.clear();
  useNativeDesktopMode.setState({ hydrated: true });
  window.operator = {
    invoke: vi.fn(async (channel: string) => channel === "state:get" ? { value: { mode: "desktop" } } : { ok: true }),
    on: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("canonical Chat runtime startup", () => {
  function startupApi(document = createDefaultOsViewDocument()) {
    const state = { revision: 1, document, updatedAt: "2026-09-30T00:00:00.000Z" };
    return {
      get: vi.fn(async (path: string) => path === "/api/os-view-state" ? state : path === "/api/apps" ? { apps: [] } : { legacyDesktopImport: null }),
      post: vi.fn(async () => state),
      patch: vi.fn(async () => state),
    };
  }

  it("opens a missing canonical Chat once after runtime restoration, including a closed saved Chat", async () => {
    const document = createDefaultOsViewDocument();
    document.apps = [{ path: "__chat__", title: "Chat", state: "closed" }];
    useConnection.setState({ status: "signed-in", api: startupApi(document) as never });
    render(<NativeDesktopShell overlayOpen={false} />);
    await waitFor(() => expect(useTabs.getState().tabs.filter((tab) => tab.kind === "work")).toHaveLength(1));
    const tab = useTabs.getState().tabs.find((tab) => tab.kind === "work")!;
    expect(useDesktopSurfaces.getState().surfaces[tab.id]?.mode).toBe("window");
    act(() => useDesktopSurfaces.getState().closeSurface(tab.id));
    act(() => useNativeDesktopMode.setState({ mode: "canvas" }));
    act(() => useConnection.setState({ providerCatalogGeneration: 1, api: startupApi(document) as never }));
    await act(async () => { await Promise.resolve(); });
    expect(useDesktopSurfaces.getState().surfaces[tab.id]?.mode).toBe("closed");
    expect(useTabs.getState().tabs.filter((candidate) => candidate.kind === "work")).toHaveLength(1);
  });

  it.each(["window", "minimized"] as const)("keeps an existing %s Chat route and focus unchanged", async (mode) => {
    const chatId = useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "projects", closable: false });
    const terminalId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([chatId, terminalId], { width: 1200, height: 720 });
    if (mode === "minimized") useDesktopSurfaces.getState().minimizeSurface(chatId);
    const chat = useTabs.getState().tabs.find((tab) => tab.id === chatId)!;
    useThreads.setState({ activeThreadId: "selected-thread" });
    useHermesChat.setState({ sessionId: "selected-chat", view: "conversation" });
    useDraftChat.getState().setDraft("matrix-os", { prompt: "Keep this draft", providerId: "codex", mode: "default" });
    const draft = useDraftChat.getState().draftFor("matrix-os");
    useConnection.setState({ status: "signed-in", api: startupApi() as never });
    render(<NativeDesktopShell overlayOpen={false} />);
    await waitFor(() => expect(useConnection.getState().api!.get).toHaveBeenCalledWith("/api/os-view-state"));
    await act(async () => { await Promise.resolve(); });
    expect(useTabs.getState().tabs.find((tab) => tab.id === chatId)).toEqual(chat);
    expect(useTabs.getState().activeTabId).toBe(terminalId);
    expect(useThreads.getState().activeThreadId).toBe("selected-thread");
    expect(useHermesChat.getState().sessionId).toBe("selected-chat");
    expect(useHermesChat.getState().view).toBe("conversation");
    expect(useDraftChat.getState().draftFor("matrix-os")).toEqual(draft);
    expect(useDesktopSurfaces.getState().surfaces[chatId]?.mode).toBe(mode);
  });

  it("restores a minimized saved Chat without activating or resetting it", async () => {
    const document = createDefaultOsViewDocument();
    document.apps = [{ path: "__chat__", title: "Chat", state: "minimized" }];
    document.desktop.windows = [{ path: "__chat__", x: 240, y: 160, width: 750, height: 500 }];
    useConnection.setState({ status: "signed-in", api: startupApi(document) as never });
    render(<NativeDesktopShell overlayOpen={false} />);
    await waitFor(() => expect(useTabs.getState().tabs.filter((tab) => tab.kind === "work")).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    const chat = useTabs.getState().tabs.find((tab) => tab.kind === "work")!;
    expect(useDesktopSurfaces.getState().surfaces[chat.id]?.mode).toBe("minimized");
    expect(useDesktopSurfaces.getState().surfaces[chat.id]?.bounds).toEqual({ x: 240, y: 160, width: 750, height: 500 });
  });

  it("preserves a minimized active Chat when another saved app restores", async () => {
    const chatId = useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "projects", closable: false });
    useDesktopSurfaces.getState().reconcileTabs([chatId], { width: 1200, height: 720 });
    useDesktopSurfaces.getState().minimizeSurface(chatId);
    const document = createDefaultOsViewDocument();
    document.apps = [{ path: "__terminal__", title: "Terminal", state: "open" }];
    useConnection.setState({ status: "signed-in", api: startupApi(document) as never });
    render(<NativeDesktopShell overlayOpen={false} />);
    await waitFor(() => expect(useTabs.getState().tabs.some((tab) => tab.kind === "terminals")).toBe(true));
    expect(useTabs.getState().activeTabId).toBe(chatId);
    expect(useDesktopSurfaces.getState().surfaces[chatId]?.mode).toBe("minimized");
    expect(useTabs.getState().tabs.find((tab) => tab.id === chatId)?.workRoute).toBe("projects");
  });

  it("opens Chat after restoring another app on a normal fresh entry", async () => {
    const document = createDefaultOsViewDocument();
    document.apps = [{ path: "__terminal__", title: "Terminal", state: "open" }];
    useConnection.setState({ status: "signed-in", api: startupApi(document) as never });
    render(<NativeDesktopShell overlayOpen={false} />);
    await waitFor(() => expect(useTabs.getState().tabs.filter((tab) => tab.kind === "work")).toHaveLength(1));
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "terminals")).toBe(true);
    expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId)?.kind).toBe("work");
  });

  it("rejects a delayed restoration from the previously selected runtime", async () => {
    let resolve!: (state: unknown) => void;
    const pending = new Promise((next) => { resolve = next; });
    const oldApi = startupApi();
    oldApi.get.mockImplementation(async (path) => path === "/api/os-view-state" ? pending as never : { legacyDesktopImport: null });
    useConnection.setState({ status: "signed-in", runtimeSlot: "primary", api: oldApi as never });
    render(<NativeDesktopShell overlayOpen={false} />);
    await waitFor(() => expect(oldApi.get).toHaveBeenCalledWith("/api/os-view-state"));
    act(() => useConnection.setState({ runtimeSlot: "preview", api: startupApi() as never }));
    await waitFor(() => expect(useTabs.getState().tabs.some((tab) => tab.kind === "work")).toBe(true));
    const before = useTabs.getState().tabs;
    const document = createDefaultOsViewDocument();
    document.apps = [{ path: "__terminal__", title: "Terminal", state: "open" }];
    await act(async () => resolve({ revision: 1, document, updatedAt: "2026-09-30T00:00:00.000Z" }));
    expect(useTabs.getState().tabs).toEqual(before);
  });

  it("settles a failed restore and still opens a missing Chat", async () => {
    const api = startupApi();
    api.get.mockImplementation(async (path) => { if (path === "/api/os-view-state") throw new Error("offline"); return {}; });
    useConnection.setState({ status: "signed-in", api: api as never });
    render(<NativeDesktopShell overlayOpen={false} />);
    await waitFor(() => expect(useTabs.getState().tabs.some((tab) => tab.kind === "work")).toBe(true));
  });

  it("does not override user navigation during a pending restore", async () => {
    let resolve!: (state: unknown) => void;
    const pending = new Promise((next) => { resolve = next; });
    const api = startupApi();
    api.get.mockImplementation(async (path) => path === "/api/os-view-state" ? pending as never : {});
    useConnection.setState({ status: "signed-in", api: api as never });
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));
    const terminalId = useTabs.getState().activeTabId;
    const document = createDefaultOsViewDocument();
    document.apps = [{ path: "__chat__", title: "Chat", state: "open" }];
    await act(async () => resolve({ revision: 1, document, updatedAt: "2026-09-30T00:00:00.000Z" }));
    expect(useTabs.getState().activeTabId).toBe(terminalId);
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "work")).toBe(false);
  });

});
