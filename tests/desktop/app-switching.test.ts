import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cycleApp,
  registerDesktopShellEffects,
  minimizeActiveApp,
  openFilesApp,
  reopenClosedApp,
  switchToApp,
  taskbarOrder,
  toggleActiveAppFullSize,
  toggleAppLauncher,
  toggleShowDesktop,
} from "@desktop/renderer/src/features/desktop-shell/app-switching";
import { handleCloseSelectedAppShortcut } from "@desktop/renderer/src/features/mission-control/shortcuts";
import { useClosedApps } from "@desktop/renderer/src/stores/closed-apps";
import {
  isDesktopSurfaceVisible,
  useDesktopSurfaces,
} from "@desktop/renderer/src/stores/desktop-surfaces";
import { FILES_WORKSPACE_TAB_SPEC, useTabs, type Tab } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";

const VIEWPORT = { width: 1280, height: 800 };

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  useClosedApps.setState(useClosedApps.getInitialState(), true);
  useUi.setState(useUi.getInitialState(), true);
});

function reconcile() {
  useDesktopSurfaces.getState().reconcileTabs(useTabs.getState().tabs.map((tab) => tab.id), VIEWPORT);
}

function select(id: string) {
  useTabs.getState().focusTab(id);
  useDesktopSurfaces.getState().activateSurface(id);
}

/** Files, Notes, Terminal open as windows; Files selected. */
function threeApps() {
  const files = useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC);
  const notes = useTabs.getState().openTab({ kind: "notes", title: "Notes" });
  const terminal = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
  reconcile();
  select(files);
  return { files, notes, terminal };
}

const active = () => useTabs.getState().activeTabId;
const mode = (id: string) => useDesktopSurfaces.getState().surfaces[id]?.mode;
const visible = (id: string) => isDesktopSurfaceVisible(id, useDesktopSurfaces.getState());

describe("toggleAppLauncher", () => {
  it("opens and closes the App Launcher", () => {
    toggleAppLauncher();
    expect(useUi.getState().appLauncherOpen).toBe(true);
    toggleAppLauncher();
    expect(useUi.getState().appLauncherOpen).toBe(false);
  });
});

describe("taskbarOrder", () => {
  it("puts the Files tab first and leaves out closed and unreconciled tabs", () => {
    const notes = useTabs.getState().openTab({ kind: "notes", title: "Notes" });
    const files = useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC);
    const settings = useTabs.getState().openTab({ kind: "settings", title: "Settings" });
    reconcile();
    const unreconciled = useTabs.getState().openTab({ kind: "editor", title: "Editor" });
    useDesktopSurfaces.getState().closeSurface(settings);

    const order = taskbarOrder(useTabs.getState().tabs, useDesktopSurfaces.getState().surfaces);
    expect(order.map((tab: Tab) => tab.id)).toEqual([files, notes]);
    expect(order.some((tab: Tab) => tab.id === unreconciled)).toBe(false);
  });
});

describe("cycleApp", () => {
  it("cycles forward and backward through apps in taskbar order and wraps", () => {
    const { files, notes, terminal } = threeApps();

    cycleApp(1);
    expect(active()).toBe(notes);
    cycleApp(1);
    expect(active()).toBe(terminal);
    cycleApp(1);
    expect(active()).toBe(files);
    cycleApp(-1);
    expect(active()).toBe(terminal);
    expect(visible(terminal)).toBe(true);
  });

  it("skips a minimized app", () => {
    const { files, notes, terminal } = threeApps();
    useDesktopSurfaces.getState().minimizeSurface(notes);

    cycleApp(1);
    expect(active()).toBe(terminal);
    expect(mode(notes)).toBe("minimized");
    cycleApp(1);
    expect(active()).toBe(files);
  });

  it("does nothing with a single open app", () => {
    const files = useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC);
    reconcile();
    select(files);

    cycleApp(1);
    expect(active()).toBe(files);
    cycleApp(-1);
    expect(active()).toBe(files);
  });

  it("moves from a minimized active app to its neighbour in taskbar order", () => {
    const { files, notes, terminal } = threeApps();
    select(notes);
    useDesktopSurfaces.getState().minimizeSurface(notes);
    expect(active()).toBe(notes);

    cycleApp(1);
    expect(active()).toBe(terminal);

    select(notes);
    useDesktopSurfaces.getState().minimizeSurface(notes);
    cycleApp(-1);
    expect(active()).toBe(files);
  });

  it("wraps from a hidden active app at the end of the taskbar", () => {
    const { files, terminal } = threeApps();
    select(terminal);
    useDesktopSurfaces.getState().minimizeSurface(terminal);

    cycleApp(1);
    expect(active()).toBe(files);
  });

  it("lands on a full-size app by switching the workspace to tabs", () => {
    const { notes } = threeApps();
    useDesktopSurfaces.getState().maximizeToTab(notes);
    select(useTabs.getState().tabs[0]!.id);
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");

    cycleApp(1);
    expect(active()).toBe(notes);
    expect(visible(notes)).toBe(true);
  });
});

