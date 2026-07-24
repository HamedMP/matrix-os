// Entry model for the computer file browser. The gateway `/api/files/list`
// route returns more than name/type (size, modified, children); the shared
// file-tree store intentionally drops those fields, so the browser parses its
// own richer shape here instead of widening the store used by project panels.

export interface BrowserEntry {
  name: string;
  type: "file" | "directory";
  sizeBytes?: number;
  modifiedAt?: string;
  children?: number;
}

export type BrowserSortKey = "name" | "size" | "modified";
export type BrowserSortDirection = "asc" | "desc";

// Directory listings are rendered in full (no pagination), so cap what a
// hostile or runaway listing can buffer into renderer memory.
export const MAX_BROWSER_ENTRIES = 1000;

export function parseBrowserEntries(value: unknown): BrowserEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: BrowserEntry[] = [];
  for (const raw of value) {
    if (entries.length >= MAX_BROWSER_ENTRIES) break;
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof (raw as BrowserEntry).name !== "string" ||
      ((raw as BrowserEntry).type !== "file" && (raw as BrowserEntry).type !== "directory")
    ) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const entry: BrowserEntry = { name: record.name as string, type: record.type as BrowserEntry["type"] };
    if (typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0) {
      entry.sizeBytes = record.size;
    }
    if (typeof record.modified === "string" && record.modified.length > 0) {
      entry.modifiedAt = record.modified;
    }
    if (typeof record.children === "number" && Number.isFinite(record.children) && record.children >= 0) {
      entry.children = record.children;
    }
    entries.push(entry);
  }
  return sortBrowserEntries(entries, "name", "asc");
}

// Finder-style ordering: directories always group first, the active key sorts
// within each group, and names break ties so ordering is stable.
export function sortBrowserEntries(
  entries: readonly BrowserEntry[],
  key: BrowserSortKey,
  direction: BrowserSortDirection,
): BrowserEntry[] {
  const sign = direction === "asc" ? 1 : -1;
  const compare = (a: BrowserEntry, b: BrowserEntry): number => {
    let primary = 0;
    if (key === "size") {
      primary = (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1);
    } else if (key === "modified") {
      primary = (a.modifiedAt ?? "").localeCompare(b.modifiedAt ?? "");
    } else {
      primary = a.name.localeCompare(b.name);
    }
    if (primary !== 0) return primary * sign;
    return a.name.localeCompare(b.name);
  };
  const directories = entries.filter((entry) => entry.type === "directory").sort(compare);
  const files = entries.filter((entry) => entry.type === "file").sort(compare);
  return [...directories, ...files];
}
