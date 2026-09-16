// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import NativeDesktopShell from "@desktop/renderer/src/features/desktop-shell/NativeDesktopShell";
import { openProviderSetupTerminal } from "@desktop/renderer/src/features/coding-agents/provider-setup-terminal";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";
import { useShellSessions } from "@desktop/renderer/src/stores/shell-sessions";
import { resetNativeOsViewStateClientForTests } from "@desktop/renderer/src/lib/os-view-state-client";
import { desktopQueryClient } from "@desktop/renderer/src/lib/query-client";

vi.mock("@desktop/renderer/src/features/mission-control/TabContent", () => ({
  TabPane: ({ tab }: { tab: { title: string } }) => <div>{tab.title} content</div>,
  TabErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@desktop/renderer/src/features/runtime/RuntimeComputerMenu", () => ({ default: () => null }));
vi.mock("@desktop/renderer/src/features/mission-control/AccountMenu", () => ({ default: () => null }));
vi.mock("@desktop/renderer/src/features/updates/DesktopUpdateButton", () => ({ default: () => null }));
vi.mock("@desktop/renderer/src/features/onboarding/GettingStartedPopover", () => ({ default: () => null }));

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  useShellSessions.setState(useShellSessions.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  useNativeDesktopMode.setState({ ...useNativeDesktopMode.getInitialState(), hydrated: true });
  resetNativeOsViewStateClientForTests();
  desktopQueryClient.clear();
  window.operator = { invoke: vi.fn(async () => ({ value: null })), on: vi.fn(() => () => {}) };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["closed", "minimized"] as const)("foregrounds the first auth terminal despite persisted %s state", async (state) => {
  const workspaceId = `tws_${"a".repeat(32)}`;
  const tabId = `tt_${"b".repeat(32)}`;
  const document = createDefaultOsViewDocument();
  document.apps = [{ path: "__terminal__", title: "Terminal", state }];
  const snapshot = { revision: 1, document, updatedAt: "2026-09-16T00:00:00.000Z" };
  const api = {
    get: vi.fn(async (path: string) => path === "/api/os-view-state" ? snapshot : path === "/api/apps" ? { apps: [] } : {}),
    post: vi.fn(async (path: string) => path === "/api/os-view-state/import-legacy-desktop" ? snapshot : path.endsWith("/ensure") ? { workspace: { id: workspaceId } } : { tab: { id: tabId } }),
    patch: vi.fn(async () => snapshot),
  };
  useConnection.setState({ status: "signed-in", api: api as never });
  // Login restores the root Terminal tab before the user visits Settings.
  useTabs.getState().openTab({ kind: "terminals", title: "Terminal", closable: false });
  useTabs.getState().openTab({ kind: "settings", title: "Settings" });
  render(<NativeDesktopShell overlayOpen={false} />);
  await waitFor(() => {
    const root = useTabs.getState().tabs.find((tab) => tab.kind === "terminals")!;
    expect(useDesktopSurfaces.getState().surfaces[root.id]?.mode).toBe(state);
  });
  await act(async () => {
    expect(await openProviderSetupTerminal(api as never, {
      key: "claude:claude_connect", label: "Connect Claude", command: "claude",
    }, useTabs.getState().openTab)).toBe(true);
  });
  expect(screen.getByRole("dialog", { name: "Terminal window" })).toBeTruthy();
  const terminal = useTabs.getState().tabs.find((tab) => tab.kind === "terminals")!;
  expect(useTabs.getState().activeTabId).toBe(terminal.id);
  expect(useDesktopSurfaces.getState().surfaces[terminal.id]?.mode).toBe("window");
  expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(`${workspaceId}:${tabId}`);
});
