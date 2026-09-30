// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AOEDE_APP_PATH,
  AOEDE_COMMAND_ID,
  aoedeEntrySupported,
  aoedeIdentityKey,
  aoedeSurfaceForDesktopMode,
  getAoedeShellFetcher,
  openAoedeHistory,
  openAoedeResult,
  revealShellAppWindow,
  resetAoedeShellFetcherForTests,
} from "../../shell/src/lib/aoede-shell.js";
import {
  isBuiltInAppPath,
  isRestorableBuiltInAppPath,
  isRetiredBuiltInAppPath,
  normalizeBuiltInAppPath,
  normalizeBuiltInLayoutWindow,
} from "../../shell/src/lib/builtin-apps.js";
import {
  buildWebDesktopIconApps,
  buildWebDesktopLauncherApps,
  resolveWebDesktopBuiltInLaunch,
} from "../../shell/src/lib/web-desktop-app-launch.js";
import { useCommandStore } from "../../shell/src/stores/commands.js";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode.js";
import {
  resetWindowManagerLayoutPersistenceForTests,
  useWindowManager,
} from "../../shell/src/hooks/useWindowManager.js";
import { usePreviewWindow } from "../../shell/src/hooks/usePreviewWindow.js";

const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal("fetch", fetchSpy);

function resetStores() {
  resetWindowManagerLayoutPersistenceForTests();
  resetAoedeShellFetcherForTests();
  useDesktopMode.setState({ mode: "desktop", previousMode: null, _hydrated: true });
  useWindowManager.setState({
    windows: [],
    nextZ: 1,
    closedPaths: new Set(),
    closedLayouts: new Map(),
    focusedWindowId: null,
    fullscreenWindowId: null,
  });
  useCommandStore.setState({ commands: new Map() });
  usePreviewWindow.setState({ tabs: [], activeTabId: null, unsavedTabs: new Set() });
}

