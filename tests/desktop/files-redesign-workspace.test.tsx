// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilesWorkspaceV2 from "../../desktop/src/renderer/src/features/files/redesign/FilesWorkspaceV2";
import { activeNavIdForPath, buildFilesNav, pathForNavId } from "../../desktop/src/renderer/src/features/files/redesign/files-locations";
import { gridMove, typeaheadMatch } from "../../desktop/src/renderer/src/features/files/redesign/use-entry-navigation";
import { createSharedFlag, resolveFilesRedesign } from "../../desktop/src/renderer/src/features/files/redesign/use-files-redesign-flag";
import { useBrowserViewPreference } from "../../desktop/src/renderer/src/features/files/browser-view-preference";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useDesktopSurfaces } from "../../desktop/src/renderer/src/stores/desktop-surfaces";
import { useDesktopEditor } from "../../desktop/src/renderer/src/features/editor/desktop-editor-store";

const LIST: Record<string, { entries: Array<Record<string, unknown>> }> = {
  "/api/files/list?path=": {
    entries: [
      { name: "apps", type: "directory", children: 11 },
      { name: "system", type: "directory", children: 4 },
      { name: "notes", type: "directory", children: 2 },
      { name: "README.md", type: "file", size: 2048 },
      { name: "report.pdf", type: "file", size: 2_516_582 },
    ],
  },
  "/api/files/list?path=apps": { entries: [{ name: "team-tracker", type: "directory", children: 3 }] },
  "/api/files/list?path=notes": { entries: [] },
};

function makeApi() {
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/api/files/list?path=")) return LIST[path] ?? { entries: [] };
    if (path.startsWith("/api/files/stat?path=")) return { size: 2048, created: "2026-11-01T10:00:00.000Z", modified: "2026-11-02T10:00:00.000Z" };
    return { entries: [] };
  });
  const post = vi.fn(async () => ({ ok: true }));
  const putBytes = vi.fn(async () => ({ path: "uploaded" }));
  return { get, getText: vi.fn(async () => "# Notes"), getBlob: vi.fn(async () => new Blob([])), post, putBytes, forRuntime: vi.fn(() => ({ post, get })), baseUrl: "https://app.matrix-os.com" };
}

function renderWorkspace() {
  return render(<Tooltip.Provider><FilesWorkspaceV2 /></Tooltip.Provider>);
}

describe("Files redesign flag", () => {
  it("stays on the current Files layout unless PostHog turns the flag on or a dev build opts in", () => {
    expect(resolveFilesRedesign({ flag: true, hasSource: false, devOptIn: false })).toBe(false);
    expect(resolveFilesRedesign({ flag: true, hasSource: false, devOptIn: true })).toBe(true);
    expect(resolveFilesRedesign({ flag: null, hasSource: true, devOptIn: false })).toBeNull();
    expect(resolveFilesRedesign({ flag: false, hasSource: true, devOptIn: false })).toBe(false);
    expect(resolveFilesRedesign({ flag: true, hasSource: true, devOptIn: false })).toBe(true);
    expect(resolveFilesRedesign({ flag: false, hasSource: true, devOptIn: true })).toBe(true);
  });
});