describe("switchToApp", () => {
  it("restores and focuses a minimized app at the given position", () => {
    const { terminal } = threeApps();
    useDesktopSurfaces.getState().minimizeSurface(terminal);

    switchToApp(3);
    expect(mode(terminal)).toBe("window");
    expect(active()).toBe(terminal);
    expect(visible(terminal)).toBe(true);
  });

  it("does nothing when no app occupies the position", () => {
    const { files } = threeApps();
    const before = useDesktopSurfaces.getState().surfaces;

    switchToApp(9);
    expect(active()).toBe(files);
    expect(useDesktopSurfaces.getState().surfaces).toBe(before);
  });

  it("counts the fixed Files slot when Files is not open", () => {
    const notes = useTabs.getState().openTab({ kind: "notes", title: "Notes" });
    const terminal = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
    reconcile();
    select(notes);

    switchToApp(3);
    expect(active()).toBe(terminal);

    switchToApp(1);
    const activeTab = useTabs.getState().tabs.find((tab) => tab.id === active());
    expect(activeTab).toMatchObject({ kind: "files", title: "Files" });
  });
});

describe("minimizeActiveApp", () => {
  it("minimizes the selected app and focuses the topmost remaining visible app", () => {
    const { files, notes, terminal } = threeApps();
    select(notes);
    select(terminal);

    minimizeActiveApp();
    expect(mode(terminal)).toBe("minimized");
    expect(active()).toBe(notes);
    expect(mode(files)).toBe("window");
  });
});

describe("toggleActiveAppFullSize", () => {
  it("toggles the selected app between window and full size", () => {
    const { notes } = threeApps();
    select(notes);

    toggleActiveAppFullSize();
    expect(mode(notes)).toBe("tab");
    expect(useDesktopSurfaces.getState().workspaceView).toBe("tabs");
    expect(active()).toBe(notes);

    toggleActiveAppFullSize();
    expect(mode(notes)).toBe("window");
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
    expect(active()).toBe(notes);
  });
});

describe("toggleShowDesktop", () => {
  it("hides every visible app and restores the same set on the next call", () => {
    const { files, notes, terminal } = threeApps();
    useDesktopSurfaces.getState().minimizeSurface(notes);

    toggleShowDesktop();
    expect([files, notes, terminal].some(visible)).toBe(false);

    toggleShowDesktop();
    expect(visible(files)).toBe(true);
    expect(visible(terminal)).toBe(true);
    expect(mode(notes)).toBe("minimized");
  });

  it("does not reopen an app closed while the desktop was shown", () => {
    const { files, terminal } = threeApps();

    toggleShowDesktop();
    useDesktopSurfaces.getState().closeSurface(terminal);
    toggleShowDesktop();

    expect(visible(files)).toBe(true);
    expect(mode(terminal)).toBe("closed");
    expect(visible(terminal)).toBe(false);
  });
});

describe("toggleShowDesktop from a full-size app", () => {
  it("returns to the tabs view and the full-size app on the second call", () => {
    const { files, notes } = threeApps();
    useDesktopSurfaces.getState().maximizeToTab(notes);
    useTabs.getState().focusTab(notes);
    expect(visible(notes)).toBe(true);

    toggleShowDesktop();
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
    expect(visible(notes)).toBe(false);
    expect(visible(files)).toBe(false);

    toggleShowDesktop();
    expect(useDesktopSurfaces.getState().workspaceView).toBe("tabs");
    expect(mode(notes)).toBe("tab");
    expect(visible(notes)).toBe(true);
    expect(active()).toBe(notes);
  });

  it("stays on the desktop when the full-size app was closed in between", () => {
    const { files, notes } = threeApps();
    useDesktopSurfaces.getState().maximizeToTab(notes);
    useTabs.getState().focusTab(notes);

    toggleShowDesktop();
    useDesktopSurfaces.getState().closeSurface(notes);
    toggleShowDesktop();

    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
    expect(mode(notes)).toBe("closed");
    expect(visible(files)).toBe(true);
  });
});

describe("openFilesApp", () => {
  it("opens Files when it is not open", () => {
    openFilesApp();
    const activeTab = useTabs.getState().tabs.find((tab) => tab.id === active());
    expect(activeTab).toMatchObject({ kind: "files", title: "Files" });
  });

  it("restores and focuses an open Files tab", () => {
    const { files, notes } = threeApps();
    useDesktopSurfaces.getState().minimizeSurface(files);
    select(notes);

    openFilesApp();
    expect(active()).toBe(files);
    expect(mode(files)).toBe("window");
    expect(useTabs.getState().tabs.filter((tab) => tab.kind === "files")).toHaveLength(1);
  });
});

