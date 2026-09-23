// Read-only import of saved pages from known local browser profiles. This
// module never takes a filesystem path from the renderer and never opens a
// source browser's credential stores.
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ImportedBrowserPage {
  title: string;
  url: string;
  folder: string;
}

export interface BrowserImportSource {
  id: string;
  browser: string;
  profile: string;
  pageCount: number;
}

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SQLITE_BYTES = 1024 * 1024 * 1024;
const MAX_PAGES = 10_000;
const MAX_PROFILES_PER_BROWSER = 32;
const PROFILE_NAME = /^(?:Default|Profile [1-9]\d{0,2})$/;
const FIREFOX_PROFILE_NAME = /^[A-Za-z0-9]{8,16}\.[A-Za-z0-9_-]{1,64}$/;

const CHROMIUM_BROWSERS = [
  { id: "chrome", name: "Chrome", directory: "Google/Chrome" },
  { id: "brave", name: "Brave", directory: "BraveSoftware/Brave-Browser" },
  { id: "edge", name: "Microsoft Edge", directory: "Microsoft Edge" },
  { id: "vivaldi", name: "Vivaldi", directory: "Vivaldi" },
  { id: "opera", name: "Opera", directory: "com.operasoftware.Opera" },
  { id: "chromium", name: "Chromium", directory: "Chromium" },
] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.slice(0, 256) || fallback;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function addPage(
  pages: ImportedBrowserPage[],
  seen: Set<string>,
  urlValue: unknown,
  titleValue: unknown,
  folder: string,
): void {
  if (pages.length >= MAX_PAGES) return;
  const url = safeUrl(urlValue);
  if (!url || seen.has(url)) return;
  seen.add(url);
  pages.push({ title: cleanText(titleValue, new URL(url).hostname), url, folder: folder.slice(0, 512) });
}

/** Chromium's Bookmarks JSON contains bookmark_bar, other, synced, and mobile roots. */
export function parseChromiumBookmarks(value: unknown): ImportedBrowserPage[] {
  const roots = object(object(value)?.roots);
  if (!roots) return [];
  const pages: ImportedBrowserPage[] = [];
  const seen = new Set<string>();
  const rootLabels: Record<string, string> = {
    bookmark_bar: "Bookmarks bar",
    other: "Other bookmarks",
    synced: "Synced bookmarks",
    mobile: "Mobile bookmarks",
  };

  function visit(value: unknown, folder: string, depth: number): void {
    if (depth > 32 || pages.length >= MAX_PAGES) return;
    const node = object(value);
    if (!node) return;
    if (node.type === "url") {
      addPage(pages, seen, node.url, node.name, folder);
      return;
    }
    if (node.type !== "folder" || !Array.isArray(node.children)) return;
    const children = node.children.slice(0, MAX_PAGES);
    for (const child of children) {
      if (pages.length >= MAX_PAGES) break;
      const childNode = object(child);
      const childFolder = childNode?.type === "folder"
        ? `${folder} / ${cleanText(childNode.name, "Folder")}`.slice(0, 512)
        : folder;
      visit(child, childFolder, depth + 1);
    }
  }

  for (const [key, label] of Object.entries(rootLabels)) visit(roots[key], label, 0);
  return pages;
}

/** Arc's local sidebar snapshot, excluding its older sync/archive records. */
export function parseArcSidebar(value: unknown): ImportedBrowserPage[] {
  const sidebar = object(object(value)?.sidebar);
  const containers = sidebar?.containers;
  if (!Array.isArray(containers)) return [];
  const pages: ImportedBrowserPage[] = [];
  const seen = new Set<string>();
  for (const candidate of containers.slice(0, 32)) {
    const items = object(candidate)?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items.slice(0, MAX_PAGES * 2)) {
      const tab = object(object(object(item)?.data)?.tab);
      if (tab) addPage(pages, seen, tab.savedURL, tab.savedTitle, "Arc tabs");
      if (pages.length >= MAX_PAGES) return pages;
    }
  }
  return pages;
}

export function parseSafariBookmarks(value: unknown): ImportedBrowserPage[] {
  const pages: ImportedBrowserPage[] = [];
  const seen = new Set<string>();
  function visit(value: unknown, folder: string, depth: number): void {
    if (depth > 32 || pages.length >= MAX_PAGES) return;
    const node = object(value);
    if (!node) return;
    if (node.WebBookmarkType === "WebBookmarkTypeLeaf") {
      addPage(pages, seen, node.URLString, object(node.URIDictionary)?.title, folder);
      return;
    }
    if (!Array.isArray(node.Children)) return;
    const title = cleanText(node.Title, "Bookmarks");
    const nextFolder = depth === 0 ? folder : folder ? `${folder} / ${title}` : title;
    for (const child of node.Children.slice(0, MAX_PAGES)) {
      visit(child, nextFolder.slice(0, 512), depth + 1);
      if (pages.length >= MAX_PAGES) break;
    }
  }
  visit(value, "", 0);
  return pages;
}

export function parseFirefoxBookmarks(value: unknown): ImportedBrowserPage[] {
  if (!Array.isArray(value)) return [];
  const pages: ImportedBrowserPage[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, MAX_PAGES)) {
    const row = object(candidate);
    if (!row) continue;
    addPage(pages, seen, row.url, row.title, cleanText(row.folder, "Firefox bookmarks"));
  }
  return pages;
}

