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

/** Top-level folders the files bridge never lets an app read. */
const PROTECTED_ROOT_DIRS: ReadonlySet<string> = new Set(["system", "agents"]);

/** Most rows the browser draws at once; a search narrows the rest. */
export const MAX_BROWSER_ROWS = 200;
/** Longest search text kept. */
export const MAX_QUERY_LENGTH = 120;

/** Lower-case extension with its dot (".docx"), or "" when there is none. */
export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at).toLowerCase();
}

/**
 * Folders the app may open and files with an accepted extension. Hidden
 * entries, lock files ("~$report.docx") and protected top-level folders are
 * left out.
 */
export function browsableEntries(dir: string, entries: readonly StartFileEntry[], accept: readonly string[]): StartFileEntry[] {
  const extensions = new Set(accept.filter((entry) => entry.startsWith(".")).map((entry) => entry.toLowerCase()));
  return entries.filter((entry) => {
    if (entry.name.startsWith(".") || entry.name === "") return false;
    if (entry.kind === "dir") return !(dir === "" && PROTECTED_ROOT_DIRS.has(entry.name));
    if (entry.name.startsWith("~$")) return false;
    return extensions.size === 0 || extensions.has(extensionOf(entry.name));
  });
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