describe("Aoede shell entry helpers", () => {
  beforeEach(resetStores);
  afterEach(() => vi.restoreAllMocks());

  it("maps OS views to the contract surface", () => {
    expect(aoedeSurfaceForDesktopMode("canvas")).toBe("web_canvas");
    expect(aoedeSurfaceForDesktopMode("desktop")).toBe("web_desktop");
  });

  it("composes a stable assistant identity from owner/runtime, not presentation surface", () => {
    const base = { userId: "user_1", runtimeSlot: null };
    expect(aoedeIdentityKey(base)).toBe(aoedeIdentityKey({ ...base }));
    expect(aoedeIdentityKey(base)).not.toBe(aoedeIdentityKey({ ...base, userId: "user_2" }));
    expect(aoedeIdentityKey(base)).not.toBe(aoedeIdentityKey({ ...base, runtimeSlot: "preview-2" }));
    expect(aoedeIdentityKey(base)).toBe(aoedeIdentityKey({ ...base }));
    expect(aoedeIdentityKey({ userId: null, runtimeSlot: null })).toContain("anonymous");
  });

  it("hides entry points on unsupported surfaces (mobile viewport or no mic capture)", () => {
    expect(aoedeEntrySupported(false, true)).toBe(true);
    expect(aoedeEntrySupported(true, true)).toBe(false);
    expect(aoedeEntrySupported(false, false)).toBe(false);
    expect(aoedeEntrySupported(true, false)).toBe(false);
  });

  it("keeps __aoede__ a recognized built-in that can never become a window", () => {
    expect(AOEDE_APP_PATH).toBe("__aoede__");
    expect(AOEDE_COMMAND_ID).toBe("app:__aoede__");
    expect(isBuiltInAppPath("__aoede__")).toBe(true);
    expect(isRetiredBuiltInAppPath("__aoede__")).toBe(true);
    expect(isRestorableBuiltInAppPath("__aoede__")).toBe(false);
    expect(normalizeBuiltInAppPath("aoede")).toBe("__aoede__");
    expect(normalizeBuiltInAppPath("assistant")).toBe("__aoede__");
    expect(normalizeBuiltInAppPath("apps/aoede/index.html")).toBe("__aoede__");
    expect(normalizeBuiltInLayoutWindow({
      path: "aoede",
      title: "aoede",
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      state: "open",
    })).toMatchObject({ path: "__aoede__", title: "Aoede" });
  });

  it("resolves the built-in path to the singleton assistant launch, not a window", () => {
    // Pure recognition only: the caller handles kind "aoede" explicitly and
    // routes to the registered command; it never falls through to windows.
    expect(resolveWebDesktopBuiltInLaunch("__aoede__")).toEqual({ kind: "aoede" });
  });

  it("presents Aoede as a first-class app icon only when entry is supported", () => {
    // Unsupported (default or explicit): hidden from every icon surface.
    expect(buildWebDesktopIconApps([]).some((app) => app.path === "__aoede__")).toBe(false);
    expect(buildWebDesktopIconApps([], { aoedeSupported: false }).some((app) => app.path === "__aoede__")).toBe(false);
    expect(buildWebDesktopLauncherApps([]).some((app) => app.path === "__aoede__")).toBe(false);
    expect(buildWebDesktopLauncherApps([], "desktop", { aoedeSupported: false }).some((app) => app.path === "__aoede__")).toBe(false);

    // Supported: first-class entry directly after Chat in icon and launcher lists.
    const iconApps = buildWebDesktopIconApps([], { aoedeSupported: true });
    expect(iconApps[0]?.path).toBe("__chat__");
    expect(iconApps[1]).toEqual({ name: "Aoede", path: "__aoede__" });
    const launcherApps = buildWebDesktopLauncherApps([], "desktop", { aoedeSupported: true });
    expect(launcherApps.some((app) => app.path === "__aoede__" && app.name === "Aoede")).toBe(true);

    // A catalog row can never smuggle in a second Aoede entry.
    const catalogDupe = { name: "Aoede", path: "__aoede__" };
    expect(buildWebDesktopIconApps([catalogDupe], { aoedeSupported: true })
      .filter((app) => app.path === "__aoede__")).toHaveLength(1);
    expect(buildWebDesktopIconApps([catalogDupe], { aoedeSupported: false })
      .some((app) => app.path === "__aoede__")).toBe(false);
  });

  it("never turns __aoede__ into a window through the reveal helper", () => {
    revealShellAppWindow("__aoede__", "Aoede");
    expect(useWindowManager.getState().windows).toHaveLength(0);
    // With the singleton command mounted, reveal dispatches it instead.
    const execute = vi.fn();
    useCommandStore.setState({
      commands: new Map([[AOEDE_COMMAND_ID, {
        id: AOEDE_COMMAND_ID, label: "Aoede", group: "Apps" as const, execute,
      }]]),
    });
    revealShellAppWindow("__aoede__", "Aoede");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(useWindowManager.getState().windows).toHaveLength(0);
  });

  it("prefers the registered launcher command when revealing a window", () => {
    const execute = vi.fn();
    useCommandStore.setState({
      commands: new Map([["app:__chat__", {
        id: "app:__chat__", label: "Chat", group: "Apps" as const, execute,
      }]]),
    });
    revealShellAppWindow("__chat__", "Chat");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(useWindowManager.getState().windows).toHaveLength(0);
  });

  it("falls back to the window manager when no launcher command exists", () => {
    revealShellAppWindow("__chat__", "Chat");
    const { windows, focusedWindowId } = useWindowManager.getState();
    expect(windows).toHaveLength(1);
    expect(windows[0].path).toBe("__chat__");
    expect(windows[0].title).toBe("Chat");
    expect(focusedWindowId).toBe(windows[0].id);
  });

  it("opens the exact backing record in the real Chat window for history", () => {
    const switchConversation = vi.fn();
    openAoedeHistory("chat_aoede_test", switchConversation);
    expect(switchConversation).toHaveBeenCalledWith("chat_aoede_test");
    expect(useWindowManager.getState().windows.some((w) => w.path === "__chat__")).toBe(true);
    expect(switchConversation).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or injection-shaped history targets", () => {
    const switchConversation = vi.fn();
    openAoedeHistory("chat_; DROP TABLE chats", switchConversation);
    openAoedeHistory("apps/chat/index.html", switchConversation);
    openAoedeHistory("", switchConversation);
    expect(switchConversation).not.toHaveBeenCalled();
    expect(useWindowManager.getState().windows).toHaveLength(0);
  });

  it("opens canonical results in the shared Preview window", () => {
    openAoedeResult("apps/notes/index.html");
    const preview = usePreviewWindow.getState();
    expect(preview.tabs.some((tab) => tab.path === "apps/notes/index.html")).toBe(true);
    expect(useWindowManager.getState().windows.some((w) => w.path === "__preview-window__")).toBe(true);
  });

  it("never navigates to sensitive or traversal paths from a result", () => {
    openAoedeResult("system/credentials.json");
    openAoedeResult("memory/agent.md");
    openAoedeResult("apps/%2e%2e/secrets.pem");
    expect(usePreviewWindow.getState().tabs).toHaveLength(0);
    expect(useWindowManager.getState().windows).toHaveLength(0);
  });

  it("binds the assistant fetcher to the voice-session grant rewrite once", () => {
    expect(getAoedeShellFetcher()).toBe(getAoedeShellFetcher());
    resetAoedeShellFetcherForTests();
    expect(getAoedeShellFetcher()).not.toBe(undefined);
  });
});
