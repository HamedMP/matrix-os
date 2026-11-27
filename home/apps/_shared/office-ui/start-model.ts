// Pure helpers behind the office start screen: which Matrix files to list,
// how to sort and filter them, the folder path, and friendly times.

/** The listing shape of `MatrixOS.files.list`, repeated so the kit needs no bridge types. */
export interface StartFileEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  modifiedAt: string;
}

export type StartSort = "name" | "modified";

/** Top-level folders the files bridge never lets an app read (the gateway's `isProtectedHomeSubpath`). */
const PROTECTED_ROOT_DIRS: ReadonlySet<string> = new Set(["system", "agents"]);

/**
 * Top-level folders that hold Matrix's own state, not the owner's work: every
 * folder the home template ships except `projects`, plus the gateway's
 * `temporary` scratch folder. The Files app lists the main ones as its fixed
 * system places. Hidden at the top of the home unless the owner asks; the ones
 * the files bridge can read stay reachable that way.
 */
export const SYSTEM_ROOT_DIRS: ReadonlySet<string> = new Set([
  "agents",
  "app-templates",
  "apps",
  "data",
  "modules",
  "plugins",
  "sessions",
  "system",
  "templates",
  "temporary",
  "themes",
  "tools",
]);

/** Where browsing starts when no folder is remembered. */
export const DEFAULT_START_DIR = "documents";
const MAX_DIR_LENGTH = 1024;

/** Most rows the browser draws at once; a search narrows the rest. */
export const MAX_BROWSER_ROWS = 200;
/** Longest search text kept. */
export const MAX_QUERY_LENGTH = 120;

/** Lower-case extension with its dot (".docx"), or "" when there is none. */
export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at).toLowerCase();
}

function isReadableSystemDir(dir: string, entry: StartFileEntry): boolean {
  return dir === "" && entry.kind === "dir" && SYSTEM_ROOT_DIRS.has(entry.name) && !PROTECTED_ROOT_DIRS.has(entry.name);
}

/**
 * Folders the app may open and files with an accepted extension. Hidden
 * entries, lock files ("~$report.docx") and protected top-level folders are
 * always left out; Matrix system folders at the top of the home are left out
 * unless `showSystem` is set.
 */
export function browsableEntries(dir: string, entries: readonly StartFileEntry[], accept: readonly string[], options: { showSystem?: boolean } = {}): StartFileEntry[] {
  const extensions = new Set(accept.filter((entry) => entry.startsWith(".")).map((entry) => entry.toLowerCase()));
  return entries.filter((entry) => {
    if (entry.name.startsWith(".") || entry.name === "") return false;
    if (entry.kind === "dir") {
      if (dir !== "") return true;
      if (PROTECTED_ROOT_DIRS.has(entry.name)) return false;
      return options.showSystem === true || !SYSTEM_ROOT_DIRS.has(entry.name);
    }
    if (entry.name.startsWith("~$")) return false;
    return extensions.size === 0 || extensions.has(extensionOf(entry.name));
  });
}

/** Longest file or folder name the files bridge accepts. */
const MAX_NAME_LENGTH = 255;

/** What a name typed in a folder too large to list could open. */
export interface TypedTarget {
  name: string;
  /** Files to try in order: the name itself when it has an accepted extension, else the name with each one. */
  files: string[];
  /** The folder to try when no file is there; null when the name has an accepted extension. */
  folder: string | null;
}

/**
 * Paths a typed name could mean in `dir`, so an owner can open an entry the
 * listing left out. Null unless the text is one plain name the browser would
 * show: no slashes, not hidden, not a lock file, not a protected top-level folder.
 */
export function typedTarget(dir: string, query: string, accept: readonly string[]): TypedTarget | null {
  const name = query.trim();
  if (name === "" || name.length > MAX_NAME_LENGTH || /[/\\\0]/.test(name)) return null;
  if (name.startsWith(".") || name.startsWith("~$")) return null;
  if (dir === "" && PROTECTED_ROOT_DIRS.has(name)) return null;
  const at = (child: string) => (dir === "" ? child : `${dir}/${child}`);
  const extensions = [...new Set(accept.filter((entry) => entry.startsWith(".")).map((entry) => entry.toLowerCase()))];
  if (extensions.length === 0) return { name, files: [at(name)], folder: at(name) };
  if (extensions.includes(extensionOf(name))) return { name, files: [at(name)], folder: null };
  return { name, files: extensions.map((extension) => at(`${name}${extension}`)), folder: at(name) };
}

/** How many system folders `browsableEntries` hides in this folder until the owner asks for them. */
export function hiddenSystemCount(dir: string, entries: readonly StartFileEntry[]): number {
  return entries.filter((entry) => isReadableSystemDir(dir, entry)).length;
}

/**
 * A remembered folder as a home-relative path ("" is the home), or null when
 * the value is not one: absolute, with empty, dot or `..` segments, hidden, or
 * inside a protected folder.
 */