describe("reopenClosedApp", () => {
  it("restores a separately opened tab as its own tab instead of reusing the one that is still open", () => {
    const main = useTabs.getState().openTab({ kind: "files", title: "Docs", slug: "docs" });
    const second = useTabs.getState().openTabInstance({ kind: "files", title: "Docs", slug: "docs" });
    reconcile();
    select(second);

    handleCloseSelectedAppShortcut({ preventDefault: () => undefined });
    expect(useTabs.getState().tabs.some((tab) => tab.id === second)).toBe(false);

    reopenClosedApp();
    expect(active()).not.toBe(main);
    expect(useTabs.getState().tabs.filter((tab) => tab.kind === "files" && tab.slug === "docs")).toHaveLength(2);
  });

  it("reopens the last app closed with the Close app shortcut", () => {
    const docs = useTabs.getState().openTab({ kind: "files", title: "Docs", slug: "docs" });
    const notes = useTabs.getState().openTab({ kind: "notes", title: "Notes" });
    reconcile();
    select(docs);

    handleCloseSelectedAppShortcut({ preventDefault: () => undefined });
    expect(useTabs.getState().tabs.some((tab) => tab.id === docs)).toBe(false);
    expect(active()).toBe(notes);

    reopenClosedApp();
    const activeTab = useTabs.getState().tabs.find((tab) => tab.id === active());
    expect(activeTab).toMatchObject({ kind: "files", slug: "docs", title: "Docs" });
    expect(activeTab?.id).not.toBe(docs);
  });

  it.each([
    ["Chat", { kind: "chat" as const, title: "Chat", closable: false }],
    ["Files", FILES_WORKSPACE_TAB_SPEC],
  ])("reopens a non-closable %s app whose tab stayed open", (_name, spec) => {
    const appId = useTabs.getState().openTab(spec);
    const notes = useTabs.getState().openTab({ kind: "notes", title: "Notes" });
    reconcile();
    select(appId);

    handleCloseSelectedAppShortcut({ preventDefault: () => undefined });
    expect(mode(appId)).toBe("closed");
    expect(useTabs.getState().tabs.some((tab) => tab.id === appId)).toBe(true);
    expect(active()).toBe(notes);

    reopenClosedApp();
    expect(active()).toBe(appId);
    expect(mode(appId)).toBe("window");
    expect(visible(appId)).toBe(true);
    expect(useTabs.getState().tabs.find((tab) => tab.id === appId)?.closable).toBe(false);
    expect(useTabs.getState().tabs).toHaveLength(2);
  });

  it("does nothing with no closed apps", () => {
    const { files } = threeApps();
    const tabsBefore = useTabs.getState().tabs;

    reopenClosedApp();
    expect(useTabs.getState().tabs).toBe(tabsBefore);
    expect(active()).toBe(files);
  });
});

describe("desktop shell side effects", () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it("schedules a durable save for every shortcut action that changes app state", () => {
    const schedulePersist = vi.fn();
    unregister = registerDesktopShellEffects({ schedulePersist, openRoot: (open) => open() });
    const { notes } = threeApps();

    const actions: Array<[string, () => void]> = [
      ["cycleApp", () => cycleApp(1)],
      ["switchToApp", () => switchToApp(2)],
      ["toggleActiveAppFullSize", () => { select(notes); toggleActiveAppFullSize(); }],
      ["minimizeActiveApp", () => minimizeActiveApp()],
      ["toggleShowDesktop", () => toggleShowDesktop()],
      ["openFilesApp", () => openFilesApp()],
    ];
    for (const [name, run] of actions) {
      schedulePersist.mockClear();
      run();
      expect(schedulePersist, name).toHaveBeenCalled();
    }
  });

  it("opens reopened apps through the shell so their window is placed", () => {
    const openRoot = vi.fn((open: () => void) => open());
    unregister = registerDesktopShellEffects({ schedulePersist: vi.fn(), openRoot });
    useClosedApps.getState().push({ id: "gone", kind: "notes", title: "Notes", closable: true });

    reopenClosedApp();
    expect(openRoot).toHaveBeenCalledTimes(1);
    expect(useTabs.getState().tabs.find((tab) => tab.id === active())).toMatchObject({ kind: "notes" });
  });

  it("refreshes the desktop background when a native browser view is minimized or the desktop is shown", () => {
    const home = useTabs.getState().openTab({ kind: "home", title: "Home" });
    const notes = useTabs.getState().openTab({ kind: "notes", title: "Notes" });
    reconcile();
    select(notes);
    select(home);
    const refreshes = () => useUi.getState().desktopBackgroundRefreshRequest;

    minimizeActiveApp();
    expect(refreshes()).toBe(1);
    toggleShowDesktop();
    expect(refreshes()).toBe(2);
  });

  it("stops calling the shell after it unregisters", () => {
    const schedulePersist = vi.fn();
    registerDesktopShellEffects({ schedulePersist, openRoot: (open) => open() })();
    threeApps();

    cycleApp(1);
    expect(schedulePersist).not.toHaveBeenCalled();
  });
});
