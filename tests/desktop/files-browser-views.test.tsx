// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComputerFileBrowser from "../../desktop/src/renderer/src/features/files/ComputerFileBrowser";
import {
  parseBrowserEntries,
  sortBrowserEntries,
} from "../../desktop/src/renderer/src/features/files/browser-entries";
import { kindForEntry } from "../../desktop/src/renderer/src/features/files/file-kind";
import { formatBytes, formatModified } from "../../desktop/src/renderer/src/features/files/format";
import { useBrowserViewPreference } from "../../desktop/src/renderer/src/features/files/browser-view-preference";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const ROOT_ENTRIES = [
  { name: "workspaces", type: "directory", modified: new Date().toISOString(), children: 3 },
  { name: "assets", type: "directory", modified: new Date().toISOString(), children: 1 },
  { name: "README.md", type: "file", size: 2048, modified: new Date().toISOString() },
  { name: "hero.png", type: "file", size: 512, modified: new Date().toISOString() },
];

const WORKSPACE_ENTRIES = [
  { name: "app.ts", type: "file", size: 4096, modified: new Date().toISOString() },
];

function makeApi() {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/files/list?path=") return { entries: ROOT_ENTRIES };
    if (path === "/api/files/list?path=workspaces") return { entries: WORKSPACE_ENTRIES };
    return { entries: [] };
  });
  return { get, baseUrl: "https://app.matrix-os.com" };
}

function renderBrowser(props?: {
  compact?: boolean;
  mode?: "browse" | "folder-picker";
  onOpenFile?: (path: string) => void;
  onChooseFolder?: (path: string) => void;
  onCreateFolder?: (path: string) => void;
}) {
  return render(
    <Tooltip.Provider>
      <ComputerFileBrowser {...props} />
    </Tooltip.Provider>,
  );
}

function openLabels(): string[] {
  return screen
    .getAllByRole("button", { name: /^Open / })
    .map((button) => button.getAttribute("aria-label") ?? "");
}

describe("kindForEntry", () => {
  it("maps folders and known extensions to kinds", () => {
    expect(kindForEntry({ name: "workspaces", type: "directory" })).toBe("folder");
    expect(kindForEntry({ name: "hero.PNG", type: "file" })).toBe("image");
    expect(kindForEntry({ name: "app.tsx", type: "file" })).toBe("code");
    expect(kindForEntry({ name: "README.md", type: "file" })).toBe("document");
    expect(kindForEntry({ name: "spec.pdf", type: "file" })).toBe("document");
    expect(kindForEntry({ name: "backup.tar.gz", type: "file" })).toBe("archive");
    expect(kindForEntry({ name: "song.mp3", type: "file" })).toBe("audio");
    expect(kindForEntry({ name: "clip.mov", type: "file" })).toBe("video");
    expect(kindForEntry({ name: "LICENSE", type: "file" })).toBe("generic");
    expect(kindForEntry({ name: "data.xyz", type: "file" })).toBe("generic");
  });
});

describe("formatBytes", () => {
  it("formats byte counts with binary units", () => {
    expect(formatBytes(undefined)).toBe("–");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });
});

describe("formatModified", () => {
  const now = new Date(2026, 5, 24, 18, 0, 0);

  it("renders today and yesterday relatively, older dates short", () => {
    expect(formatModified(new Date(2026, 5, 24, 14, 30).toISOString(), now)).toBe("Today 14:30");
    expect(formatModified(new Date(2026, 5, 23, 9, 5).toISOString(), now)).toBe("Yesterday 09:05");
    expect(formatModified(new Date(2026, 2, 12, 9, 5).toISOString(), now)).toBe("12 Mar 2026");
  });

  it("falls back to a dash for missing or invalid dates", () => {
    expect(formatModified(undefined, now)).toBe("–");
    expect(formatModified("not-a-date", now)).toBe("–");
  });
});

