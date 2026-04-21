import { watch, type FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { hashFile } from "../lib/hash.js";
import { isIgnored, type SyncIgnorePatterns } from "../lib/syncignore.js";

export type WatcherEvent =
  | { type: "change"; path: string; hash: string; size: number; mtime: number }
  | { type: "unlink"; path: string };

export interface WatcherOptions {
  syncRoot: string;
  ignorePatterns: SyncIgnorePatterns;
  onEvent: (event: WatcherEvent) => void;
  debounceMs?: number;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;
  private readonly maxTimers = 10_000;

  constructor(private readonly options: WatcherOptions) {
    this.debounceMs = options.debounceMs ?? 300;
  }

  start(): void {
    // ignoreInitial: false so chokidar fires `add` for files that already
    // exist when watching starts. Otherwise a fresh daemon never uploads
    // the contents of a pre-existing sync folder -- the user has to touch
    // every file manually for the watcher to notice it.
    this.watcher = watch(this.options.syncRoot, {
      persistent: true,
      ignoreInitial: false,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (absPath) => this.handleFileEvent(absPath));
    this.watcher.on("change", (absPath) => this.handleFileEvent(absPath));
    this.watcher.on("unlink", (absPath) => this.handleUnlink(absPath));
  }

  async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private handleFileEvent(absPath: string): void {
    const relPath = relative(this.options.syncRoot, absPath);

    if (isIgnored(relPath, this.options.ignorePatterns)) return;

    if (this.debounceTimers.has(relPath)) {
      clearTimeout(this.debounceTimers.get(relPath)!);
    }

    if (this.debounceTimers.size >= this.maxTimers) {
      const oldest = this.debounceTimers.keys().next().value;
      if (oldest !== undefined) {
        clearTimeout(this.debounceTimers.get(oldest)!);
        this.debounceTimers.delete(oldest);
      }
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(relPath);
      try {
        const [hash, fileStat] = await Promise.all([
          hashFile(absPath),
          stat(absPath),
        ]);
        this.options.onEvent({
          type: "change",
          path: relPath,
          hash,
          size: fileStat.size,
          mtime: fileStat.mtimeMs,
        });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return;
        }
        throw err;
      }
    }, this.debounceMs);

    this.debounceTimers.set(relPath, timer);
  }

  private handleUnlink(absPath: string): void {
    const relPath = relative(this.options.syncRoot, absPath);

    if (isIgnored(relPath, this.options.ignorePatterns)) return;

    if (this.debounceTimers.has(relPath)) {
      clearTimeout(this.debounceTimers.get(relPath)!);
      this.debounceTimers.delete(relPath);
    }

    this.options.onEvent({ type: "unlink", path: relPath });
  }
}
