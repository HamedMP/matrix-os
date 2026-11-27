/**
 * Tab order and tab colours.
 *
 * The document engine has no operation to move a sheet or to set its tab
 * colour, so both are kept by this app, per file, in its private key-value
 * store (`readData`/`writeData`), keyed by the stable sheet ids. The file
 * keeps its own sheet order. An unsaved workbook keeps them in memory only.
 */
import type { SheetId, SheetInfo } from "../session/engine";

export const TAB_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "gray"] as const;
export type TabColor = (typeof TAB_COLORS)[number];

export const TAB_COLOR_LABELS: Record<TabColor, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  gray: "Gray",
};

export interface TabLook {
  /** Sheet ids in the order the owner arranged them. Unknown ids are ignored. */
  order: SheetId[];
  colors: Record<SheetId, TabColor>;
}

export const EMPTY_LOOK: TabLook = { order: [], colors: {} };

export function isTabColor(value: unknown): value is TabColor {
  return typeof value === "string" && (TAB_COLORS as readonly string[]).includes(value);
}

/** Visible sheets in tab order: the owner's order first, then the rest in file order. */
export function orderedSheets(sheets: readonly SheetInfo[], look: TabLook): SheetInfo[] {
  const visible = sheets.filter((sheet) => sheet.state === "visible");
  const rank = new Map(look.order.map((id, index) => [id, index]));
  return [...visible].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.index - b.index;
  });
}

/** Moves a sheet to `toIndex` among the visible tabs. */
export function moveTab(look: TabLook, sheets: readonly SheetInfo[], id: SheetId, toIndex: number): TabLook {
  const ids = orderedSheets(sheets, look).map((sheet) => sheet.id);
  const from = ids.indexOf(id);
  if (from < 0) return look;
  const target = Math.max(0, Math.min(ids.length - 1, toIndex));
  if (target === from) return look;
  ids.splice(from, 1);
  ids.splice(target, 0, id);
  return { ...look, order: ids };
}

export function setTabColor(look: TabLook, id: SheetId, color: TabColor | null): TabLook {
  const colors = { ...look.colors };
  if (color === null) delete colors[id];
  else colors[id] = color;
  return { ...look, colors };
}

/** Drops ids of sheets that no longer exist. */
export function pruneLook(look: TabLook, sheets: readonly SheetInfo[]): TabLook {
  const ids = new Set(sheets.map((sheet) => sheet.id));
  const order = look.order.filter((id) => ids.has(id));
  const colors: Record<SheetId, TabColor> = {};
  for (const [id, color] of Object.entries(look.colors)) if (ids.has(id)) colors[id] = color;
  return { order, colors };
}

// ---------------------------------------------------------------- persistence

/**
 * Each file's choices are stored under a key of their own, so two windows
 * arranging tabs of different workbooks never rewrite each other's. The key
 * is a hash of the path (the store takes only letters, digits, `_` and `-`);
 * the stored value names its path, so a hash shared by two paths reads as
 * nothing rather than as the other file's tabs.
 */
export const TAB_LOOK_KEY_PREFIX = "sheet_tabs_v2_";
/** The earlier store: one list of every file's choices. Read for files not yet stored on their own. */
export const LEGACY_TAB_LOOK_KEY = "sheet_tabs_v1";
/** Files read from the earlier list. */
export const MAX_REMEMBERED_FILES = 50;
const MAX_SHEETS_PER_FILE = 256;
const MAX_SHEET_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 1024;

interface StoredEntry {
  path: string;
  order: SheetId[];
  colors: Record<SheetId, TabColor>;
}

interface KeyValue {
  readData?: (key: string) => Promise<unknown>;
  writeData?: (key: string, value: unknown) => Promise<void>;
}

/** Two 32-bit FNV-1a hashes with different seeds, as 16 hex digits. */
function hashPath(path: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x01000193) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** The key one file's choices are stored under. */
export function tabLookKey(path: string): string {
  return `${TAB_LOOK_KEY_PREFIX}${hashPath(path)}`;
}

function readEntry(item: unknown): StoredEntry | null {
  if (typeof item !== "object" || item === null) return null;
  const entry = item as Record<string, unknown>;
  if (typeof entry.path !== "string" || entry.path.length > MAX_PATH_LENGTH) return null;
  const isId = (id: unknown): id is string => typeof id === "string" && id.length <= MAX_SHEET_ID_LENGTH;
  const order = Array.isArray(entry.order) ? entry.order.slice(0, MAX_SHEETS_PER_FILE).filter(isId) : [];
  const colors: Record<SheetId, TabColor> = {};
  if (typeof entry.colors === "object" && entry.colors !== null) {
    for (const [id, color] of Object.entries(entry.colors as Record<string, unknown>).slice(0, MAX_SHEETS_PER_FILE)) if (isId(id) && isTabColor(color)) colors[id] = color;
  }
  return { path: entry.path, order, colors };
}

function readLegacy(value: unknown, path: string): StoredEntry | null {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { files?: unknown }).files)) return null;
  for (const item of (value as { files: unknown[] }).files.slice(0, MAX_REMEMBERED_FILES)) {
    const entry = readEntry(item);
    if (entry !== null && entry.path === path) return entry;
  }
  return null;
}

export class TabLookStore {
  constructor(
    private readonly kv: KeyValue,
    private readonly log: (message: string, error: unknown) => void = () => undefined,
  ) {}

  async load(path: string): Promise<TabLook> {
    if (typeof this.kv.readData !== "function" || path.length > MAX_PATH_LENGTH) return EMPTY_LOOK;
    try {
      const own = await this.kv.readData(tabLookKey(path));
      // A stored value, even an empty one, is this file's latest choice; only a file never stored on its own falls back to the earlier list.
      const entry = own === null || own === undefined ? readLegacy(await this.kv.readData(LEGACY_TAB_LOOK_KEY), path) : readEntry(own);
      return entry === null || entry.path !== path ? EMPTY_LOOK : { order: entry.order, colors: entry.colors };
    } catch (error: unknown) {
      this.log("tab order could not be read", error);
      return EMPTY_LOOK;
    }
  }

  async save(path: string, look: TabLook): Promise<void> {
    if (typeof this.kv.writeData !== "function" || path.length > MAX_PATH_LENGTH) return;
    const entry = readEntry({ path, order: look.order, colors: look.colors });
    if (entry === null) return;
    try {
      await this.kv.writeData(tabLookKey(path), entry);
    } catch (error: unknown) {
      this.log("tab order could not be saved", error);
    }
  }
}
