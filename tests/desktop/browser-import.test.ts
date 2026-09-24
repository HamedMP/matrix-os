import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerIpcHandlers, type HandlerContext } from "@desktop/main/ipc/handlers";
import {
  importBrowserPages,
  listBrowserImportSources,
  scanBrowserImportCandidates,
  parseArcSidebar,
  parseChromiumBookmarks,
  parseFirefoxBookmarks,
  parseSafariBookmarks,
} from "@desktop/main/browser/import-pages";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "matrix-browser-import-"));
  tempDirs.push(home);
  return home;
}

describe("local browser page import", () => {
  it("parses Chromium bookmark folders and skips unsafe or duplicate URLs", () => {
    expect(parseChromiumBookmarks({ roots: { bookmark_bar: { type: "folder", children: [
      { type: "url", name: "Docs", url: "https://example.com/docs" },
      { type: "folder", name: "Work", children: [
        { type: "url", name: "Project", url: "https://work.example/path" },
        { type: "url", name: "unsafe", url: "javascript:alert(1)" },
      ] },
      { type: "url", name: "duplicate", url: "https://example.com/docs" },
    ] } } })).toEqual([
      { title: "Docs", url: "https://example.com/docs", folder: "Bookmarks bar" },
      { title: "Project", url: "https://work.example/path", folder: "Bookmarks bar / Work" },
    ]);
  });

  it("imports active Arc sidebar tabs without reading archived sync entries", () => {
    expect(parseArcSidebar({
      sidebar: { containers: [{ items: [
        "one", { id: "one", title: "Pinned", data: { tab: { savedURL: "https://arc.example/one", savedTitle: "First" } } },
        "two", { id: "two", data: { tab: { savedURL: "https://arc.example/two", savedTitle: "Second" } } },
        "bad", { id: "bad", data: { tab: { savedURL: "file:///private/key", savedTitle: "Bad" } } },
      ] }] },
      firebaseSyncState: { syncData: { items: [{ value: { data: { tab: { savedURL: "https://archived.example" } } } }] } },
    })).toEqual([
      { title: "First", url: "https://arc.example/one", folder: "Arc tabs" },
      { title: "Second", url: "https://arc.example/two", folder: "Arc tabs" },
    ]);
  });

  it("parses Safari bookmark folders and reading-list links", () => {
    expect(parseSafariBookmarks({ Children: [
      { Title: "Favorites", Children: [
        { WebBookmarkType: "WebBookmarkTypeLeaf", URLString: "https://safari.example", URIDictionary: { title: "Safari page" } },
        { WebBookmarkType: "WebBookmarkTypeLeaf", URLString: "file:///private/secret", URIDictionary: { title: "Local" } },
      ] },
    ] })).toEqual([{ title: "Safari page", url: "https://safari.example/", folder: "Favorites" }]);
  });

  it("parses Firefox bookmark rows without internal pages", () => {
    expect(parseFirefoxBookmarks([
      { title: "Firefox page", url: "https://firefox.example", folder: "Toolbar" },
      { title: "Internal", url: "about:config", folder: "Toolbar" },
    ])).toEqual([{ title: "Firefox page", url: "https://firefox.example/", folder: "Toolbar" }]);
  });

  it("discovers known local profiles and imports only a selected source", async () => {
    const home = await fixtureHome();
    const chrome = join(home, "Library/Application Support/Google/Chrome/Default");
    const arc = join(home, "Library/Application Support/Arc");
    await mkdir(chrome, { recursive: true });
    await mkdir(arc, { recursive: true });
    await writeFile(join(chrome, "Bookmarks"), JSON.stringify({ roots: {
      bookmark_bar: { type: "folder", children: [
        { type: "url", name: "Chrome docs", url: "https://chrome.example" },
      ] },
    } }));
    await writeFile(join(arc, "StorableSidebar.json"), JSON.stringify({ sidebar: {
      containers: [{ items: ["one", { id: "one", data: { tab: { savedURL: "https://arc.example" } } }] }],
    } }));

    const sources = await listBrowserImportSources(home, "darwin");
    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "chrome:Default", browser: "Chrome", pageCount: 1 }),
      expect.objectContaining({ id: "arc:sidebar", browser: "Arc", pageCount: 1 }),
    ]));
    expect((await importBrowserPages(home, "chrome:Default", "darwin")).pages).toEqual([
      { title: "Chrome docs", url: "https://chrome.example/", folder: "Bookmarks bar" },
    ]);
    expect((await importBrowserPages(home, "arc:sidebar", "darwin")).pages[0]?.url).toBe("https://arc.example/");
    await expect(importBrowserPages(home, "chrome:../../private", "darwin"))
      .rejects.toThrow("invalid browser source");
  });

  it("rejects symlinked source files", async () => {
    const home = await fixtureHome();
    const chrome = join(home, "Library/Application Support/Google/Chrome/Default");
    await mkdir(chrome, { recursive: true });
    const outside = join(home, "outside.json");
    await writeFile(outside, JSON.stringify({ roots: {} }));
    await symlink(outside, join(chrome, "Bookmarks"));
    expect(await listBrowserImportSources(home, "darwin")).toEqual([]);
    await expect(importBrowserPages(home, "chrome:Default", "darwin"))
      .rejects.toThrow("browser source unavailable");
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({ roots: {} });
  });

  it("rejects symlinked profile directories during discovery and import", async () => {
    const home = await fixtureHome();
    const chrome = join(home, "Library/Application Support/Google/Chrome");
    const outside = join(home, "outside-profile");
    await mkdir(chrome, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "Bookmarks"), JSON.stringify({ roots: {
      bookmark_bar: { type: "folder", children: [
        { type: "url", name: "Outside", url: "https://outside.example" },
      ] },
    } }));
    await symlink(outside, join(chrome, "Default"));
    expect(await listBrowserImportSources(home, "darwin")).toEqual([]);
    await expect(importBrowserPages(home, "chrome:Default", "darwin"))
      .rejects.toThrow("browser source unavailable");
  });

  it("bounds discovery time and concurrent source reads", async () => {
    let active = 0;
    let peak = 0;
    const starts: string[] = [];
    const result = await scanBrowserImportCandidates(
      ["one", "two", "three", "four", "five"],
      async (id, signal) => {
        starts.push(id);
        active += 1;
        peak = Math.max(peak, active);
        if (id === "one") {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        active -= 1;
        return { id, browser: "Test", profile: id, pageCount: 1 };
      },
      { timeoutMs: 20, concurrency: 2 },
    );
    expect(result).toEqual(expect.arrayContaining([
      { id: "two", browser: "Test", profile: "two", pageCount: 1 },
    ]));
    expect(result.some((source) => source.id === "one")).toBe(false);
    expect(peak).toBeLessThanOrEqual(2);
    expect(starts).toContain("three");
  });

  it("routes a selected profile from validated IPC to the local file reader", async () => {
    const home = await fixtureHome();
    const profile = join(home, "Library/Application Support/Google/Chrome/Default");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "Bookmarks"), JSON.stringify({ roots: {
      bookmark_bar: { type: "folder", children: [
        { type: "url", name: "End to end", url: "https://example.com/" },
      ] },
    } }));
    const listeners = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
    registerIpcHandlers({ handle(channel, listener) {
      listeners.set(channel, listener as (event: unknown, request: unknown) => Promise<unknown>);
    } }, {
      buildSource: null,
      downloadFile: async () => ({ status: "saved" }),
      cancelFileDownload: () => ({ ok: true }),
      listBrowserImportSources: () => listBrowserImportSources(home, "darwin"),
      importBrowserPages: (sourceId: string) => importBrowserPages(home, sourceId, "darwin"),
      listBrowserSecretSources: async () => [],
      previewBrowserSites: async () => [],
      importBrowserSites: async () => ({ passwords: 0, cookies: 0, skipped: 0 }),
      listOnePasswordItems: async () => [],
      importOnePasswordItems: async () => ({ imported: 0, skipped: 0 }),
      listBrowserPasswords: async () => [],
      fillBrowserPassword: async () => ({ filled: false }),
      deleteBrowserPassword: async () => ({ deleted: false }),
      exportBrowserPasswords: async () => ({ exported: false }),
    } as unknown as HandlerContext);
    const discovered = await listeners.get("browser:list-import-sources")!({}, {});
    expect(discovered).toEqual({ sources: [{
      id: "chrome:Default", browser: "Chrome", profile: "Default", pageCount: 1,
    }] });
    const imported = await listeners.get("browser:import-pages")!({}, { sourceId: "chrome:Default" });
    expect(imported).toEqual({ pages: [{
      title: "End to end", url: "https://example.com/", folder: "Bookmarks bar",
    }] });
  });
});
