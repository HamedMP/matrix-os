import { join, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";
import { FileManagementDirectoryPathSchema } from "./file-management/contracts.js";
import { resolveWithinHome } from "./path-security.js";

export type FileEvent = "add" | "change" | "unlink";

export interface FileChangeEvent {
  type: "file:change";
  path: string;
  event: FileEvent;
}

export interface WatcherBackend {
  on(event: string, listener: (path: string) => void): WatcherBackend;
  add(paths: string | string[]): WatcherBackend;
  unwatch(paths: string | string[]): WatcherBackend | Promise<WatcherBackend>;
  close(): Promise<void>;
}

export type WatcherFactory = (
  paths: string | string[],
  options: ChokidarOptions,
) => WatcherBackend;

export interface Watcher {
  on(listener: (event: FileChangeEvent) => void): void;
  acquireDirectoryScope(directory: string): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface WatcherIgnoredOptions {
  watchProjects?: boolean;
}

export interface CreateWatcherOptions {
  watchFactory?: WatcherFactory;
}

interface ScopedReferenceState {
  count: number;
  removePromise: Promise<void> | null;
}

const MAX_SCOPED_DIRECTORIES = 1_024;
const ALWAYS_IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", ".cache", ".trash", "dist",
  "build", ".claude", ".codex", ".hermes", ".local", ".npm",
]);
const PROJECT_IGNORED_DIRS = new Set(["projects", "matrix-os"]);
const WATCHED_HOME_DIRECTORIES = [
  "agents", "apps", "data", "modules", "plugins", "sessions", "system",
  "templates", "themes", "tools",
];
const WATCHED_HOME_FILES = [
  ".matrix-version", ".syncignore", ".template-manifest.json", "CLAUDE.md",
];

export function createWatcherIgnored(
  options: WatcherIgnoredOptions = {},
): (path: string) => boolean {
  return (filePath: string) => {
    const segments = filePath.split("/");
    for (const segment of segments) {
      if (ALWAYS_IGNORED_DIRS.has(segment)) return true;
      if (!options.watchProjects && PROJECT_IGNORED_DIRS.has(segment)) return true;
    }
    return (segments.at(-1) ?? "").startsWith("matrix.db");
  };
}

export function createWatcherPaths(homePath: string): string[] {
  return [
    ...WATCHED_HOME_DIRECTORIES.map((entry) => join(homePath, entry)),
    ...WATCHED_HOME_FILES.map((entry) => join(homePath, entry)),
  ];
}

function isCoveredByGlobalWatcher(directory: string): boolean {
  if (directory === "") return false;
  const firstSegment = directory.split("/")[0];
  return firstSegment !== undefined && WATCHED_HOME_DIRECTORIES.includes(firstSegment);
}

export function createWatcher(homePath: string, options: CreateWatcherOptions = {}): Watcher {
  const basePath = resolve(homePath);
  const watchFactory: WatcherFactory = options.watchFactory
    ?? ((paths, watchOptions) => watch(paths, watchOptions) as FSWatcher);
  const listeners: Array<(event: FileChangeEvent) => void> = [];
  const scopedReferences = new Map<string, ScopedReferenceState>();
  let scopedWatcher: WatcherBackend | null = null;
  let closed = false;

  const globalWatcher = watchFactory(createWatcherPaths(basePath), {
    ignoreInitial: true,
    usePolling: true,
    interval: 2_000,
    binaryInterval: 5_000,
    ignored: createWatcherIgnored(),
  });

  const emit = (event: FileEvent, absolutePath: string) => {
    const homeRelative = relative(basePath, resolve(absolutePath));
    if (homeRelative === "" || homeRelative.startsWith("..") || homeRelative.startsWith(sep)) return;
    const change: FileChangeEvent = {
      type: "file:change",
      path: homeRelative.split(sep).join("/"),
      event,
    };
    for (const listener of listeners) listener(change);
  };

  const bindEvents = (backend: WatcherBackend) => {
    backend.on("add", (path) => emit("add", path));
    backend.on("change", (path) => emit("change", path));
    backend.on("unlink", (path) => emit("unlink", path));
    backend.on("addDir", (path) => emit("add", path));
    backend.on("unlinkDir", (path) => emit("unlink", path));
  };
  bindEvents(globalWatcher);

  return {
    on(listener) {
      if (closed) throw new Error("Watcher is closed");
      listeners.push(listener);
    },

    async acquireDirectoryScope(directory) {
      if (closed) throw new Error("Watcher is closed");
      const parsed = FileManagementDirectoryPathSchema.safeParse(directory);
      if (!parsed.success) throw new Error("Invalid directory scope");
      const absolutePath = resolveWithinHome(basePath, parsed.data);
      if (!absolutePath) throw new Error("Invalid directory scope");
      try {
        const scopeStats = await lstat(absolutePath);
        if (scopeStats.isSymbolicLink() || !scopeStats.isDirectory()) {
          throw new Error("Scope is not a concrete directory");
        }
        const [baseRealPath, scopeRealPath] = await Promise.all([
          realpath(basePath),
          realpath(absolutePath),
        ]);
        const scopeRelative = relative(baseRealPath, scopeRealPath);
        if (scopeRelative.startsWith("..") || scopeRelative.startsWith(sep)) {
          throw new Error("Scope resolves outside owner home");
        }
      } catch (error: unknown) {
        console.error("[watcher] Directory scope validation failed", {
          directory: parsed.data,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error("Invalid directory scope");
      }

      if (isCoveredByGlobalWatcher(parsed.data)) {
        let released = false;
        return async () => { released = true; void released; };
      }

      let scopeState = scopedReferences.get(absolutePath);
      if (scopeState?.removePromise) {
        await scopeState.removePromise;
        if (closed) throw new Error("Watcher is closed");
        scopeState = scopedReferences.get(absolutePath);
      }
      if (!scopeState) {
        if (scopedReferences.size >= MAX_SCOPED_DIRECTORIES) {
          throw new Error("Scoped watcher limit reached");
        }
        if (!scopedWatcher) {
          scopedWatcher = watchFactory(absolutePath, {
            depth: 0,
            ignoreInitial: true,
            followSymlinks: false,
            usePolling: true,
            interval: 2_000,
            binaryInterval: 5_000,
            ignored: createWatcherIgnored({ watchProjects: true }),
          });
          bindEvents(scopedWatcher);
        } else {
          scopedWatcher.add(absolutePath);
        }
        scopeState = { count: 0, removePromise: null };
        scopedReferences.set(absolutePath, scopeState);
      }
      scopeState.count += 1;

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if (scopedReferences.get(absolutePath) !== scopeState) return;
        scopeState.count -= 1;
        if (scopeState.count > 0) {
          return;
        }
        if (!scopedWatcher || closed) {
          scopedReferences.delete(absolutePath);
          return;
        }
        const backend = scopedWatcher;
        const removePromise = (async () => {
          try {
            await backend.unwatch(absolutePath);
          } finally {
            if (scopedReferences.get(absolutePath) === scopeState) {
              scopedReferences.delete(absolutePath);
            }
            scopeState.removePromise = null;
          }
        })();
        scopeState.removePromise = removePromise;
        await removePromise;
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      const pendingUnwatches = [...scopedReferences.values()]
        .flatMap((state) => state.removePromise ? [state.removePromise] : []);
      await Promise.allSettled(pendingUnwatches);
      scopedReferences.clear();
      const scopedClose = scopedWatcher?.close();
      scopedWatcher = null;
      await scopedClose;
      await globalWatcher.close();
      listeners.length = 0;
    },
  };
}