export function normalizeStartDir(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_DIR_LENGTH) return null;
  const dir = value.endsWith("/") ? value.slice(0, -1) : value;
  if (dir === "") return value === "" ? "" : null;
  if (dir.includes("\\")) return null;
  const segments = dir.split("/");
  if (segments.some((segment) => segment === "" || segment.startsWith("."))) return null;
  return PROTECTED_ROOT_DIRS.has(segments[0] ?? "") ? null : dir;
}

/** Folders to try in order when the browser opens: the remembered one, `documents`, the home. */
export function startDirCandidates(remembered: string | null): string[] {
  const candidates = remembered === null ? [DEFAULT_START_DIR, ""] : remembered === "" ? [""] : [remembered, DEFAULT_START_DIR, ""];
  return [...new Set(candidates)];
}

/** Where an app keeps the folder its owner last browsed. */
export interface StartFolderMemory {
  /** The remembered folder, or null when there is none. Never rejects. */
  read(): Promise<string | null>;
  /** Never rejects. */
  write(dir: string): Promise<void>;
}

/** The part of the `MatrixOS` bridge the memory uses; Electron Desktop has neither member yet. */
export interface StartFolderBridge {
  readData?: (key: string) => Promise<unknown>;
  writeData?: (key: string, value: unknown) => Promise<void>;
}

export const START_FOLDER_KEY = "start_folder";

/**
 * Remembers the folder in the app's private key-value store, so each app
 * keeps its own. Undefined when the bridge has no store. The folder is a
 * convenience: a failed read or write is logged and ignored.
 */
export function createStartFolderMemory(
  bridge: StartFolderBridge | null | undefined,
  log: (message: string, error: unknown) => void = (message, error) => console.warn(message, error instanceof Error ? error.name : typeof error),
): StartFolderMemory | undefined {
  const readData = bridge?.readData?.bind(bridge);
  const writeData = bridge?.writeData?.bind(bridge);
  if (readData === undefined || writeData === undefined) return undefined;
  return {
    async read() {
      try {
        const stored = await readData(START_FOLDER_KEY);
        return typeof stored === "object" && stored !== null && "dir" in stored ? normalizeStartDir(stored.dir) : null;
      } catch (error: unknown) {
        log("the last used folder could not be read", error);
        return null;
      }
    },
    async write(dir) {
      const normal = normalizeStartDir(dir);
      if (normal === null) return;
      try {
        await writeData(START_FOLDER_KEY, { dir: normal });
      } catch (error: unknown) {
        log("the last used folder could not be remembered", error);
      }
    },
  };
}

function time(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then by name (natural order) or by last change, newest first. */
export function sortEntries(entries: readonly StartFileEntry[], sort: StartSort): StartFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    if (sort === "modified") {
      const diff = time(b.modifiedAt) - time(a.modifiedAt);
      if (diff !== 0) return diff;
    }
    return collator.compare(a.name, b.name);
  });
}

/** Entries whose name contains every word of the query, ignoring case. */
export function filterEntries(entries: readonly StartFileEntry[], query: string): StartFileEntry[] {
  const words = query.slice(0, MAX_QUERY_LENGTH).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const name = entry.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

export interface Crumb {
  label: string;
  path: string;
}

export function breadcrumbTrail(dir: string, rootLabel = "Home"): Crumb[] {
  const crumbs: Crumb[] = [{ label: rootLabel, path: "" }];
  if (dir === "") return crumbs;
  const segments = dir.split("/").filter(Boolean);
  segments.forEach((segment, index) => crumbs.push({ label: segment, path: segments.slice(0, index + 1).join("/") }));
  return crumbs;
}

export function parentDir(dir: string): string {
  const at = dir.lastIndexOf("/");
  return at < 0 ? "" : dir.slice(0, at);
}

/** The folder part of a home path, shown as "Documents / Legal", or the root label. */
export function folderLabel(path: string, rootLabel = "Home"): string {
  const dir = parentDir(path);
  return dir === "" ? rootLabel : dir.split("/").join(" / ");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Just now", "5 minutes ago", "Yesterday", "3 days ago", else a date. Empty for an unreadable time. */
export function relativeTime(iso: string, now: number = Date.now(), locale?: string): string {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return "";
  const elapsed = now - value;
  if (elapsed < MINUTE) return "Just now";
  const words = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  if (elapsed < HOUR) return capital(words.format(-Math.floor(elapsed / MINUTE), "minute"));
  if (elapsed < DAY) return capital(words.format(-Math.floor(elapsed / HOUR), "hour"));
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.ceil((startOfToday.getTime() - value) / DAY);
  if (days <= 6) return capital(words.format(-Math.max(1, days), "day"));
  const sameYear = new Date(value).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" }).format(value);
}

/** Full date and time, for a tooltip next to a relative time. */
export function exactTime(iso: string, locale?: string): string {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
}
