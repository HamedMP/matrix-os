import { watch, type FSWatcher } from "chokidar";

export type FileEvent = "add" | "change" | "unlink";

export interface FileChangeEvent {
  type: "file:change";
  path: string;
  event: FileEvent;
}

export interface Watcher {
  on(listener: (event: FileChangeEvent) => void): void;
  close(): Promise<void>;
}

export interface WatcherIgnoredOptions {
  watchProjects?: boolean;
}

// Directories to skip entirely — prevents chokidar from readdir-ing into
// large trees (node_modules, .git, etc.) which starves the event loop
// during the initial poll scan even when ignoreInitial is true.
//
// Glob patterns like `**/node_modules/**` only match paths *inside* the
// directory, not the directory entry itself, so chokidar still recurses
// into it before filtering contents. A function check on path segments
// catches the directory before readdir runs.
const ALWAYS_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".trash",
  "dist",
  "build",
  ".claude",
  ".codex",
  ".hermes",
  ".local",
  ".npm",
]);

const PROJECT_IGNORED_DIRS = new Set([
  "projects",
  "matrix-os",
]);

export function createWatcherIgnored(
  options: WatcherIgnoredOptions = {},
): (path: string) => boolean {
  return (filePath: string) => {
    const segments = filePath.split("/");
    for (const seg of segments) {
      if (ALWAYS_IGNORED_DIRS.has(seg)) return true;
      if (!options.watchProjects && PROJECT_IGNORED_DIRS.has(seg)) return true;
    }
    if (segments.some(s => s.startsWith("matrix.db"))) return true;
    return false;
  };
}

export function createWatcher(homePath: string): Watcher {
  const listeners: Array<(event: FileChangeEvent) => void> = [];

  // chokidar v4 uses fs.watch which on macOS (kqueue) opens one FD per
  // path and hits EMFILE on large trees. On Linux, inotify avoids
  // per-file FDs but still walks every directory to set up watches —
  // with a large MATRIX_HOME containing projects/node_modules this
  // exhausts memory. Polling is bounded and predictable on both.
  const fsWatcher: FSWatcher = watch(homePath, {
    ignoreInitial: true,
    usePolling: true,
    interval: 2000,
    binaryInterval: 5000,
    ignored: createWatcherIgnored({
      watchProjects: process.env.MATRIX_WATCH_PROJECTS === "true",
    }),
  });

  const emit = (event: FileEvent, path: string) => {
    const relative = path.startsWith(homePath)
      ? path.slice(homePath.length + 1)
      : path;
    const change: FileChangeEvent = { type: "file:change", path: relative, event };
    for (const listener of listeners) {
      listener(change);
    }
  };

  fsWatcher.on("add", (path) => emit("add", path));
  fsWatcher.on("change", (path) => emit("change", path));
  fsWatcher.on("unlink", (path) => emit("unlink", path));

  return {
    on(listener) {
      listeners.push(listener);
    },
    async close() {
      await fsWatcher.close();
    },
  };
}