async function readBoundedJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error("browser source unavailable");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_SOURCE_BYTES) throw new Error("browser source unavailable");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ highWaterMark: 64 * 1024 })) {
      bytes += chunk.length;
      if (bytes > MAX_SOURCE_BYTES) throw new Error("browser source unavailable");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

async function readBoundedSafariPlist(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error("browser source unavailable");
  const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
    timeout: 10_000,
    maxBuffer: MAX_SOURCE_BYTES,
  });
  return JSON.parse(stdout) as unknown;
}

async function readFirefoxBookmarks(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_SQLITE_BYTES) throw new Error("browser source unavailable");
  const query = `SELECT b.title AS title, p.url AS url,
    COALESCE(parent.title, 'Firefox bookmarks') AS folder
    FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk
    LEFT JOIN moz_bookmarks parent ON parent.id = b.parent
    WHERE b.type = 1 ORDER BY b.id LIMIT ${MAX_PAGES}`;
  const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-readonly", "-json", path, query], {
    timeout: 10_000,
    maxBuffer: MAX_SOURCE_BYTES,
  });
  return JSON.parse(stdout || "[]") as unknown;
}

function sourcePath(home: string, id: string, platform: NodeJS.Platform): {
  browser: string;
  profile: string;
  path: string;
  format: "arc" | "chromium" | "safari" | "firefox";
} {
  if (platform !== "darwin") throw new Error("browser source unavailable");
  const support = join(home, "Library", "Application Support");
  if (id === "arc:sidebar") return {
    browser: "Arc", profile: "Sidebar", format: "arc",
    path: join(support, "Arc", "StorableSidebar.json"),
  };
  if (id === "safari:bookmarks") return {
    browser: "Safari", profile: "Bookmarks", format: "safari",
    path: join(home, "Library", "Safari", "Bookmarks.plist"),
  };
  if (id.startsWith("firefox:")) {
    const profile = id.slice("firefox:".length);
    if (!FIREFOX_PROFILE_NAME.test(profile)) throw new Error("invalid browser source");
    return {
      browser: "Firefox", profile, format: "firefox",
      path: join(support, "Firefox", "Profiles", profile, "places.sqlite"),
    };
  }
  const [browserId, profile, extra] = id.split(":");
  const browser = CHROMIUM_BROWSERS.find((item) => item.id === browserId);
  if (!browser || !profile || extra || !PROFILE_NAME.test(profile) || (browser.id === "opera" && profile !== "Default")) {
    throw new Error("invalid browser source");
  }
  return {
    browser: browser.name,
    profile,
    format: "chromium",
    path: browser.id === "opera"
      ? join(support, browser.directory, "Bookmarks")
      : join(support, browser.directory, profile, "Bookmarks"),
  };
}

export async function importBrowserPages(
  home: string,
  sourceId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ pages: ImportedBrowserPage[] }> {
  const source = sourcePath(home, sourceId, platform);
  try {
    const data = source.format === "safari"
      ? await readBoundedSafariPlist(source.path)
      : source.format === "firefox"
        ? await readFirefoxBookmarks(source.path)
      : await readBoundedJson(source.path);
    const pages = source.format === "arc"
      ? parseArcSidebar(data)
      : source.format === "safari"
        ? parseSafariBookmarks(data)
        : source.format === "firefox"
          ? parseFirefoxBookmarks(data)
        : parseChromiumBookmarks(data);
    return { pages };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "browser source unavailable") throw error;
    throw new Error("browser source unavailable");
  }
}

export async function listBrowserImportSources(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Promise<BrowserImportSource[]> {
  if (platform !== "darwin") return [];
  const support = join(home, "Library", "Application Support");
  const ids = ["arc:sidebar", "safari:bookmarks", "opera:Default"];
  for (const browser of CHROMIUM_BROWSERS) {
    if (browser.id === "opera") continue;
    let profiles: string[];
    try {
      profiles = await readdir(join(support, browser.directory));
    } catch (error: unknown) {
      if (!(error instanceof Error)) console.warn("[browser-import] profile scan failed with an unknown error");
      continue;
    }
    for (const profile of profiles.filter((name) => PROFILE_NAME.test(name)).slice(0, MAX_PROFILES_PER_BROWSER)) {
      ids.push(`${browser.id}:${profile}`);
    }
  }
  try {
    const profiles = await readdir(join(support, "Firefox", "Profiles"));
    for (const profile of profiles.filter((name) => FIREFOX_PROFILE_NAME.test(name)).slice(0, MAX_PROFILES_PER_BROWSER)) {
      ids.push(`firefox:${profile}`);
    }
  } catch (error: unknown) {
    if (!(error instanceof Error)) console.warn("[browser-import] Firefox profile scan failed with an unknown error");
  }
  const sources: BrowserImportSource[] = [];
  for (const id of ids) {
    try {
      const source = sourcePath(home, id, platform);
      const { pages } = await importBrowserPages(home, id, platform);
      if (pages.length > 0) sources.push({ id, browser: source.browser, profile: source.profile, pageCount: pages.length });
    } catch (error: unknown) {
      if (!(error instanceof Error)) console.warn("[browser-import] source scan failed with an unknown error");
    }
  }
  return sources;
}