describe("parseBrowserEntries", () => {
  it("keeps size, modified, and children metadata", () => {
    const entries = parseBrowserEntries([
      { name: "README.md", type: "file", size: 2048, modified: "2026-06-24T14:30:00.000Z" },
      { name: "workspaces", type: "directory", children: 3, modified: "2026-06-24T14:30:00.000Z" },
    ]);
    expect(entries).toEqual([
      expect.objectContaining({ name: "workspaces", type: "directory", children: 3 }),
      expect.objectContaining({ name: "README.md", type: "file", sizeBytes: 2048 }),
    ]);
  });

  it("drops malformed entries and bounds the listing", () => {
    const many = Array.from({ length: 1200 }, (_, index) => ({ name: `f${index}`, type: "file" }));
    const entries = parseBrowserEntries([{ name: 42 }, { nope: true }, ...many]);
    expect(entries).toHaveLength(1000);
    expect(entries.every((entry) => typeof entry.name === "string")).toBe(true);
  });
});

describe("sortBrowserEntries", () => {
  const entries = parseBrowserEntries([
    { name: "b.ts", type: "file", size: 100, modified: "2026-06-20T00:00:00.000Z" },
    { name: "z-dir", type: "directory", children: 8 },
    { name: "a.ts", type: "file", size: 900, modified: "2026-06-24T00:00:00.000Z" },
    { name: "a-dir", type: "directory", children: 2 },
  ]);

  it("keeps directories first and toggles name direction", () => {
    expect(sortBrowserEntries(entries, "name", "asc").map((entry) => entry.name)).toEqual([
      "a-dir",
      "z-dir",
      "a.ts",
      "b.ts",
    ]);
    expect(sortBrowserEntries(entries, "name", "desc").map((entry) => entry.name)).toEqual([
      "z-dir",
      "a-dir",
      "b.ts",
      "a.ts",
    ]);
  });

  it("sorts by size and modified within each group", () => {
    expect(sortBrowserEntries(entries, "size", "desc").map((entry) => entry.name)).toEqual([
      "z-dir",
      "a-dir",
      "a.ts",
      "b.ts",
    ]);
    expect(sortBrowserEntries(entries, "modified", "asc").map((entry) => entry.name)).toEqual([
      "a-dir",
      "z-dir",
      "b.ts",
      "a.ts",
    ]);
  });
});

