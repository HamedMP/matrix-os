import { join } from "node:path";
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

// Directories to skip entirely - prevents chokidar from readdir-ing into
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

const WATCHED_HOME_DIRECTORIES = [
  "agents",
  "apps",
  "data",
  "modules",
  "plugins",
  "sessions",
  "system",
  "templates",
  "themes",
  "tools",
];

const WATCHED_HOME_FILES = [
  ".matrix-version",
  ".syncignore",
  ".template-manifest.json",
  "CLAUDE.md",
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

    const name = segments.at(-1) ?? "";
    if (name.startsWith("matrix.db")) return true;

    return false;
  };
}

export function createWatcherPaths(homePath: string): string[] {
  return [
    ...WATCHED_HOME_DIRECTORIES.map((entry) => join(homePath, entry)),
    ...WATCHED_HOME_FILES.map((entry) => join(homePath, entry)),
  ];
}

export function createWatcher(homePath: string): Watcher {
  const listeners: Array<(event: FileChangeEvent) => void> = [];

  // Watch Matrix-owned home roots explicitly. Watching the whole home and
  // relying on ignores still lets chokidar traverse large user/project trees
  // during startup on customer VPSes.
  const fsWatcher: FSWatcher = watch(createWatcherPaths(homePath), {
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