describe("shared Files flag subscription", () => {
  it("subscribes once for every consumer and falls back to off after the timeout", () => {
    vi.useFakeTimers();
    try {
    let emit: ((value: boolean | undefined) => void) | null = null;
    const subscribe = vi.fn((_key: string, listener: (value: boolean | undefined) => void) => { emit = listener; return () => undefined; });
    const flag = createSharedFlag({ subscribe }, "desktop-files-redesign", 4000);
    const seen: Array<boolean | null> = [];
    const stops = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(() => flag.subscribe(() => seen.push(flag.getSnapshot())));
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(flag.getSnapshot()).toBeNull();
    emit!(true);
    expect(flag.getSnapshot()).toBe(true);
    expect(seen).toHaveLength(10);
    stops.forEach((stop) => stop());
    const late = createSharedFlag({ subscribe: vi.fn(() => () => undefined) }, "desktop-files-redesign", 4000);
    late.subscribe(() => undefined);
    vi.advanceTimersByTime(4000);
    expect(late.getSnapshot()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Files redesign locations", () => {
  it("lists only Matrix home folders that exist, with managed ones locked", () => {
    const nav = buildFilesNav({
      rootEntries: [{ name: "apps", type: "directory" }, { name: "system", type: "directory" }, { name: "apps.txt", type: "file" }],
      drivesAvailable: false,
    });
    const locations = nav.sections.find((section) => section.id === "locations");
    expect(locations?.items.map((item) => [item.label, Boolean(item.locked)])).toEqual([["Apps", false], ["System", true]]);
    expect(nav.sections.some((section) => section.id === "drives")).toBe(false);
    expect(nav.footer.items[0]!.label).toBe("Trash");
  });

  it("maps paths and sidebar rows both ways", () => {
    expect(activeNavIdForPath("")).toBe("home");
    expect(activeNavIdForPath("apps")).toBe("location:apps");
    expect(activeNavIdForPath("apps/team-tracker")).toBeNull();
    expect(pathForNavId("location:data")).toBe("data");
    expect(pathForNavId("trash")).toBeNull();
  });

  it("moves by visual row inside each grid section", () => {
    // Folders: 2 cards (row 0). Files: 4 cards (rows 0-1). Three columns.
    const sections = [2, 4];
    expect(gridMove(0, 1, sections, 3)).toBe(2);
    expect(gridMove(1, 1, sections, 3)).toBe(3);
    expect(gridMove(2, -1, sections, 3)).toBe(0);
    expect(gridMove(4, -1, sections, 3)).toBe(1);
    expect(gridMove(2, 1, sections, 3)).toBe(5);
    expect(gridMove(4, 1, sections, 3)).toBe(5);
    expect(gridMove(5, 1, sections, 3)).toBe(5);
    expect(gridMove(0, -1, sections, 3)).toBe(0);
  });

  it("jumps to the next name that starts with the typed prefix", () => {
    const names = ["apps", "notes", "README.md", "report.pdf"];
    expect(typeaheadMatch(names, "r", 0)).toBe(2);
    expect(typeaheadMatch(names, "r", 2)).toBe(3);
    expect(typeaheadMatch(names, "rep", 1)).toBe(3);
    expect(typeaheadMatch(names, "z", 0)).toBe(-1);
  });
});

describe("Files redesign workspace", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "pr-1",
      authGeneration: 1,
      organizationId: "org_matrix_team",
      organizationStatus: "member",
      api: api as never,
    });
    useBrowserViewPreference.setState({ view: "grid" });
    useTabs.setState({ tabs: [], activeTabId: null });
    useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
    useDesktopEditor.setState(useDesktopEditor.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the sidebar, a count line, and Folders and Files sections", async () => {
    renderWorkspace();
    const sidebar = screen.getByRole("navigation", { name: "Files locations" });
    expect(within(sidebar).getByRole("button", { name: "Matrix home" }).getAttribute("aria-current")).toBe("page");
    await within(sidebar).findByRole("button", { name: "Apps" });
    expect(within(sidebar).getByRole("button", { name: "All drives" })).toBeTruthy();
    expect(await screen.findByText("3 folders, 2 files")).toBeTruthy();
    const listbox = screen.getByRole("listbox", { name: "Contents of Matrix home" });
    expect(within(listbox).getByRole("group", { name: /Folders/ })).toBeTruthy();
    expect(within(listbox).getByRole("group", { name: /Files/ })).toBeTruthy();
    expect(within(listbox).getByRole("option", { name: "system" }).textContent).toContain("Managed");
  });

  it("selects one file, opens its details, and multi-selects into the selection bar", async () => {
    renderWorkspace();
    const report = await screen.findByRole("option", { name: "report.pdf" });
    fireEvent.click(report);
    expect(report.getAttribute("aria-selected")).toBe("true");
    // Selection alone never opens the panel, so the grid does not reflow under a double-click.
    expect(screen.queryByRole("complementary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    const details = await screen.findByRole("complementary", { name: "Details for report.pdf" });
    expect(within(details).getByText("PDF · 2.4 MB")).toBeTruthy();
    fireEvent.click(within(details).getByRole("tab", { name: "Details" }));
    expect(within(details).getByText("~/report.pdf")).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: "README.md" }), { metaKey: true });
    expect(screen.queryByRole("complementary", { name: /Details for/ })).toBeNull();
    // The open panel stays mounted with a placeholder instead of collapsing.
    expect(screen.getByRole("complementary", { name: "Details" }).textContent).toContain("2 items selected");
    expect(screen.getByRole("toolbar", { name: "2 selected" })).toBeTruthy();
    expect(screen.getByText("2 of 5 selected")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "2 selected" })).getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("toolbar", { name: /selected/ })).toBeNull();
  });

  it("selects everything with ⌘A and clears with Escape", async () => {
    renderWorkspace();
    const apps = await screen.findByRole("option", { name: "apps" });
    fireEvent.keyDown(apps, { key: "a", metaKey: true });
    expect(screen.getByText("5 of 5 selected")).toBeTruthy();
    fireEvent.keyDown(apps, { key: "Escape" });
    expect(screen.getByText("5 items")).toBeTruthy();
  });

  it("opens folders on double-click and navigates from the sidebar", async () => {
    renderWorkspace();
    fireEvent.doubleClick(await screen.findByRole("option", { name: "notes" }));
    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "notes" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("option", { name: "README.md" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apps" }));
    expect(await screen.findByRole("option", { name: "team-tracker" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apps" }).getAttribute("aria-current")).toBe("page");
  });

  it("switches to the list view with a header checkbox and sortable columns", async () => {
    renderWorkspace();
    await screen.findByRole("option", { name: "apps" });
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    const grid = await screen.findByRole("grid", { name: "Contents of Matrix home" });
    fireEvent.click(within(grid).getByRole("checkbox", { name: "Select README.md" }));
    expect(within(grid).getByRole("checkbox", { name: "Select all" }).getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(within(grid).getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByText("5 of 5 selected")).toBeTruthy();
    expect(useBrowserViewPreference.getState().view).toBe("list");
  });

  it("hides write actions in a managed folder", async () => {
    LIST["/api/files/list?path=system"] = { entries: [{ name: "theme.json", type: "file", size: 10 }] };
    renderWorkspace();
    fireEvent.doubleClick(await screen.findByRole("option", { name: "system" }));
    await screen.findByRole("option", { name: "theme.json" });
    expect(screen.queryByRole("button", { name: "Upload files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
    // The sidebar keeps the New button's space so its rows do not jump.
    expect(screen.getByRole("navigation", { name: "Files locations" }).firstElementChild?.firstElementChild?.className).toContain("h-8");
    expect(screen.getAllByText("Managed").length).toBeGreaterThan(0);
  });

  it("opens the focused file with Enter even when another file is selected", async () => {
    renderWorkspace();
    fireEvent.click(await screen.findByRole("option", { name: "README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    await screen.findByRole("complementary", { name: "Details for README.md" });
    fireEvent.keyDown(screen.getByRole("option", { name: "report.pdf" }), { key: "Enter" });
    expect(await screen.findByRole("complementary", { name: "Details for report.pdf" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "report.pdf" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps queued uploads when navigating to another folder", async () => {
    api.putBytes = vi.fn(() => new Promise(() => undefined)) as never;
    useConnection.setState({ api: api as never });
    renderWorkspace();
    await screen.findByRole("option", { name: "README.md" });
    const files = ["one", "two", "three", "four", "five"].map((name) => new File(["x"], `${name}.txt`, { type: "text/plain" }));
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files } });
    expect(await screen.findByText(/^four\.txt:/)).toBeTruthy();
    await waitFor(() => expect(api.putBytes).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Apps" }));
    await screen.findByRole("option", { name: "team-tracker" });
    expect(screen.getByText(/^one\.txt:/)).toBeTruthy();
    expect(screen.getByText(/^four\.txt:/)).toBeTruthy();
    LIST["/api/files/list?path=system"] = { entries: [{ name: "theme.json", type: "file", size: 10 }] };
    fireEvent.click(screen.getByRole("button", { name: /^System/ }));
    await screen.findByRole("option", { name: "theme.json" });
    expect(screen.getByText(/^four\.txt:/)).toBeTruthy();
    expect(api.putBytes).toHaveBeenCalledTimes(3);
  });

  it("drops the previous computer's listing after a runtime switch", async () => {
    renderWorkspace();
    await screen.findByRole("option", { name: "report.pdf" });
    const other = makeApi();
    other.get.mockImplementation(async (path: string) => (path === "/api/files/list?path=" ? { entries: [{ name: "other.txt", type: "file" }] } : { entries: [] }));
    useConnection.setState({ runtimeSlot: "pr-2", authGeneration: 2, api: other as never });
    await waitFor(() => expect(screen.queryByRole("option", { name: "report.pdf" })).toBeNull());
    expect(await screen.findByRole("option", { name: "other.txt" })).toBeTruthy();
  });
});
