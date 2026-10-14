// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsView from "../../desktop/src/renderer/src/features/settings/SettingsView";
import DesktopSurfaceFrame from "../../desktop/src/renderer/src/features/desktop-shell/DesktopSurfaceFrame";
import { useDesktopSurfaces } from "../../desktop/src/renderer/src/stores/desktop-surfaces";
import { useTabs, type Tab } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { observation, snapshot, start } from "../ui/provider-managed-credit-fixture";

// Keep every Settings composition component and the controller/scheduler real.
// Only the authenticated API boundary and native preload are synthetic.
// Non-provider section has no role in this visibility test.
vi.mock("../../desktop/src/renderer/src/features/settings/sections/RuntimeSection", () => ({ default: () => null }));
const operatorBefore = window.operator;
const tab: Tab = { id: "settings-visible", kind: "settings", title: "Settings", closable: true };
const viewport = { width: 1440, height: 900 };
const connectionBefore = useConnection.getState();
const tabsBefore = useTabs.getState();
const surfacesBefore = useDesktopSurfaces.getState();
const uiBefore = useUi.getState();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  window.operator = { invoke: vi.fn().mockResolvedValue({ state: "disconnected", scope: "this_device", models: [], grant: { revision: 0, enabled: false, background: false }, bridgeConnected: false, revocation: "none" }), on: vi.fn(() => () => undefined) };
  useTabs.setState({ tabs: [tab], activeTabId: tab.id });
  useDesktopSurfaces.setState({ surfaces: {}, workspaceView: "desktop", desktopHiddenSurfaceIds: [], desktopTransition: null });
  useDesktopSurfaces.getState().reconcileTabs([tab.id], viewport);
  useUi.getState().requestSettingsSection("agents-providers");
});
afterEach(() => {
  cleanup();
  window.operator = operatorBefore;
  useConnection.setState(connectionBefore, true);
  useTabs.setState(tabsBefore, true);
  useDesktopSurfaces.setState(surfacesBefore, true);
  useUi.setState(uiBefore, true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function FrameFromRealSurfaceState() {
  const surface = useDesktopSurfaces(state => state.surfaces[tab.id]);
  const workspaceView = useDesktopSurfaces(state => state.workspaceView);
  const desktopTransition = useDesktopSurfaces(state => state.desktopTransition);
  const desktopHiddenSurfaceIds = useDesktopSurfaces(state => state.desktopHiddenSurfaceIds);
  const activeTabId = useTabs(state => state.activeTabId);
  const activeSurface = useDesktopSurfaces(state => state.surfaces[activeTabId ?? ""]);
  // Same production NativeDesktopShell expression, with desktop presentation.
  const tabWorkspaceActive = workspaceView === "tabs" && activeSurface?.mode === "tab";
  if (!surface) return null;
  return <DesktopSurfaceFrame tab={tab} surface={surface} active={activeTabId === tab.id}
    tabWorkspaceActive={tabWorkspaceActive} overlayOpen={false} presentation="desktop"
    viewport={viewport} desktopTransition={desktopTransition} desktopHiddenSurfaceIds={desktopHiddenSurfaceIds}
    onFocus={() => useTabs.getState().focusTab(tab.id)} onClose={() => {}} onMinimize={() => {}}
    onMaximize={() => useDesktopSurfaces.getState().maximizeToTab(tab.id)} onBoundsChange={() => {}} />;
}
function installApi() {
  const initial = snapshot();
  let reads = 0;
  const get = vi.fn(async (path: string) => {
    if (path === "/api/ai/provider-settings/managed-credit") return observation(4_000_000 - ++reads * 10_000);
    if (path.startsWith("/api/ai/provider-settings/workflows/")) return [];
    if (path.startsWith("/api/ai/provider-settings?")) return initial;
    throw new Error(`Unexpected synthetic request: ${path}`);
  });
  const api = { get, post: vi.fn(), forRuntime: () => api } as unknown as ApiClient;
  useConnection.setState({ status: "signed-in", handle: "synthetic-owner", userId: "synthetic-user",
    platformHost: "https://synthetic.example.test", runtimeSlot: "primary", authGeneration: 1, api });
  return { get, creditReads: () => get.mock.calls.filter(([path]) => path === "/api/ai/provider-settings/managed-credit"),
    fullReads: () => get.mock.calls.filter(([path]) => path.startsWith("/api/ai/provider-settings?")) };
}

it("renews credit for six minutes through the actual maximized Settings chain", async () => {
  const api = installApi();
  useDesktopSurfaces.getState().maximizeToTab(tab.id);
  render(<FrameFromRealSurfaceState />);
  await act(async () => {});
  expect(useDesktopSurfaces.getState().surfaces[tab.id]?.mode).toBe("tab");
  expect(useDesktopSurfaces.getState().workspaceView).toBe("tabs");
  expect(screen.getByText("$4.00")).toBeVisible();
  const initialNativeReads = vi.mocked(window.operator.invoke).mock.calls.length;
  const initialCapabilityReads = api.get.mock.calls.filter(([path]) => path.includes("/workflows/")).length;
  for (let index = 1; index <= 8; index++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(api.creditReads()).toHaveLength(index);
    expect(screen.queryByText("Chat credit unavailable")).not.toBeInTheDocument();
  }
  expect(screen.getByText("$3.92")).toBeVisible();
  expect(api.fullReads()).toHaveLength(1);
  expect(window.operator.invoke).toHaveBeenCalledTimes(initialNativeReads);
  expect(api.get.mock.calls.filter(([path]) => path.includes("/workflows/"))).toHaveLength(initialCapabilityReads);
});
it("keeps visible unfocused floating Settings renewing, then pauses during Show Desktop", async () => {
  const api = installApi();
  useTabs.setState({ activeTabId: "another-surface" });
  render(<FrameFromRealSurfaceState />);
  await act(async () => {});
  expect(screen.getByText("$4.00")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(api.creditReads()).toHaveLength(1);
  await act(async () => { useDesktopSurfaces.getState().showDesktop(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(360_000); });
  expect(api.creditReads()).toHaveLength(1);
  await act(async () => { useDesktopSurfaces.getState().activateSurface(tab.id); useTabs.getState().focusTab(tab.id); });
  await act(async () => {});
  expect(api.creditReads()).toHaveLength(2);
  expect(screen.queryByText("Chat credit unavailable")).not.toBeInTheDocument();
  expect(api.fullReads()).toHaveLength(1);
});

it("forwards retained visibility and section ownership through the real Settings view", async () => {
  const api = installApi();
  const view = render(<SettingsView section="agents-providers" automaticCreditRefreshEnabled />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(api.creditReads()).toHaveLength(1);
  view.rerender(<SettingsView section="agents-providers" automaticCreditRefreshEnabled={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(api.creditReads()).toHaveLength(1);
  view.rerender(<SettingsView section="runtime" automaticCreditRefreshEnabled />);
  expect(screen.queryByText("Advanced Matrix AI settings")).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(api.creditReads()).toHaveLength(1);
});