describe("ComputerFileBrowser view options", () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    useBrowserViewPreference.setState({ view: "list" });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: api as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps keyboard focus inside the listing after navigating into a directory", async () => {
    renderBrowser();
    const folder = await screen.findByRole("button", { name: "Open workspaces" });
    folder.focus();
    expect(document.activeElement).toBe(folder);

    // Entering the directory unmounts every row. Focus must land back on the
    // listing, or arrow keys stop working and the user is stranded on <body>.
    fireEvent.keyDown(folder, { key: "Enter" });

    await screen.findByRole("button", { name: "Open app.ts" });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Open /);
    });
  });

  it("keeps keyboard focus inside the listing after switching view", async () => {
    renderBrowser();
    const entry = await screen.findByRole("button", { name: "Open README.md" });
    entry.focus();

    // Grid and list are distinct branches, so every row remounts.
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));

    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Open /);
    });
  });

  it("switches between list and grid from the segmented control", async () => {
    renderBrowser();
    expect(await screen.findByRole("button", { name: "Open README.md" })).toBeTruthy();

    // List view is the default: sortable column headers are visible.
    expect(screen.getByRole("button", { name: "Sort by name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "List view" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.queryByRole("button", { name: "Sort by name" })).toBeNull();
    expect(screen.getByRole("button", { name: "Grid view" }).getAttribute("aria-pressed")).toBe("true");
    // Entries still render as openable tiles.
    expect(screen.getByRole("button", { name: "Open README.md" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("button", { name: "Sort by name" })).toBeTruthy();
  });

  it("remembers the chosen view across remounts", async () => {
    const first = renderBrowser();
    await screen.findByRole("button", { name: "Open README.md" });
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    first.unmount();

    renderBrowser();
    await screen.findByRole("button", { name: "Open README.md" });
    expect(screen.getByRole("button", { name: "Grid view" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Sort by name" })).toBeNull();
  });

  it("shows size and modified columns in list view", async () => {
    renderBrowser();
    await screen.findByRole("button", { name: "Open README.md" });
    expect(screen.getByText("2 KB")).toBeTruthy();
    expect(screen.getByText("512 B")).toBeTruthy();
    // Directories show their item count instead of a byte size.
    expect(screen.getByText("3 items")).toBeTruthy();
  });

  it("gives the name column the flexible track with fixed right-aligned meta columns", async () => {
    renderBrowser();
    const row = await screen.findByRole("button", { name: "Open README.md" });

    // Name owns the flexible minmax track; Size/Modified are fixed-width
    // columns sized to the format.ts outputs so names only truncate when the
    // pane is genuinely out of room.
    expect(row.getAttribute("style")).toContain("minmax(0,1fr) 72px 104px");
    expect(screen.getByText("2 KB").className).toContain("text-right");
    const modifiedHeader = screen.getByRole("button", { name: "Sort by modified" });
    expect(modifiedHeader.className).toContain("justify-end");
  });

  it("uses tighter metadata tracks in the compact folder picker", async () => {
    renderBrowser({ compact: true, mode: "folder-picker", onChooseFolder: vi.fn() });
    const row = await screen.findByRole("button", { name: "Open workspaces" });

    expect(row.getAttribute("style")).toContain("minmax(0,1fr) 56px 80px");
    expect(screen.getByRole("button", { name: "Sort by name" }).parentElement?.className)
      .toContain("gap-1");
  });

  it("sorts the list when a column header is clicked", async () => {
    renderBrowser();
    await screen.findByRole("button", { name: "Open README.md" });

    // Default: directories first, then files, each name-ascending. Name
    // ordering is locale-aware (Finder-style), so "hero.png" sorts before
    // "README.md".
    expect(openLabels()).toEqual([
      "Open assets",
      "Open workspaces",
      "Open hero.png",
      "Open README.md",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Sort by name" }));
    expect(openLabels()).toEqual([
      "Open workspaces",
      "Open assets",
      "Open README.md",
      "Open hero.png",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Sort by size" }));
    expect(openLabels()).toEqual([
      "Open assets",
      "Open workspaces",
      "Open hero.png",
      "Open README.md",
    ]);
  });

  it("navigates with double-click in grid view and opens files with a single click", async () => {
    const onOpenFile = vi.fn();
    renderBrowser({ onOpenFile });
    await screen.findByRole("button", { name: "Open README.md" });
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));

    fireEvent.click(screen.getByRole("button", { name: "Open README.md" }));
    expect(onOpenFile).toHaveBeenCalledWith("README.md");

    fireEvent.doubleClick(screen.getByRole("button", { name: "Open workspaces" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/files/list?path=workspaces"));
    expect(await screen.findByRole("button", { name: "Open app.ts" })).toBeTruthy();
  });

  it("navigates via breadcrumb segments", async () => {
    renderBrowser();
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open workspaces" }));
    await screen.findByRole("button", { name: "Open app.ts" });

    fireEvent.click(screen.getByRole("button", { name: "Matrix home" }));
    expect(await screen.findByRole("button", { name: "Open README.md" })).toBeTruthy();
  });

  it("navigates backward and forward through folder history", async () => {
    renderBrowser();
    const back = await screen.findByRole("button", { name: "Back" });
    const forward = screen.getByRole("button", { name: "Forward" });
    expect(back.hasAttribute("disabled")).toBe(true);
    expect(forward.hasAttribute("disabled")).toBe(true);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Open workspaces" }));
    expect(await screen.findByRole("button", { name: "Open app.ts" })).toBeTruthy();
    expect(back.hasAttribute("disabled")).toBe(false);

    fireEvent.click(back);
    expect(await screen.findByRole("button", { name: "Open README.md" })).toBeTruthy();
    expect(forward.hasAttribute("disabled")).toBe(false);

    fireEvent.click(forward);
    expect(await screen.findByRole("button", { name: "Open app.ts" })).toBeTruthy();
  });

  it("marks managed Matrix folders and makes their browser surface read-only", async () => {
    const protectedApi = {
      get: vi.fn(async (path: string) => path === "/api/files/list?path="
        ? { entries: [{ name: "system", type: "directory", children: 2 }] }
        : { entries: [{ name: "config.json", type: "file", size: 128 }] }),
      baseUrl: "https://app.matrix-os.com",
    };
    useConnection.setState({ api: protectedApi as never });
    renderBrowser();

    const system = await screen.findByRole("button", { name: "Open system" });
    expect(within(system).getByText("Managed")).toBeTruthy();
    fireEvent.doubleClick(system);

    expect(await screen.findByText("Read only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload files" })).toBeNull();
  });

  it("supports arrow, Enter, and Backspace keyboard navigation in list view", async () => {
    const onOpenFile = vi.fn();
    renderBrowser({ onOpenFile });
    const assets = await screen.findByRole("button", { name: "Open assets" });

    assets.focus();
    fireEvent.keyDown(assets, { key: "ArrowDown" });
    const workspaces = screen.getByRole("button", { name: "Open workspaces" });
    expect(document.activeElement).toBe(workspaces);

    // Enter on a directory navigates into it.
    fireEvent.keyDown(workspaces, { key: "Enter" });
    const appTs = await screen.findByRole("button", { name: "Open app.ts" });

    // Enter on a file opens it.
    appTs.focus();
    fireEvent.keyDown(appTs, { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith("workspaces/app.ts");

    // Backspace returns to the parent folder.
    fireEvent.keyDown(appTs, { key: "Backspace" });
    expect(await screen.findByRole("button", { name: "Open README.md" })).toBeTruthy();

    // Alt+ArrowUp does the same from inside a folder.
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open workspaces" }));
    const appTsAgain = await screen.findByRole("button", { name: "Open app.ts" });
    fireEvent.keyDown(appTsAgain, { key: "ArrowUp", altKey: true });
    expect(await screen.findByRole("button", { name: "Open README.md" })).toBeTruthy();
  });

  it("moves selection with arrow keys in grid view", async () => {
    renderBrowser();
    await screen.findByRole("button", { name: "Open README.md" });
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));

    const assets = screen.getByRole("button", { name: "Open assets" });
    assets.focus();
    fireEvent.keyDown(assets, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open workspaces" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(assets);
  });

  it("goes up one level from the toolbar button", async () => {
    renderBrowser();
    const up = await screen.findByRole("button", { name: "Up one level" });
    expect(up.hasAttribute("disabled")).toBe(true);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Open workspaces" }));
    await screen.findByRole("button", { name: "Open app.ts" });
    fireEvent.click(screen.getByRole("button", { name: "Up one level" }));
    expect(await screen.findByRole("button", { name: "Open README.md" })).toBeTruthy();
  });

  it("keeps folder-picker behavior in both views", async () => {
    const onChooseFolder = vi.fn();
    renderBrowser({ compact: true, mode: "folder-picker", onChooseFolder });
    await screen.findByRole("button", { name: "Open workspaces" });

    // Files never appear as pick targets.
    expect(screen.queryByRole("button", { name: "Open README.md" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open assets" }));
    expect(
      screen.getByRole("button", { name: "Open assets" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Choose assets" }));
    expect(onChooseFolder).toHaveBeenCalledWith("assets");

    // Same flow in grid view.
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    fireEvent.click(screen.getByRole("button", { name: "Open workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose workspaces" }));
    expect(onChooseFolder).toHaveBeenCalledWith("workspaces");

    // Double-click still drills into a folder inside the picker.
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open workspaces" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/files/list?path=workspaces"));
  });

  it("offers the selected safe folder to the caller as a new-folder parent", async () => {
    const onCreateFolder = vi.fn();
    renderBrowser({
      compact: true,
      mode: "folder-picker",
      onChooseFolder: vi.fn(),
      onCreateFolder,
    });
    await screen.findByRole("button", { name: "Open workspaces" });

    fireEvent.click(screen.getByRole("button", { name: "Open workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: "New folder in workspaces" }));

    expect(onCreateFolder).toHaveBeenCalledWith("workspaces");
  });

  it("does not offer managed owner state as a new-folder parent", async () => {
    const managedApi = {
      get: vi.fn(async (path: string) => path === "/api/files/list?path="
        ? { entries: [{ name: "system", type: "directory", children: 1 }] }
        : { entries: [] }),
      baseUrl: "https://app.matrix-os.com",
    };
    useConnection.setState({ api: managedApi as never });
    renderBrowser({
      compact: true,
      mode: "folder-picker",
      onChooseFolder: vi.fn(),
      onCreateFolder: vi.fn(),
    });

    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open system" }));
    await waitFor(() => expect(managedApi.get).toHaveBeenCalledWith("/api/files/list?path=system"));

    expect(screen.queryByRole("button", { name: "New folder in system" })).toBeNull();
  });

  it("blocks choosing a denied subtree ancestor while allowing a safe child folder there", async () => {
    const protectedApi = {
      get: vi.fn(async (path: string) => path === "/api/files/list?path="
        ? { entries: [{ name: "data", type: "directory", children: 1 }] }
        : { entries: [] }),
      baseUrl: "https://app.matrix-os.com",
    };
    const onCreateFolder = vi.fn();
    useConnection.setState({ api: protectedApi as never });
    renderBrowser({
      compact: true,
      mode: "folder-picker",
      onChooseFolder: vi.fn(),
      onCreateFolder,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open data" }));

    expect(screen.getByRole("button", { name: "Choose data" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "New folder in data" }));
    expect(onCreateFolder).toHaveBeenCalledWith("data");
  });

  it("blocks denied browser profile state as a folder or new-folder parent", async () => {
    const protectedApi = {
      get: vi.fn(async (path: string) => {
        if (path === "/api/files/list?path=") {
          return { entries: [{ name: "data", type: "directory", children: 1 }] };
        }
        if (path === "/api/files/list?path=data") {
          return { entries: [{ name: "browser-profiles", type: "directory", children: 1 }] };
        }
        return { entries: [] };
      }),
      baseUrl: "https://app.matrix-os.com",
    };
    useConnection.setState({ api: protectedApi as never });
    renderBrowser({
      compact: true,
      mode: "folder-picker",
      onChooseFolder: vi.fn(),
      onCreateFolder: vi.fn(),
    });

    fireEvent.doubleClick(await screen.findByRole("button", { name: "Open data" }));
    const browserProfiles = await screen.findByRole("button", { name: "Open browser-profiles" });
    fireEvent.click(browserProfiles);

    expect(screen.getByRole("button", { name: "Choose browser-profiles" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "New folder in data/browser-profiles" })).toBeNull();
  });

  it("keeps project checkout descendants available after registry separation", async () => {
    const projectApi = {
      get: vi.fn(async (path: string) => {
        const name = decodeURIComponent(path.split("path=")[1] ?? "");
        const children: Record<string, string> = {
          "": "projects",
          projects: "demo",
          "projects/demo": "repo",
          "projects/demo/repo": "src",
        };
        const child = children[name];
        return { entries: child ? [{ name: child, type: "directory", children: 1 }] : [] };
      }),
      baseUrl: "https://app.matrix-os.com",
    };
    useConnection.setState({ api: projectApi as never });
    renderBrowser({
      compact: true,
      mode: "folder-picker",
      onChooseFolder: vi.fn(),
      onCreateFolder: vi.fn(),
    });

    for (const name of ["projects", "demo", "repo"]) {
      fireEvent.doubleClick(await screen.findByRole("button", { name: `Open ${name}` }));
    }
    fireEvent.click(await screen.findByRole("button", { name: "Open src" }));

    expect(screen.getByRole("button", { name: "Choose src" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "New folder in projects/demo/repo/src" })).toBeTruthy();
  });

  it("shows the empty state in grid view too", async () => {
    const emptyApi = { get: vi.fn(async () => ({ entries: [] })), baseUrl: "https://app.matrix-os.com" };
    useConnection.setState({ api: emptyApi as never });
    renderBrowser();
    await screen.findByText("This folder is empty.");
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getByText("This folder is empty.")).toBeTruthy();
  });
});
