// @vitest-environment jsdom
import React from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Desktop } from "../../shell/src/components/Desktop.js";
import type { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";
import type { useDesktopConfigStore } from "../../shell/src/stores/desktop-config.js";
import type { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";
import type { useCommandStore } from "../../shell/src/stores/commands.js";
import { createShellQueryClient } from "../../shell/src/api/query-client.js";
import type { AoedeBootstrapResponse } from "../../packages/contracts/src/aoede.js";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { AoedeApi } from "../../packages/ui/src/aoede/client.js";
import type { VoiceSessionClient } from "../../packages/ui/src/voice-session/client-types.js";
import type { CanonicalChatInvalidation } from "../../packages/ui/src/canonical-chat-event-source.js";
import type { ShellAoedeHost } from "../../shell/src/components/ShellAoedeHost.js";
import { AOEDE_COMMAND_ID } from "../../shell/src/lib/aoede-shell.js";

vi.mock("../../shell/src/hooks/useFileWatcher.js", () => ({
  useFileWatcher: () => undefined,
}));

vi.mock("../../shell/src/components/terminal/TerminalApp.js", () => ({
  TerminalApp: () => null,
}));

vi.mock("../../shell/src/components/AppViewer.js", () => ({
  AppViewer: () => null,
}));

vi.mock("../../shell/src/components/file-browser/FileBrowser.js", () => ({
  FileBrowser: () => null,
}));

vi.mock("../../shell/src/components/preview-window/PreviewWindow.js", () => ({
  PreviewWindow: () => null,
}));

vi.mock("../../shell/src/components/system-activity/ActivityMonitorApp.js", () => ({
  ActivityMonitorApp: () => null,
}));

vi.mock("../../shell/src/components/AIButton.js", () => ({
  AIButton: () => null,
}));

vi.mock("../../shell/src/components/MissionControl.js", () => ({
  MissionControl: ({
    open,
    apps,
    onOpenApp,
  }: {
    open: boolean;
    apps: Array<{ name: string; path: string }>;
    onOpenApp: (name: string, path: string) => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="launcher-destinations">
        {apps.map((app) => (
          <button key={app.path} type="button" onClick={() => onOpenApp(app.name, app.path)}>
            {app.name}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock("../../shell/src/components/DotGrid.js", () => ({
  DotGrid: () => null,
}));

vi.mock("../../shell/src/components/Settings.js", () => ({
  Settings: () => null,
}));

vi.mock("../../shell/src/components/canvas/CanvasRenderer.js", () => ({
  CanvasRenderer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../shell/src/components/canvas/CanvasToolbar.js", () => ({
  CanvasToolbar: () => null,
}));

vi.mock("../../shell/src/components/UserButton.js", () => ({
  UserButton: () => null,
}));

vi.mock("../../shell/src/components/organization/OrganizationSwitcher.js", () => ({
  OrganizationSwitcher: () => null,
}));

vi.mock("../../shell/src/components/ConnectionIndicator.js", () => ({
  ConnectionIndicator: () => null,
}));

vi.mock("../../shell/src/components/AmbientClock.js", () => ({
  AmbientClock: () => null,
}));

vi.mock("../../shell/src/components/MenuBar.js", () => ({
  MenuBar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../shell/src/components/ChatApp.js", () => ({
  ChatApp: () => null,
}));

vi.mock("../../shell/src/components/onboarding/ManualSetupStickers.js", () => ({
  ManualSetupStickers: () => null,
}));

vi.mock("../../shell/src/components/onboarding/GettingStartedPopover.js", () => ({
  GettingStartedPopover: () => null,
}));

vi.mock("../../shell/src/components/RuntimeIdentityBanner.js", () => ({
  RuntimeIdentityBanner: () => null,
}));

vi.mock("../../shell/src/components/developer/DeveloperModeDashboard.js", () => ({
  DeveloperModeDashboard: () => null,
}));

const binding: AoedeBootstrapResponse = {
  chatId: "chat_aoede",
  scope: { kind: "workspace", id: "workspace", label: "Workspace" },
  selection: { instanceId: "pi_main", model: "test:model" },
  capability: {
    contractVersion: 1,
    surface: "web_desktop",
    status: "available",
    transportModes: ["relayed_websocket"],
    turnModes: ["hands_free", "push_to_talk"],
    supportsInterruption: true,
    resume: "delivery_aware",
    sessionOnly: "unsupported",
    actionMode: "canonical_actions",
    actionCancellation: "run",
    supportsInputSelection: false,
    supportsOutputSelection: false,
  },
};

const detail: CanonicalChatDetailResponse = {
  record: {
    chat: {
      id: "chat_aoede",
      revision: 0,
      ownerScope: { type: "personal", ownerId: "owner_test" },
      title: "Aoede",
      lifecycle: "active",
      attention: "none",
      messageCount: 0,
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  },
  messages: [],
  turns: [],
  runs: [],
  activities: [],
};

function aoedeHarness() {
  const source = {
    subscribe: vi.fn((_listener: (event: CanonicalChatInvalidation) => void) => ({ dispose: vi.fn() })),
    start: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const bootstrap = vi.fn(async () => binding);
  const api = {
    bootstrap,
    detail: vi.fn(async () => detail),
    events: () => source,
    cancelRun: vi.fn(async () => ({})),
    submitInput: vi.fn(async () => ({})),
    submitApproval: vi.fn(async () => ({})),
  } as unknown as AoedeApi;
  const media = {
    subscribe: vi.fn(() => () => {}),
    getSnapshot: () => ({
      phase: "idle",
      voice: null,
      error: null,
      notice: null,
      chatId: null,
      sessionId: null,
      reconnectStatus: null,
    }),
    startVoice: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    dispose: vi.fn(),
    controller: () => null,
    retry: vi.fn(),
  } as unknown as VoiceSessionClient;
  const voiceFactory = vi.fn(() => media);
  return { api, bootstrap, source, media, voiceFactory };
}

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function stubMediaDevices(present: boolean) {
  Object.defineProperty(window.navigator, "mediaDevices", {
    value: present ? { getUserMedia: vi.fn(async () => ({})) } : undefined,
    configurable: true,
  });
}

type DesktopComponentType = typeof Desktop;
type HostComponentType = typeof ShellAoedeHost;
type DesktopModeStore = typeof useDesktopMode;
type DesktopConfigStore = typeof useDesktopConfigStore;
type WindowManagerStore = typeof useWindowManager;
type CommandStore = typeof useCommandStore;

let DesktopComponent: DesktopComponentType;
let AoedeHostComponent: HostComponentType;
let desktopModeStore: DesktopModeStore;
let desktopConfigStore: DesktopConfigStore;
let windowManagerStore: WindowManagerStore;
let commandStore: CommandStore;
let resetLayoutPersistence: () => void;
let queryClient: QueryClient;

function renderDesktopWithAoede(
  deps: ReturnType<typeof aoedeHarness>,
  aoedeSupported = true,
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AoedeHostComponent
        userId="owner_test"
        runtimeSlot={null}
        surface="web_desktop"
        supported={aoedeSupported}
        controllerDeps={{ api: deps.api, voiceFactory: deps.voiceFactory }}
      >
        <DesktopComponent />
      </AoedeHostComponent>
    </QueryClientProvider>,
  );
}

function resetShell() {
  desktopModeStore.setState({ mode: "desktop", previousMode: null, _hydrated: true });
  desktopConfigStore.setState({
    dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
    pinnedApps: [],
  });
  windowManagerStore.setState({
    windows: [],
    nextZ: 1,
    closedPaths: new Set(),
    closedLayouts: new Map(),
    focusedWindowId: null,
    fullscreenWindowId: null,
  });
  commandStore.setState({ commands: new Map() });
}

describe("Aoede desktop/launcher icon", () => {
  beforeEach(async () => {
    vi.resetModules();
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/settings/onboarding-status")) return jsonResponse({ complete: true });
      if (url.includes("/api/shell/bootstrap")) return jsonResponse({ layout: { windows: [] }, apps: [], modules: [] });
      return jsonResponse({});
    }));
    DesktopComponent = (await import("../../shell/src/components/Desktop.js")).Desktop;
    // Dynamically imported like Desktop so the host registers its command in
    // the same fresh store instance the launch path resolves against.
    AoedeHostComponent = (await import("../../shell/src/components/ShellAoedeHost.js")).ShellAoedeHost;
    desktopModeStore = (await import("../../shell/src/stores/desktop-mode.js")).useDesktopMode;
    desktopConfigStore = (await import("../../shell/src/stores/desktop-config.js")).useDesktopConfigStore;
    (await import("../../shell/src/stores/desktop-config.js")).resetWebDesktopIconsRuntime();
    const windowManagerModule = await import("../../shell/src/hooks/useWindowManager.js");
    windowManagerStore = windowManagerModule.useWindowManager;
    resetLayoutPersistence = windowManagerModule.resetWindowManagerLayoutPersistenceForTests;
    commandStore = (await import("../../shell/src/stores/commands.js")).useCommandStore;
    queryClient = createShellQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
  });

  afterEach(() => {
    resetLayoutPersistence();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("reveals the singleton from the desktop icon without another window or microphone capture", async () => {
    stubMediaDevices(true);
    resetShell();
    const h = aoedeHarness();
    renderDesktopWithAoede(h);

    const desktopNav = await screen.findByRole("navigation", { name: "Desktop apps" });
    const aoedeIcon = await within(desktopNav).findByRole("button", { name: "Aoede" });
    await act(async () => {
      fireEvent.doubleClick(aoedeIcon);
    });

    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeTruthy());
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
    // Main opens Chat on startup; the icon must add no window or microphone capture.
    expect(h.media.startVoice).not.toHaveBeenCalled();
    expect(windowManagerStore.getState().windows.map((windowRecord) => windowRecord.path)).toEqual(["__chat__"]);
  });

  it("converges launcher-tile, desktop-icon and palette invocations on the one instance", async () => {
    stubMediaDevices(true);
    resetShell();
    const h = aoedeHarness();
    renderDesktopWithAoede(h);

    const desktopNav = await screen.findByRole("navigation", { name: "Desktop apps" });
    const aoedeIcon = await within(desktopNav).findByRole("button", { name: "Aoede" });

    // Race: launcher tile, palette command, and desktop icon together.
    fireEvent.click(await screen.findByRole("button", { name: "Open App Launcher" }));
    const launcher = await screen.findByTestId("launcher-destinations");
    const aoedeTile = within(launcher).getByRole("button", { name: "Aoede" });
    await act(async () => {
      fireEvent.click(aoedeTile);
      commandStore.getState().commands.get(AOEDE_COMMAND_ID)?.execute();
      fireEvent.doubleClick(aoedeIcon);
      commandStore.getState().commands.get(AOEDE_COMMAND_ID)?.execute();
    });

    await waitFor(() => expect(screen.getByTestId("aoede-host")).toBeTruthy());
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
    expect(h.voiceFactory).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-testid='aoede-host']")).toHaveLength(1);
    expect(windowManagerStore.getState().windows.map((windowRecord) => windowRecord.path)).toEqual(["__chat__"]);
    expect(h.media.startVoice).not.toHaveBeenCalled();
  });

  it("hides every icon path and registers no command when unsupported", async () => {
    stubMediaDevices(false);
    resetShell();
    const h = aoedeHarness();
    renderDesktopWithAoede(h, false);

    const desktopNav = await screen.findByRole("navigation", { name: "Desktop apps" });
    await within(desktopNav).findByRole("button", { name: "Terminal" });
    expect(within(desktopNav).queryByRole("button", { name: "Aoede" })).toBeNull();
    expect(screen.queryByTestId("aoede-launcher")).toBeNull();
    expect(commandStore.getState().commands.has(AOEDE_COMMAND_ID)).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "Open App Launcher" }));
    const launcher = await screen.findByTestId("launcher-destinations");
    expect(within(launcher).queryByRole("button", { name: "Aoede" })).toBeNull();

    expect(h.bootstrap).not.toHaveBeenCalled();
    expect(windowManagerStore.getState().windows.map((windowRecord) => windowRecord.path)).toEqual(["__chat__"]);
  });
});
