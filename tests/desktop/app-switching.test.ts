import { beforeEach, describe, expect, it } from "vitest";
import {
  cycleApp,
  minimizeActiveApp,
  openFilesApp,
  reopenClosedApp,
  switchToApp,
  taskbarOrder,
  toggleActiveAppFullSize,
  toggleShowDesktop,
} from "@desktop/renderer/src/features/desktop-shell/app-switching";
import { handleCloseSelectedAppShortcut } from "@desktop/renderer/src/features/mission-control/shortcuts";
import { useClosedApps } from "@desktop/renderer/src/stores/closed-apps";
import {
  isDesktopSurfaceVisible,
  useDesktopSurfaces,
} from "@desktop/renderer/src/stores/desktop-surfaces";
import { FILES_WORKSPACE_TAB_SPEC, useTabs, type Tab } from "@desktop/renderer/src/stores/tabs";

const VIEWPORT = { width: 1280, height: 800 };

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  useClosedApps.setState(useClosedApps.getInitialState(), true);
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

  it("does not record a non-closable app whose tab stays open", () => {
    const { files } = threeApps();

    handleCloseSelectedAppShortcut({ preventDefault: () => undefined });
    expect(mode(files)).toBe("closed");
    expect(useClosedApps.getState().entries).toEqual([]);
  });

  it("does nothing with no closed apps", () => {
    const { files } = threeApps();
    const tabsBefore = useTabs.getState().tabs;

    reopenClosedApp();
    expect(useTabs.getState().tabs).toBe(tabsBefore);
    expect(active()).toBe(files);
  });
});
