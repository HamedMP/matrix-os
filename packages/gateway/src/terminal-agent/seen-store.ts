import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "../shell/atomic-write.js";

/** A terminal ref key, `workspaceId:tabId`, exactly as the events stream names tabs. */
const REF_KEY = /^tws_[0-9a-f]{32}:tt_[0-9a-f]{32}$/;
const DEFAULT_MAX_ENTRIES = 2_048;
const DEFAULT_SAVE_DELAY_MS = 1_000;
const MAX_FILE_BYTES = 512 * 1024;
const FileSchema = z.object({ version: z.literal(1), tabs: z.record(z.string(), z.unknown()) });
const EntrySchema = z.object({ at: z.string().max(64), finished: z.boolean() });

/** One opening: when, and whether the tab's program had already ended then. */
export interface TerminalSeenEntry {
  at: number;
  finished: boolean;
}

/**
 * When the person last opened each terminal tab (spec 2706 layer 4), shared by
 * every window and device through the events stream and kept in the owner's
 * home so a gateway restart does not bring back every finished tab as "Done".
 */
export interface TerminalSeenStore {
  /** The tab's last opening, if ever. */
  get(key: string): TerminalSeenEntry | undefined;
  /**
   * Records an opening; an earlier one never replaces a later one. `finished`
   * says the program had ended: an ended tab's metadata (its name, its saved
   * view) can still change, so its own timestamps cannot say "seen since".
   */
  mark(key: string, at: number, finished: boolean): void;
  /** Forgets tabs that are no longer listed. */
  retain(keys: ReadonlySet<string>): void;
  size(): number;
  load(): Promise<void>;
  /** Writes pending changes now and stops the save timer. */
  close(): Promise<void>;
}

export function createTerminalSeenStore(options: {
  /** The owner file, or null to keep seen in memory only. */
  path: string | null;
  maxEntries?: number;
  saveDelayMs?: number;
}): TerminalSeenStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
  // Insertion order is recency of the last mark: the oldest drops out past the cap.
  const seen = new Map<string, TerminalSeenEntry>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let saving: Promise<void> = Promise.resolve();
  let closed = false;

  const put = (key: string, entry: TerminalSeenEntry) => {
    const before = seen.get(key);
    if (before !== undefined && before.at >= entry.at) return false;
    seen.delete(key);
    seen.set(key, entry);
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    return true;
  };

  const save = (): Promise<void> => {
    if (!options.path || !dirty) return saving;
    dirty = false;
    const path = options.path;
    const tabs = Object.fromEntries([...seen].map(([key, entry]) => [key, { at: new Date(entry.at).toISOString(), finished: entry.finished }]));
    saving = saving.then(() => writeUtf8FileAtomic(path, `${JSON.stringify({ version: 1, tabs })}\n`))
      .catch((error: unknown) => {
        // Seen is advisory: a failed write only means "Done" may come back after a restart.
        console.warn("[gateway] terminal seen save failed", error instanceof Error ? error.name : "unknown_error");
      });
    return saving;
  };

  const schedule = () => {
    dirty = true;
    if (!options.path || closed || timer) return;
    timer = setTimeout(() => { timer = null; void save(); }, saveDelayMs);
    timer.unref?.();
  };

  return {
    get: (key) => seen.get(key),
    mark(key, at, finished) {
      if (!REF_KEY.test(key) || !Number.isFinite(at)) return;
      if (put(key, { at, finished })) schedule();
    },
    retain(keys) {
      let changed = false;
      for (const key of [...seen.keys()]) {
        if (!keys.has(key)) { seen.delete(key); changed = true; }
      }
      if (changed) schedule();
    },
    size: () => seen.size,
    async load() {
      if (!options.path) return;
      let raw: string;
      try {
        raw = await readFile(options.path, "utf8");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
        console.warn("[gateway] terminal seen unreadable", error instanceof Error ? error.name : "unknown_error");
        return;
      }
      if (raw.length > MAX_FILE_BYTES) {
        console.warn("[gateway] terminal seen file too large; starting empty");
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        console.warn("[gateway] terminal seen file is not JSON; starting empty");
        return;
      }
      const file = FileSchema.safeParse(parsed);
      if (!file.success) {
        console.warn("[gateway] terminal seen file has an unknown shape; starting empty");
        return;
      }
      // Marks made while loading are newer than the file unless the file says otherwise.
      for (const [key, value] of Object.entries(file.data.tabs).slice(0, maxEntries)) {
        const entry = EntrySchema.safeParse(value);
        const at = entry.success ? Date.parse(entry.data.at) : Number.NaN;
        if (REF_KEY.test(key) && entry.success && Number.isFinite(at)) put(key, { at, finished: entry.data.finished });
      }
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await save();
    },
  };
}
